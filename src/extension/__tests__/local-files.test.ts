import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_FILE_HOST, requestLocalFiles, runLocalFileTool } from '../local-files';

function event() {
  const listeners = new Set<(value?: unknown) => void>();
  return {
    addListener: (fn: (value?: unknown) => void) => listeners.add(fn),
    removeListener: (fn: (value?: unknown) => void) => listeners.delete(fn),
    fire: (value?: unknown) => {
      for (const listener of listeners) listener(value);
    },
  };
}
function browser(reply: unknown = { ok: true, path: '/Downloads/file.css', bytes: 3 }) {
  const onMessage = event();
  const onDisconnect = event();
  const port = {
    onMessage,
    onDisconnect,
    disconnect: vi.fn(),
    postMessage: vi.fn(() => {
      if (reply !== null) queueMicrotask(() => onMessage.fire(reply));
    }),
  };
  const api = {
    permissions: { contains: vi.fn(async () => true) },
    runtime: { connectNative: vi.fn(() => port), lastError: undefined as { message: string } | undefined },
  };
  vi.stubGlobal('chrome', api);
  return { api, port };
}
const writeCall = {
  toolCallId: 'f',
  toolName: 'write_file',
  input: { root: 'downloads', path: 'file.css', content: 'abc' },
};
const context = (mode: 'ask' | 'auto' = 'auto') => ({
  mode,
  signal: new AbortController().signal,
  confirm: vi.fn(async () => 'approve'),
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('local file transport', () => {
  it('reports one-time setup when permission is absent', async () => {
    const { api } = browser();
    api.permissions.contains.mockResolvedValue(false);
    expect(await requestLocalFiles({ op: 'status' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not connected'),
    });
    expect(api.runtime.connectNative).not.toHaveBeenCalled();
  });
  it('validates the helper response before using it', async () => {
    const { port } = browser({ ok: true, roots: 'bad' });
    expect(await requestLocalFiles({ op: 'status' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('invalid response'),
    });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
  it('provides actionable helper-not-installed errors', async () => {
    const { api, port } = browser(null);
    api.runtime.lastError = { message: 'Specified native messaging host not found.' };
    const pending = requestLocalFiles({ op: 'status' });
    await Promise.resolve();
    await Promise.resolve();
    port.onDisconnect.fire();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('file access setup') });
  });
  it('does not dispatch after Stop and reports uncertainty if stopped after a write dispatch', async () => {
    const { api, port } = browser(null);
    const stopped = new AbortController();
    stopped.abort();
    expect(await requestLocalFiles({ op: 'status' }, stopped.signal)).toMatchObject({ ok: false });
    expect(api.runtime.connectNative).not.toHaveBeenCalled();
    const running = new AbortController();
    const pending = requestLocalFiles({ op: 'write', root: 'downloads', path: 'x', base64: '' }, running.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(port.postMessage).toHaveBeenCalledOnce();
    running.abort();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('outcome is unknown') });
  });
  it('bounds a silent helper wait and disconnects', async () => {
    vi.useFakeTimers();
    const { port } = browser(null);
    const pending = requestLocalFiles({ op: 'status' });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
});

describe('file execution policy', () => {
  it('does not send a write when Ask confirmation is declined', async () => {
    const { api } = browser();
    const options = context('ask');
    options.confirm.mockResolvedValue('decline');
    expect(await runLocalFileTool(writeCall, options)).toMatchObject({
      isError: true,
      text: expect.stringContaining('nothing was written'),
    });
    expect(options.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'local-file', target: 'downloads/file.css' }),
    );
    expect(api.runtime.connectNative).not.toHaveBeenCalled();
  });
  it('does not write or report a user decline when Stop withdraws the confirmation', async () => {
    const { api } = browser();
    const controller = new AbortController();
    const result = await runLocalFileTool(writeCall, {
      mode: 'ask',
      signal: controller.signal,
      confirm: async () => {
        controller.abort();
        return 'withdrawn';
      },
    });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('Stopped before dispatch') });
    expect(api.runtime.connectNative).not.toHaveBeenCalled();
  });

  it('sends the approved write without a downloads dialog', async () => {
    const { api, port } = browser();
    expect(await runLocalFileTool(writeCall, context('ask'))).toMatchObject({ isError: false });
    expect(api.runtime.connectNative).toHaveBeenCalledWith(LOCAL_FILE_HOST);
    expect(port.postMessage).toHaveBeenCalledWith({
      op: 'write',
      root: 'downloads',
      path: 'file.css',
      base64: 'YWJj',
      overwrite: false,
    });
  });
  it('writes in Auto mode without a confirmation and reads in Ask mode directly', async () => {
    browser();
    const auto = context();
    expect((await runLocalFileTool(writeCall, auto)).isError).toBe(false);
    expect(auto.confirm).not.toHaveBeenCalled();
    browser({ ok: true, base64: 'YWJj', size: 3, offset: 0, nextOffset: null });
    const ask = context('ask');
    const result = await runLocalFileTool(
      { toolCallId: 'r', toolName: 'read_file', input: { root: 'documents', path: 'notes.md' } },
      ask,
    );
    expect(result).toMatchObject({ isError: false, text: expect.stringContaining('abc') });
    expect(ask.confirm).not.toHaveBeenCalled();
  });
});
