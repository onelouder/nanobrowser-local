import { constants } from 'node:fs';
import { lstat, realpath, readdir, mkdir, open, link, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { endianness } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { folderRoots } from './folders.mjs';

export const HOST_NAME = 'com.nanobrowser.local_files';
export const MAX_READ = 256 * 1024;
export const MAX_WRITE = 512 * 1024;
const MAX_REQUEST = 2 * 1024 * 1024;

function relativeParts(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\\:]/.test(value)) {
    throw new Error('Use a relative path with forward slashes inside Downloads or Documents.');
  }
  if (value === '' && allowEmpty) return [];
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('Absolute paths, traversal, empty components and trailing dots or spaces are not allowed.');
  }
  if (parts.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Reserved device names are not allowed.');
  }
  return parts;
}

async function info(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkedPath(roots, request, allowEmpty = false) {
  if (typeof request.root !== 'string' || !Object.hasOwn(roots, request.root)) {
    throw new Error('Root must be downloads or documents.');
  }
  const parts = relativeParts(request.path, allowEmpty);
  const root = roots[request.root];
  const canonicalRoot = await realpath(root).catch(error => {
    if (error.code === 'ENOENT') return path.resolve(root);
    throw error;
  });
  let target = canonicalRoot;
  for (const part of parts) {
    target = path.join(target, part);
    const stat = await info(target);
    if (stat?.isSymbolicLink()) throw new Error('Symbolic links are not accessible.');
  }
  return { root: canonicalRoot, target };
}

function integer(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return result;
}

async function listFiles(roots, request) {
  const { target } = await checkedPath(roots, request, true);
  const offset = integer(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = integer(request.limit, 100, 1, 200, 'limit');
  const all = (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const entries = await Promise.all(
    all.slice(offset, offset + limit).map(async entry => {
      const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
      const stat = kind === 'file' ? await info(path.join(target, entry.name)) : null;
      return { name: entry.name, kind, ...(stat ? { size: stat.size } : {}) };
    }),
  );
  return { ok: true, entries, nextOffset: offset + limit < all.length ? offset + limit : null };
}

async function readFile(roots, request) {
  const { target } = await checkedPath(roots, request);
  const offset = integer(request.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const length = integer(request.length, MAX_READ, 1, MAX_READ, 'length');
  const initial = await info(target);
  if (initial && (!initial.isFile() || initial.nlink > 1)) {
    throw new Error('Only regular files without hard links can be read.');
  }
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1) throw new Error('Only regular files without hard links can be read.');
    await checkedPath(roots, request);
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const next = offset + bytesRead;
    return {
      ok: true,
      base64: buffer.subarray(0, bytesRead).toString('base64'),
      size: stat.size,
      offset,
      nextOffset: next < stat.size ? next : null,
    };
  } finally {
    await file.close();
  }
}

function writeBytes(request) {
  if (typeof request.base64 !== 'string' || request.base64.length > Math.ceil(MAX_WRITE / 3) * 4) {
    throw new Error('A write must contain at most 512 KiB of base64-encoded file data.');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.base64)) {
    throw new Error('File data is not valid base64.');
  }
  if (request.overwrite !== undefined && typeof request.overwrite !== 'boolean')
    throw new Error('overwrite must be a boolean.');
  const bytes = Buffer.from(request.base64, 'base64');
  if (bytes.length > MAX_WRITE) throw new Error('A write must contain at most 512 KiB.');
  return bytes;
}

async function writeFile(roots, request) {
  const bytes = writeBytes(request);
  const { target } = await checkedPath(roots, request);
  await mkdir(path.dirname(target), { recursive: true });
  await checkedPath(roots, request);
  const prior = await info(target);
  if (prior && (!prior.isFile() || prior.nlink > 1))
    throw new Error('Only regular files without hard links can be replaced.');
  if (prior && !request.overwrite) throw new Error('File already exists. Set overwrite to true to replace it.');
  const temporary = path.join(path.dirname(target), `.nanobrowser-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await checkedPath(roots, request);
    if (request.overwrite) await rename(temporary, target);
    else await link(temporary, target);
    return { ok: true, path: target, bytes: bytes.length };
  } finally {
    await file.close();
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function handleRequest(request, roots) {
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('Request must be an object.');
    if (request.op === 'status')
      return { ok: true, roots: Object.entries(roots).map(([id, value]) => ({ id, path: value })), version: 1 };
    if (request.op === 'list') return await listFiles(roots, request);
    if (request.op === 'read') return await readFile(roots, request);
    if (request.op === 'write') return await writeFile(roots, request);
    if (request.op === 'mkdir') {
      const { target } = await checkedPath(roots, request);
      await mkdir(target, { recursive: true });
      await checkedPath(roots, request);
      return { ok: true, path: target };
    }
    throw new Error('Unknown file operation.');
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function encodeMessage(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length >= 1024 * 1024) throw new Error('Native response exceeds 1 MiB.');
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(json.length);
  else header.writeUInt32BE(json.length);
  return Buffer.concat([header, json]);
}

export async function serve(input, output, roots) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = endianness() === 'LE' ? buffer.readUInt32LE() : buffer.readUInt32BE();
      if (!length || length > MAX_REQUEST) throw new Error('Invalid native message length.');
      if (buffer.length < length + 4) break;
      let reply;
      try {
        reply = await handleRequest(JSON.parse(buffer.subarray(4, length + 4).toString('utf8')), roots);
      } catch {
        reply = { ok: false, error: 'Invalid JSON request.' };
      }
      output.write(encodeMessage(reply));
      buffer = buffer.subarray(length + 4);
    }
  }
  if (buffer.length) throw new Error('Incomplete native message.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  serve(process.stdin, process.stdout, await folderRoots()).catch(error => {
    process.stderr.write(`Nanobrowser file helper: ${error.message}\n`);
    process.exitCode = 1;
  });
}
