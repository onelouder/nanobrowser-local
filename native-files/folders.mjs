import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function parseUserDirs(text, home) {
  const found = {};
  for (const [id, key] of [
    ['downloads', 'DOWNLOAD'],
    ['documents', 'DOCUMENTS'],
  ]) {
    const match = text.match(new RegExp(`^XDG_${key}_DIR="((?:\\\\.|[^"\\\\])*)"`, 'm'));
    if (!match) continue;
    const value = match[1].replace(/\\([\\"$`])/g, '$1').replace(/^\$HOME(?=\/|$)/, home);
    if (path.isAbsolute(value) && value !== home) found[id] = value;
  }
  return found;
}

const WINDOWS_FOLDERS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders')
if ($null -eq $key) { Write-Output '{}'; exit }
try {
  @{
    downloads = $key.GetValue('{374DE290-123F-4565-9164-39C4925E467B}')
    documents = $key.GetValue('Personal')
  } | ConvertTo-Json -Compress
} finally { $key.Dispose() }
`;

export function parseWindowsFolders(text, home) {
  const values = JSON.parse(text);
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const found = {};
  for (const id of ['downloads', 'documents']) {
    const value = values[id];
    if (typeof value !== 'string' || !path.win32.isAbsolute(value)) continue;
    if (path.win32.resolve(value).toLowerCase() === path.win32.resolve(home).toLowerCase()) continue;
    found[id] = value;
  }
  return found;
}

function windowsFolders(home) {
  const command = Buffer.from(WINDOWS_FOLDERS, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 65536,
  });
  if (result.error || result.status !== 0) return {};
  return parseWindowsFolders(result.stdout, home);
}

export async function folderRoots() {
  const home = homedir();
  const roots = { downloads: path.join(home, 'Downloads'), documents: path.join(home, 'Documents') };
  if (process.platform === 'win32') {
    Object.assign(roots, windowsFolders(home));
  }
  if (process.platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    const text = await readFile(path.join(config, 'user-dirs.dirs'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    Object.assign(roots, parseUserDirs(text, home));
  }
  return roots;
}
