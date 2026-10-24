import { z } from 'zod';
import type { AgentTool } from './tools';

export const LOCAL_FILE_TOOLS = ['list_files', 'read_file', 'write_file', 'create_directory'] as const;
const ROOT = z.enum(['downloads', 'documents']);
const PATH = z
  .string()
  .max(1024)
  .refine(
    value =>
      !/[\\:\0]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part !== '..' && part !== '.'),
    'Use a relative path inside Downloads or Documents, with / between folders.',
  );
const FILE_PATH = PATH.refine(
  value => value.length > 0 && !value.endsWith('/'),
  'A file or directory name is required.',
);
const COMMON = { root: ROOT, path: FILE_PATH };
const ENCODING = z.enum(['utf8', 'base64']);
const SCHEMAS = {
  list_files: z.object({
    root: ROOT,
    path: PATH.default(''),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(40),
  }),
  read_file: z.object({
    ...COMMON,
    offset: z.number().int().min(0).default(0),
    length: z.number().int().min(4).max(4096).default(4096),
    encoding: ENCODING.default('utf8'),
  }),
  write_file: z.object({
    ...COMMON,
    content: z.string().max(699052),
    encoding: ENCODING.default('utf8'),
    overwrite: z.boolean().default(false),
  }),
  create_directory: z.object(COMMON),
};

export type LocalFileRoot = z.infer<typeof ROOT>;
export type LocalFileRequest =
  | { op: 'status' }
  | { op: 'list'; root: LocalFileRoot; path: string; offset?: number; limit?: number }
  | { op: 'read'; root: LocalFileRoot; path: string; offset?: number; length?: number }
  | { op: 'write'; root: LocalFileRoot; path: string; base64: string; overwrite?: boolean }
  | { op: 'mkdir'; root: LocalFileRoot; path: string };
export type LocalFileReply =
  | { ok: false; error: string; uncertain?: boolean }
  | { ok: true; version: 1; roots: Array<{ id: LocalFileRoot; path: string }> }
  | {
      ok: true;
      entries: Array<{ name: string; kind: 'file' | 'directory' | 'other'; size?: number }>;
      nextOffset: number | null;
    }
  | { ok: true; base64: string; size: number; offset: number; nextOffset: number | null }
  | { ok: true; path: string; bytes?: number };
export interface PreparedFileCall {
  request: LocalFileRequest;
  encoding?: 'utf8' | 'base64';
}

const DESCRIPTIONS: Record<(typeof LOCAL_FILE_TOOLS)[number], string> = {
  list_files:
    'List files and folders directly in Downloads or Documents. No project or attachment is needed. Use path "" for the root; follow nextOffset to see more entries.',
  read_file:
    'Read a file directly from Downloads or Documents. UTF-8 text is the default; base64 reads arbitrary binary files. Offsets and length are bytes, not characters. Follow the returned nextOffset to read the next page. No project or attachment is needed.',
  write_file:
    'Write a file directly into Downloads or Documents, including CSS, JS, HTML and any other extension. Missing parent directories are created. Content is UTF-8 text unless encoding is base64. An existing file is preserved unless overwrite=true. Writes follow the user’s Ask/Auto mode.',
  create_directory:
    'Create a folder and missing parents inside Downloads or Documents. Writes follow the user’s Ask/Auto mode.',
};

export const LOCAL_FILE_DEFINITIONS: AgentTool[] = LOCAL_FILE_TOOLS.map(name => ({
  name,
  source: 'agent',
  group: 'files',
  description: DESCRIPTIONS[name],
  parameters: z.toJSONSchema(SCHEMAS[name], { target: 'draft-7' }),
}));

export function isLocalFileTool(name: string): name is (typeof LOCAL_FILE_TOOLS)[number] {
  return LOCAL_FILE_TOOLS.some(tool => tool === name);
}

function encodedContent(content: string, encoding: 'utf8' | 'base64'): string {
  if (encoding === 'base64') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))
      throw new Error('Content is not valid base64.');
    if (atob(content).length > 512 * 1024) throw new Error('A write can contain at most 512 KiB.');
    return content;
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > 512 * 1024) throw new Error('A write can contain at most 512 KiB.');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function prepareLocalFileCall(name: string, input: unknown): PreparedFileCall {
  if (name === 'list_files') return { request: { op: 'list', ...SCHEMAS.list_files.parse(input) } };
  if (name === 'create_directory') return { request: { op: 'mkdir', ...SCHEMAS.create_directory.parse(input) } };
  if (name === 'read_file') {
    const { encoding, ...args } = SCHEMAS.read_file.parse(input);
    return { request: { op: 'read', ...args }, encoding };
  }
  if (name !== 'write_file') throw new Error('Unknown local file tool.');
  const { content, encoding, ...args } = SCHEMAS.write_file.parse(input);
  return { request: { op: 'write', ...args, base64: encodedContent(content, encoding) } };
}

function decodeText(bytes: Uint8Array, more: boolean): { text: string; used: number } {
  for (let trim = 0; trim <= (more ? 3 : 0); trim++) {
    const used = bytes.length - trim;
    if (used <= 0 && bytes.length > 0) break;
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)), used };
    } catch {
      /* A page may end in the middle of a UTF-8 character. */
    }
  }
  throw new Error(
    'This range is not complete UTF-8 text. Use encoding="base64" for binary files, or increase length and use the previous nextOffset.',
  );
}

export function formatLocalFileReply(prepared: PreparedFileCall, reply: LocalFileReply): string {
  if (!reply.ok) return reply.error;
  if ('base64' in reply) {
    const bytes = Uint8Array.from(atob(reply.base64), char => char.charCodeAt(0));
    const decoded =
      prepared.encoding === 'base64'
        ? { text: reply.base64, used: bytes.length }
        : decodeText(bytes, reply.nextOffset !== null);
    const nextOffset = reply.offset + decoded.used < reply.size ? reply.offset + decoded.used : null;
    return `${JSON.stringify({ size: reply.size, offset: reply.offset, nextOffset, encoding: prepared.encoding })}\n${decoded.text}`;
  }
  if ('entries' in reply && prepared.request.op === 'list') {
    const lines: string[] = [];
    let size = 0;
    for (const entry of reply.entries) {
      const line = JSON.stringify(entry);
      if (size + line.length > 6000) break;
      lines.push(line);
      size += line.length + 1;
    }
    const nextOffset =
      lines.length < reply.entries.length ? (prepared.request.offset ?? 0) + lines.length : reply.nextOffset;
    return `${JSON.stringify({ nextOffset })}\n${lines.join('\n')}`;
  }
  return JSON.stringify(reply);
}
