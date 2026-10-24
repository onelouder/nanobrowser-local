import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleRequest, encodeMessage, serve, MAX_READ, MAX_WRITE } from './host.mjs';
import { parseUserDirs, parseWindowsFolders } from './folders.mjs';
import { hostManifest, installDirectory, manifestLocations, launcherText } from './install.mjs';

let directory;
let roots;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'nanobrowser-files-test-'));
  roots = { downloads: path.join(directory, 'Downloads'), documents: path.join(directory, 'Documents') };
  await Promise.all(Object.values(roots).map(root => mkdir(root)));
});
after(async () => rm(directory, { recursive: true, force: true }));
const request = value => handleRequest(value, roots);
const encoded = text => Buffer.from(text).toString('base64');

test('status lists both roots without project/session context', async () => {
  assert.deepEqual(await request({ op: 'status' }), {
    ok: true,
    version: 1,
    roots: Object.entries(roots).map(([id, path]) => ({ id, path })),
  });
});

test('read/write arbitrary extensions, empty files, nested folders and overwrite', async () => {
  const content = 'body { color: rebeccapurple; }';
  const write = { op: 'write', root: 'documents', path: 'site/styles/main.css', base64: encoded(content) };
  assert.equal((await request(write)).bytes, Buffer.byteLength(content));
  const read = await request({ op: 'read', root: 'documents', path: write.path });
  assert.equal(Buffer.from(read.base64, 'base64').toString(), content);
  assert.equal((await request(write)).ok, false);
  assert.equal((await request({ ...write, overwrite: true, base64: encoded('updated') })).ok, true);
  assert.equal(await readFile(path.join(roots.documents, write.path), 'utf8'), 'updated');
  assert.equal((await request({ ...write, path: 'empty.anything', base64: '' })).bytes, 0);
});

test('paged reads report byte offsets and do not silently truncate', async () => {
  await writeFile(path.join(roots.downloads, 'large.bin'), Buffer.alloc(MAX_READ + 7, 35));
  const first = await request({ op: 'read', root: 'downloads', path: 'large.bin' });
  assert.equal(first.nextOffset, MAX_READ);
  assert.equal(Buffer.from(first.base64, 'base64').length, MAX_READ);
  const last = await request({ op: 'read', root: 'downloads', path: 'large.bin', offset: first.nextOffset });
  assert.equal(last.nextOffset, null);
  assert.equal(Buffer.from(last.base64, 'base64').length, 7);
  assert.ok(encodeMessage(first).length < 1024 * 1024);
});

test('lists pages and creates directories', async () => {
  assert.equal((await request({ op: 'mkdir', root: 'downloads', path: 'listing/nested' })).ok, true);
  await writeFile(path.join(roots.downloads, 'listing/a.txt'), 'a');
  const first = await request({ op: 'list', root: 'downloads', path: 'listing', limit: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].name, 'a.txt');
  assert.equal(first.nextOffset, 1);
  const last = await request({ op: 'list', root: 'downloads', path: 'listing', offset: 1, limit: 1 });
  assert.deepEqual(last.entries, [{ name: 'nested', kind: 'directory' }]);
  assert.equal(last.nextOffset, null);
});

test('rejects traversal, absolute paths, alternate streams and device paths', async () => {
  for (const file of [
    '../secret',
    '/etc/passwd',
    'C:/secret',
    '\\\\server\\secret',
    'site/../secret',
    'a\\b',
    'a:b',
    'NUL.txt',
    'folder./x',
    'a//b',
  ]) {
    const reply = await request({ op: 'write', root: 'downloads', path: file, base64: '' });
    assert.equal(reply.ok, false, file);
  }
  assert.equal((await request({ op: 'list', root: '__proto__', path: '' })).ok, false);
  assert.equal((await request({ op: 'read', root: 'downloads', path: '' })).ok, false);
});

test('rejects symlink files and parents without touching the outside target', async t => {
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(outside, path.join(roots.downloads, 'escape'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('symlinks unavailable');
    throw error;
  }
  for (const op of ['read', 'write', 'mkdir', 'list']) {
    assert.equal(
      (await request({ op, root: 'downloads', path: 'escape/secret.txt', base64: encoded('bad'), overwrite: true })).ok,
      false,
    );
  }
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
});

test('rejects hardlinked reads and replacements', async () => {
  const outside = path.join(directory, 'hardlink-target');
  await writeFile(outside, 'original');
  await link(outside, path.join(roots.documents, 'hardlink.txt'));
  assert.equal((await request({ op: 'read', root: 'documents', path: 'hardlink.txt' })).ok, false);
  assert.equal(
    (await request({ op: 'write', root: 'documents', path: 'hardlink.txt', overwrite: true, base64: encoded('bad') }))
      .ok,
    false,
  );
  assert.equal(await readFile(outside, 'utf8'), 'original');
});

test('validates untrusted operation arguments and size limits', async () => {
  for (const extra of [
    { base64: '*' },
    { base64: encoded('x'), overwrite: 'yes' },
    { base64: Buffer.alloc(MAX_WRITE + 1).toString('base64') },
  ]) {
    assert.equal((await request({ op: 'write', root: 'downloads', path: 'invalid.bin', ...extra })).ok, false);
  }
  assert.equal((await request({ op: 'read', root: 'downloads', path: 'large.bin', length: MAX_READ + 1 })).ok, false);
  assert.equal((await request({ op: 'list', root: 'downloads', path: '', offset: -1 })).ok, false);
  assert.equal((await request(null)).ok, false);
  assert.equal((await request({ op: 'delete', root: 'downloads', path: 'large.bin' })).ok, false);
});

test('native framing accepts split and multiple requests', async () => {
  const first = encodeMessage({ op: 'status' });
  const second = encodeMessage({ op: 'list', root: 'documents', path: '' });
  const chunks = [];
  const output = new Writable({
    write(chunk, _, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  await serve(Readable.from([first.subarray(0, 2), first.subarray(2), second]), output, roots);
  assert.equal(chunks.length, 2);
  for (const frame of chunks) {
    const length = endianness() === 'LE' ? frame.readUInt32LE() : frame.readUInt32BE();
    assert.equal(frame.length, length + 4);
    assert.equal(JSON.parse(frame.subarray(4).toString()).ok, true);
  }
});

test('native framing rejects oversized and incomplete requests', async () => {
  const header = Buffer.alloc(4, 255);
  const output = new Writable({
    write(_, __, done) {
      done();
    },
  });
  await assert.rejects(serve(Readable.from([header]), output, roots), /length/);
  await assert.rejects(serve(Readable.from([Buffer.from([1, 2])]), output, roots), /Incomplete/);
});

test('Linux folder detection honors redirects without evaluating shell text', () => {
  assert.deepEqual(
    parseUserDirs('XDG_DOWNLOAD_DIR="$HOME/My Downloads"\nXDG_DOCUMENTS_DIR="/mnt/Documents"', '/home/test'),
    { downloads: '/home/test/My Downloads', documents: '/mnt/Documents' },
  );
  assert.deepEqual(parseUserDirs('XDG_DOCUMENTS_DIR="$HOME"\nXDG_DOWNLOAD_DIR="$(touch hacked)"', '/home/test'), {});
});

test('manifest permits exact IDs and preserves earlier authorized installs', () => {
  const first = hostManifest('a'.repeat(32), '/host.sh');
  const second = hostManifest('b'.repeat(32), '/host.sh', first.allowed_origins);
  assert.equal(second.allowed_origins.length, 2);
  assert.equal(hostManifest('a'.repeat(32), '/host.sh', first.allowed_origins).allowed_origins.length, 1);
  assert.throws(() => hostManifest('*', '/host.sh'));
  assert.throws(() => hostManifest('a'.repeat(32), '/host.sh', ['chrome-extension://*/']));
});

test('installer chooses per-user Chrome, Chromium and Edge registration locations', () => {
  assert.ok(manifestLocations('linux', '/home/me', {}).some(value => value.includes('/.config/google-chrome/')));
  assert.ok(
    manifestLocations('darwin', '/Users/me', {}).some(value => value.includes('Microsoft Edge/NativeMessagingHosts')),
  );
  assert.ok(
    manifestLocations('win32', 'C:\\Users\\me', {}).some(value => value.startsWith('HKCU\\Software\\Microsoft\\Edge')),
  );
  assert.equal(
    installDirectory('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'D:\\Local' }),
    'D:\\Local\\Nanobrowser\\NativeFiles',
  );
  assert.equal(installDirectory('linux', '/home/me', { XDG_DATA_HOME: '/data' }), '/data/nanobrowser/native-files');
});

test('launchers quote spaces and shell metacharacters', () => {
  assert.ok(launcherText('linux', "/opt/it's node/bin/node", '/my path/host.mjs').includes("'\\''"));
  assert.equal(
    launcherText('win32', 'C:\\Program Files\\node.exe', 'C:\\100%\\host.mjs'),
    '@echo off\r\n"C:\\Program Files\\node.exe" "C:\\100%%\\host.mjs" %*\r\n',
  );
});

test('installer and installed launcher work in an isolated home', { skip: process.platform === 'win32' }, async () => {
  const home = path.join(directory, 'installer-home');
  await mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
  };
  const installer = fileURLToPath(new URL('./install.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [installer, '--extension-id', 'c'.repeat(32)], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const location = manifestLocations(process.platform, home, env)[0];
  const manifest = JSON.parse(await readFile(location, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'c'.repeat(32)}/`]);
  const reply = spawnSync(manifest.path, [], { env, input: encodeMessage({ op: 'status' }) });
  assert.equal(reply.status, 0, reply.stderr.toString());
  const status = JSON.parse(reply.stdout.subarray(4).toString());
  assert.equal(status.ok, true);
  assert.equal(status.roots[0].path, path.join(home, 'Downloads'));
  assert.equal(status.roots[1].path, path.join(home, 'Documents'));
});

test('special files cannot block a read request', { skip: process.platform === 'win32' }, async () => {
  const fifo = path.join(roots.downloads, 'pipe');
  const result = spawnSync('mkfifo', [fifo]);
  assert.equal(result.status, 0);
  const reply = await request({ op: 'read', root: 'downloads', path: 'pipe' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /regular files/);
});

test('Windows folder JSON preserves Unicode and redirected OneDrive paths', () => {
  const folders = {
    downloads: String.raw`D:\下载\Jörg`,
    documents: String.raw`C:\Users\Jörg\OneDrive - 公司\文档`,
  };
  const output = Buffer.from(`${JSON.stringify(folders)}\r\n`, 'utf8').toString('utf8');
  assert.deepEqual(parseWindowsFolders(output, String.raw`C:\Users\Jörg`), folders);
});

test('Windows folder values reject invalid roots and do not expand access to the home folder', () => {
  const home = String.raw`C:\Users\me`;
  assert.deepEqual(parseWindowsFolders('{"downloads":null,"documents":42}', home), {});
  assert.deepEqual(parseWindowsFolders(JSON.stringify({ downloads: 'relative', documents: 'c:/USERS/ME/' }), home), {});
  assert.deepEqual(parseWindowsFolders('null', home), {});
  assert.throws(() => parseWindowsFolders('not JSON', home));
});
