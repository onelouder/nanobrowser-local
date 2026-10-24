import { z } from 'zod';
import { formatLocalFileReply, prepareLocalFileCall } from '@src/agent/local-files';
import type { LocalFileReply, LocalFileRequest, PreparedFileCall } from '@src/agent/local-files';
import type { ToolCallRequest } from '@src/llm';
import type { PermissionMode } from '@src/store/types';
export type { LocalFileReply, LocalFileRequest } from '@src/agent/local-files';

export const LOCAL_FILE_HOST = 'com.nanobrowser.local_files';
const SETUP =
  'Open file access setup in Settings to connect Downloads and Documents. Projects and attachments are not required.';
const ERROR = z.object({ ok: z.literal(false), error: z.string().max(10000) });
const ROOT = z.enum(['downloads', 'documents']);
const PAGE = z.number().int().nonnegative().nullable();
const RESPONSES = {
  status: z.object({
    ok: z.literal(true),
    version: z.literal(1),
    roots: z.array(z.object({ id: ROOT, path: z.string() })).length(2),
  }),
  list: z.object({
    ok: z.literal(true),
    entries: z
      .array(
        z.object({
          name: z.string().max(1024),
          kind: z.enum(['file', 'directory', 'other']),
          size: z.number().nonnegative().optional(),
        }),
      )
      .max(200),
    nextOffset: PAGE,
  }),
  read: z.object({
    ok: z.literal(true),
    base64: z.string().max(349528),
    size: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: PAGE,
  }),
  write: z.object({ ok: z.literal(true), path: z.string(), bytes: z.number().int().nonnegative() }),
  mkdir: z.object({ ok: z.literal(true), path: z.string() }),
};

function decodeReply(request: LocalFileRequest, value: unknown): LocalFileReply | null {
  const parsed = z.union([ERROR, RESPONSES[request.op]]).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function nativeRequest(request: LocalFileRequest, signal?: AbortSignal): Promise<LocalFileReply> {
  return new Promise(resolve => {
    let port: chrome.runtime.Port | undefined;
    let sent = false;
    let complete = false;
    const fail = (reason: string) => {
      const uncertain = sent && (request.op === 'write' || request.op === 'mkdir');
      finish({
        ok: false,
        ...(uncertain ? { uncertain: true } : {}),
        error: `${reason}${uncertain ? ' The write outcome is unknown; inspect the file before retrying.' : ''}`,
      });
    };
    const finish = (reply: LocalFileReply) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stopped);
      port?.onMessage.removeListener(message);
      port?.onDisconnect.removeListener(disconnected);
      port?.disconnect();
      resolve(reply);
    };
    const stopped = () => fail('Local file operation stopped.');
    const disconnected = () =>
      fail(`Local file helper disconnected: ${chrome.runtime.lastError?.message ?? 'no response'}. ${SETUP}`);
    const message = (value: unknown) => {
      const reply = decodeReply(request, value);
      if (reply) finish(reply);
      else fail('The local file helper returned an invalid response. Reinstall the helper.');
    };
    const timer = setTimeout(() => fail('Local file helper timed out.'), 15000);
    signal?.addEventListener('abort', stopped, { once: true });
    if (signal?.aborted) return stopped();
    try {
      port = chrome.runtime.connectNative(LOCAL_FILE_HOST);
      port.onMessage.addListener(message);
      port.onDisconnect.addListener(disconnected);
      port.postMessage(request);
      sent = true;
    } catch (cause) {
      fail(`Local file access is unavailable: ${cause instanceof Error ? cause.message : String(cause)}. ${SETUP}`);
    }
  });
}

export async function requestLocalFiles(request: LocalFileRequest, signal?: AbortSignal): Promise<LocalFileReply> {
  if (signal?.aborted) return { ok: false, error: 'Local file operation stopped before dispatch.' };
  const allowed = await chrome.permissions.contains({ permissions: ['nativeMessaging'] }).catch(() => false);
  if (!allowed) return { ok: false, error: `Local file access is not connected. ${SETUP}` };
  return nativeRequest(request, signal);
}

interface FileToolContext {
  signal: AbortSignal;
  mode: PermissionMode;
  confirm: (data: Record<string, unknown>) => Promise<string>;
}

async function confirmWrite(prepared: PreparedFileCall, context: FileToolContext): Promise<boolean> {
  const request = prepared.request;
  if (request.op !== 'write' && request.op !== 'mkdir') return true;
  if (context.mode !== 'ask') return true;
  const action = request.op === 'mkdir' ? 'Create folder' : request.overwrite ? 'Write or replace file' : 'Create file';
  const answer = await context.confirm({
    category: 'local-file',
    action,
    target: `${request.root}/${request.path}`,
    reason:
      'This changes a file on your computer. Existing files are replaced only when overwrite is explicitly enabled.',
    canRemember: false,
  });
  return answer === 'approve';
}

export async function runLocalFileTool(
  call: ToolCallRequest,
  context: FileToolContext,
): Promise<{ text: string; isError: boolean }> {
  try {
    const prepared = prepareLocalFileCall(call.toolName, call.input);
    if (context.signal.aborted) return { text: 'Stopped before dispatch; no file operation was sent.', isError: true };
    const approved = await confirmWrite(prepared, context);
    if (context.signal.aborted) return { text: 'Stopped before dispatch; no file operation was sent.', isError: true };
    if (!approved)
      return {
        text: 'error USER_DECLINED (nothing dispatched)\nThe user declined the file operation; nothing was written.',
        isError: true,
      };
    const reply = await requestLocalFiles(prepared.request, context.signal);
    return {
      text: reply.ok
        ? formatLocalFileReply(prepared, reply)
        : `error ${reply.uncertain ? 'FILE_WRITE_UNKNOWN' : 'LOCAL_FILE'}\n${reply.error}`,
      isError: !reply.ok,
    };
  } catch (cause) {
    return { text: `error LOCAL_FILE: ${cause instanceof Error ? cause.message : String(cause)}`, isError: true };
  }
}
