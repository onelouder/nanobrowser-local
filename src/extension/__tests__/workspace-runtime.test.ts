import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('../panel', () => ({ PANEL_PATH: 'sidepanel.html' }));
vi.mock('../layer', () => ({ addPromptRoute: vi.fn(), controllerReady: Promise.resolve({ closeSession: vi.fn() }) }));
vi.mock('../border', () => ({
  PageBorder: class {
    start = async () => {};
    tabsChanged = async () => {};
    status = async () => {};
  },
  listenForBorder: vi.fn(),
  injectBorder: vi.fn(),
}));
vi.mock('../agent-session', () => ({
  createAgentSession: () => {
    const ids: number[] = [];
    return { share: async (id: number) => ids.push(id), tabIds: () => ids, hasTab: (id: number) => ids.includes(id) };
  },
  layerPort: () => ({
    tabs: async () => ({
      tabs: [{ tabId: 101, url: 'https://example.com/', title: 'Restored', active: true }],
      activeTabId: 101,
    }),
    call: vi.fn(async () => ({ ok: false, text: 'observation failed' })),
  }),
}));

const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
function browser() {
  const area = (data: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, values);
    },
    remove: async (key: string) => {
      delete data[key];
    },
    onChanged: event(),
  });
  const local = { 'nb.providers': [{ id: 'p', kind: 'openai-compatible', name: 'Local', models: [{ name: 'm' }] }] };
  const tabs = new Map<number, { id: number; url: string; title: string; active: boolean; windowId: number }>();
  // A browser restart may reuse an old numeric ID for an unrelated page.
  tabs.set(1, { id: 1, url: 'https://unrelated.example/', title: 'Unrelated', active: true, windowId: 1 });
  let nextId = 100;
  const api = {
    storage: { local: area(local), session: area({}), onChanged: event() },
    debugger: { onDetach: event() },
    tabs: {
      onRemoved: event(),
      onActivated: event(),
      onUpdated: event(),
      get: async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error('closed');
        return tab;
      },
      query: async () => [...tabs.values()],
      create: vi.fn(async ({ url, active }: { url: string; active: boolean }) => {
        const tab = { id: ++nextId, url, title: url, active, windowId: 1 };
        tabs.set(tab.id, tab);
        return tab;
      }),
      update: vi.fn(async (id: number) => tabs.get(id)),
      group: async () => 1,
    },
    sidePanel: { setOptions: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: async () => {}, clear: async () => {} },
  };
  vi.stubGlobal('chrome', api);
  return api;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(async () => {
  const { closeDb } = await import('@src/store/db');
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
  vi.unstubAllGlobals();
});

async function restoredSession() {
  const api = browser();
  const { createConversation, updateConversation, putRun } = await import('@src/store/conversations');
  const { EMPTY_GUARDS, ZERO_USAGE } = await import('@src/store/types');
  const { RunManager } = await import('../run-manager');
  const c = await createConversation({ mode: 'ask' });
  const pair = { model: { providerId: 'p', model: 'm' }, reasoning: 'none' as const };
  await updateConversation(c.id, {
    savedTabs: [
      { id: 'logical-1', url: 'https://example.com/', title: 'First', origin: 'start' },
      { id: 'logical-2', url: 'https://example.com/second', title: 'Second', origin: 'user' },
    ],
    resumeConfig: { ...pair, contextWindow: 150000, maxOutput: 10000, turnCap: 100, errorCap: 3, noEffectCap: 3 },
  });
  await putRun({
    conversationId: c.id,
    runId: 'before-restart',
    leafEntryId: null,
    status: 'suspended',
    steering: [],
    turns: 1,
    usage: ZERO_USAGE,
    debt: [{ toolCallId: 'old-write', tabId: 1, state: 'open', label: 'submit' }],
    guards: EMPTY_GUARDS,
    tabs: [1],
    startedAt: '',
    updatedAt: '',
  });
  return { api, c, pair, manager: new RunManager() };
}

describe('workspace runtime after session storage loss', () => {
  it('opens one page without running or losing the remaining saved manifest', async () => {
    const { manager, c, api } = await restoredSession();
    expect(await manager.workspacePreview(c.id)).toMatchObject({ missingTabs: 2, liveTabs: [], modelAvailable: true });
    expect(await manager.workspaceOpen(c.id)).toBe(101);
    await vi.waitFor(async () => expect((await manager.workspacePreview(c.id)).tabs).toHaveLength(2));
    expect(manager.isRunning(c.id)).toBe(false);
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(await manager.scope.conversationOf(1)).toBeNull();
  });

  it('deduplicates Resume, creates fresh tab IDs, and stops before a model request when observation fails', async () => {
    const { manager, c, api } = await restoredSession();
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await Promise.all([
      manager.workspaceResume(c.id, { reopenTabs: true }),
      manager.workspaceResume(c.id, { reopenTabs: true }),
    ]);
    await vi.waitFor(() => expect(manager.isRunning(c.id)).toBe(false));
    const { getRun } = await import('@src/store/conversations');
    const { listRunHistory } = await import('@src/store/checkpoints');
    expect(api.tabs.create).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
    expect(await getRun(c.id)).toMatchObject({ status: 'failed', debt: [{ tabId: -1, state: 'unverifiable' }] });
    expect(await listRunHistory(c.id)).toHaveLength(1);
  });

  it('requires explicit model remapping before opening imported pages', async () => {
    const { manager, c, api } = await restoredSession();
    const { updateConversation } = await import('@src/store/conversations');
    await updateConversation(c.id, { needsModelSelection: true });
    await expect(manager.workspaceResume(c.id, { reopenTabs: true })).rejects.toThrow('Choose a model');
    expect(api.tabs.create).not.toHaveBeenCalled();
  });
});

it('reserves startup against a simultaneous panel send and restart', async () => {
  const { manager, c, pair } = await restoredSession();
  const sink = vi.fn();
  const connection = { tabId: 1, conversationId: c.id, sink };
  const resume = manager.workspaceResume(c.id, { reopenTabs: true });
  await manager.handle(connection, {
    type: 'send',
    conversationId: c.id,
    tabId: 1,
    text: 'Racing message',
    attachments: [],
    context: [],
    mode: 'ask',
    model: pair.model,
    reasoning: pair.reasoning,
  });
  await manager.handle(connection, { type: 'restart', conversationId: c.id, entryId: 'old-entry' });
  await resume;
  await vi.waitFor(() => expect(manager.isRunning(c.id)).toBe(false));
  const { listRunHistory } = await import('@src/store/checkpoints');
  const { activeBranch } = await import('@src/store/conversations');
  expect(await listRunHistory(c.id)).toHaveLength(1);
  expect(JSON.stringify(await activeBranch(c.id))).not.toContain('Racing message');
  expect(sink.mock.calls.filter(([event]) => event.type === 'error')).toHaveLength(2);
});

it('persists Pause during startup as suspended even before the agent loop exists', async () => {
  const { manager, c } = await restoredSession();
  await manager.workspaceResume(c.id, { reopenTabs: true });
  await manager.workspacePause(c.id);
  const { getRun } = await import('@src/store/conversations');
  expect(await getRun(c.id)).toMatchObject({ status: 'suspended' });
  expect(manager.isRunning(c.id)).toBe(false);
});

it('pauses a restored question without leaving a stale awaiting-user status', async () => {
  const { manager, c } = await restoredSession();
  const { getRun, putRun } = await import('@src/store/conversations');
  const { RunWriter } = await import('@src/agent/records');
  const writer = new RunWriter(c.id, 'before-restart');
  await writer.message({
    role: 'assistant',
    parts: [{ type: 'tool-call', toolCallId: 'q', toolName: 'ask_user', input: {} }],
  });
  await writer.intent('q', 'ask_user', {});
  await putRun({
    ...(await getRun(c.id))!,
    status: 'awaiting_user',
    pendingPrompt: {
      kind: 'ask-user',
      request: { kind: 'input', message: 'Which page?' },
      openedAt: '',
    },
  });
  await manager.restore();
  await vi.waitFor(() => expect(manager.broker.promptsOf(c.id)).toHaveLength(1));
  await manager.workspacePause(c.id);
  expect(await getRun(c.id)).toMatchObject({ status: 'suspended', pendingPrompt: undefined });
  expect(manager.broker.promptsOf(c.id)).toHaveLength(0);
});
