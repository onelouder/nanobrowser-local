import { copyFile, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { folderRoots } from './folders.mjs';

export const HOST_NAME = 'com.nanobrowser.local_files';
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;

export function installDirectory(platform, home, env) {
  if (platform === 'win32')
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Nanobrowser', 'NativeFiles');
  if (platform === 'darwin')
    return path.posix.join(home, 'Library', 'Application Support', 'Nanobrowser', 'NativeFiles');
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'nanobrowser', 'native-files');
}

export function manifestLocations(platform, home, env) {
  if (platform === 'win32')
    return ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge'].map(
      browser => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`,
    );
  const base =
    platform === 'darwin'
      ? path.posix.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || path.posix.join(home, '.config');
  const browsers =
    platform === 'darwin'
      ? ['Google/Chrome', 'Google/ChromeForTesting', 'Chromium', 'Microsoft Edge']
      : ['google-chrome', 'google-chrome-for-testing', 'chromium', 'microsoft-edge'];
  return browsers.map(browser => path.posix.join(base, browser, 'NativeMessagingHosts', `${HOST_NAME}.json`));
}

export function hostManifest(extensionId, launcher, previous = []) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Extension ID must contain 32 letters from a through p.');
  if (!Array.isArray(previous) || previous.some(origin => typeof origin !== 'string' || !ORIGIN.test(origin))) {
    throw new Error('Existing host manifest has invalid allowed origins.');
  }
  return {
    name: HOST_NAME,
    description: 'Nanobrowser access to Downloads and Documents',
    path: launcher,
    type: 'stdio',
    allowed_origins: [...new Set([...previous, `chrome-extension://${extensionId}/`])],
  };
}

export function launcherText(platform, node, host) {
  if (platform === 'win32') {
    const quote = value => `"${value.replaceAll('%', '%%')}"`;
    return `@echo off\r\n${quote(node)} ${quote(host)} %*\r\n`;
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh\nexec ${quote(node)} ${quote(host)} "$@"\n`;
}

async function previousOrigins(manifestFile) {
  try {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (manifest.name !== HOST_NAME) throw new Error('Existing host manifest has an unexpected name.');
    return manifest.allowed_origins;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function registerManifest(platform, locations, manifestFile, content) {
  for (const location of locations) {
    if (platform === 'win32') {
      const result = spawnSync('reg.exe', ['add', location, '/ve', '/t', 'REG_SZ', '/d', manifestFile, '/f'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.error || result.status !== 0)
        throw new Error(`Could not register ${location}: ${result.error?.message || result.stderr}`);
      continue;
    }
    await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
    await writeFile(location, content, { mode: 0o600 });
  }
}

export async function install(extensionId) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  const platform = process.platform;
  if (!['linux', 'darwin', 'win32'].includes(platform))
    throw new Error('Supported platforms: Linux, macOS and Windows.');
  const home = homedir();
  const directory = installDirectory(platform, home, process.env);
  const launcher = path.join(directory, platform === 'win32' ? 'host.bat' : 'host.sh');
  const manifestFile = path.join(directory, `${HOST_NAME}.json`);
  const manifest = hostManifest(extensionId, launcher, await previousOrigins(manifestFile));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ['host.mjs', 'folders.mjs'])
    await copyFile(path.join(path.dirname(fileURLToPath(import.meta.url)), name), path.join(directory, name));
  await writeFile(launcher, launcherText(platform, process.execPath, path.join(directory, 'host.mjs')), {
    mode: 0o700,
  });
  if (platform !== 'win32') await chmod(launcher, 0o700);
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestFile, content, { mode: 0o600 });
  await registerManifest(platform, manifestLocations(platform, home, process.env), manifestFile, content);
  return { directory, roots: await folderRoots() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flag = process.argv.indexOf('--extension-id');
  const id = flag < 0 ? '' : process.argv[flag + 1];
  install(id)
    .then(result => {
      console.log(`Installed Nanobrowser file access for ${id}.`);
      for (const [name, location] of Object.entries(result.roots)) console.log(`${name}: ${location}`);
      console.log(
        'Return to Nanobrowser Settings and click Check connection. Restart the browser if it still cannot find the helper.',
      );
    })
    .catch(error => {
      console.error(`File access setup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
