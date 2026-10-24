import { runManager } from '@src/extension/index';
import { deleteConversation, getConversation } from '@src/store/conversations';
import { db } from '@src/store/db';
import { listProjects } from '@src/store/projects';
import { DEFAULT_SETTINGS } from '@src/store/settings';
import { assert, sleep, waitForLoad } from './helpers';
import { panel, scriptReplies, seedFixtureModel, waitForText } from './panel-chat';
import { defineCheck } from './registry';

const NAME = 'New-chat project fixture';
const INSTRUCTION = 'Preserve the violet navigation: draft-project-instructions-marker.';
const SELECT = 'Project for this chat';
type SelectState = {
  ok: boolean;
  value: string;
  disabled: boolean;
  focused: boolean;
  options: Array<{ value: string; text: string }>;
};

async function selection(tabId: number): Promise<SelectState> {
  return chrome.runtime.sendMessage({ nbTest: 'panel', tabId, op: 'select-state', label: SELECT });
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await read();
    if (matches(result)) return result;
    await sleep(100);
  }
  throw new Error(`${label}: ${JSON.stringify(await read())}`);
}

async function workspace(op: string, extra: Record<string, unknown> = {}): Promise<void> {
  const reply = await chrome.runtime.sendMessage({ nbTest: 'workspace', op, ...extra });
  assert(reply.ok, `workspace ${op}: ${JSON.stringify(extra)}`);
  await sleep(100);
}

async function createProject(): Promise<string> {
  const view = await chrome.tabs.create({ url: chrome.runtime.getURL('/workspace.html'), active: true });
  await waitForLoad(view.id!);
  await until(
    () => chrome.runtime.sendMessage({ nbTest: 'workspace', op: 'read' }),
    reply => reply.ok && reply.body.includes('New project'),
    'workspace loaded',
  );
  await workspace('click', { label: 'New project' });
  await workspace('fill', { label: 'Project name', text: NAME });
  await workspace('fill', { label: 'Objective', text: 'Continue the site rebuild directly from a new chat.' });
  await workspace('fill', { label: 'Project instructions', text: INSTRUCTION });
  await workspace('click', { label: 'Save' });
  const project = await until(
    async () => (await listProjects()).find(item => item.name === NAME),
    item => !!item,
    'new project persisted',
  );
  return project!.id;
}

async function firstMessage(tabId: number, projectId: string): Promise<string> {
  const updated = await until(
    () => selection(tabId),
    state => state.ok && state.options.some(option => option.value === projectId),
    'created project appeared without focusing or reloading the panel',
  );
  assert(!updated.focused, 'workspace retains focus while the open panel receives the project');
  assert(!updated.disabled, 'a new chat can choose a project before its first message');
  await panel(tabId, 'select', { label: SELECT, value: projectId });
  await until(
    () => selection(tabId),
    state => state.value === projectId,
    'draft project selected',
  );
  assert((await runManager.scope.conversationOf(tabId)) === null, 'project selection does not start a conversation');
  await scriptReplies([{ text: 'First chat uses the selected project.' }]);
  await panel(tabId, 'type-send', { text: 'Continue the project investigation.' });
  await waitForText(tabId, 'First chat uses the selected project.');
  const id = await runManager.scope.conversationOf(tabId);
  assert(id && (await getConversation(id))?.projectId === projectId, 'first message saves the selected project');
  const requests = (await (await fetch('http://localhost:8787/__llm/requests')).json()) as unknown[];
  assert(JSON.stringify(requests[0]).includes(INSTRUCTION), 'first inference request includes project instructions');
  return id;
}

async function newChat(tabId: number): Promise<void> {
  await until(
    () => selection(tabId),
    state => !state.disabled,
    'chat finished',
  );
  await panel(tabId, 'click', { label: 'New chat' });
  await until(
    () => selection(tabId),
    state => state.value === '',
    'New chat clears the project selection',
  );
}

async function resetAndAssign(tabId: number, projectId: string): Promise<string> {
  await newChat(tabId);
  await panel(tabId, 'select', { label: SELECT, value: projectId });
  await until(
    () => selection(tabId),
    state => state.value === projectId,
    'second draft selected',
  );
  await newChat(tabId);
  await scriptReplies([{ text: 'This chat starts without a project.' }]);
  await panel(tabId, 'type-send', { text: 'Start a separate investigation.' });
  await waitForText(tabId, 'This chat starts without a project.');
  const id = await runManager.scope.conversationOf(tabId);
  assert(id && !(await getConversation(id))?.projectId, 'discarded draft project does not leak into the new chat');
  const requests = (await (await fetch('http://localhost:8787/__llm/requests')).json()) as unknown[];
  assert(!JSON.stringify(requests.at(-1)).includes(INSTRUCTION), 'unassigned chat has no previous project context');
  await until(
    () => selection(tabId),
    state => !state.disabled,
    'unassigned chat finished',
  );
  await panel(tabId, 'select', { label: SELECT, value: projectId });
  await until(
    () => getConversation(id),
    chat => chat?.projectId === projectId,
    'saved chat can still be assigned',
  );
  return id;
}

defineCheck({
  name: 'panel-project',
  title: 'Project selection before the first chat message',
  description:
    'Creates a project after a fresh panel is open, checks its live dropdown without focus, and verifies new-chat selection, first-request context, reset, and saved-chat assignment.',
  async run() {
    const saved = await chrome.storage.local.get(['nb.settings', 'nb.providers']);
    const initialTabs = new Set((await chrome.tabs.query({})).map(tab => tab.id!));
    const conversations: string[] = [];
    let projectId: string | undefined;
    await chrome.storage.local.set({ 'nb.settings': { ...DEFAULT_SETTINGS, uiLanguage: 'en', onboarded: true } });
    await seedFixtureModel();
    try {
      const target = await chrome.tabs.create({ url: 'http://localhost:8787/c-text.html', active: false });
      await waitForLoad(target.id!);
      const view = await chrome.tabs.create({
        url: chrome.runtime.getURL(`/sidepanel.html#tab=${target.id}`),
        active: true,
      });
      await waitForLoad(view.id!);
      await until(
        () => selection(target.id!),
        state => state.ok,
        'fresh chat project selector loaded',
      );
      assert(!(await selection(target.id!)).options.some(option => option.text === NAME), 'project does not exist yet');
      projectId = await createProject();
      conversations.push(await firstMessage(target.id!, projectId));
      conversations.push(await resetAndAssign(target.id!, projectId));
      return { liveProjectRefresh: true, draftProjectSelected: true, firstRequestContext: true, newChatReset: true };
    } finally {
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id !== undefined && !initialTabs.has(tab.id)) await chrome.tabs.remove(tab.id).catch(() => undefined);
      }
      for (const id of conversations) await deleteConversation(id);
      if (projectId) await (await db()).delete('projects', projectId);
      await chrome.storage.local.remove(['nb.settings', 'nb.providers']);
      await chrome.storage.local.set(saved);
    }
  },
});
