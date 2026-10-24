import { runManager } from '@src/extension/index';
import {
  activeBranch,
  appendEntry,
  createConversation,
  deleteConversation,
  getConversation,
  listBlobs,
} from '@src/store/conversations';
import { db } from '@src/store/db';
import { assignProject, listArtifacts, saveProject } from '@src/store/projects';
import { DEFAULT_SETTINGS } from '@src/store/settings';
import { assert, sleep, waitForLoad } from './helpers';
import { panel, scriptReplies, seedFixtureModel, waitForText } from './panel-chat';
import { defineCheck } from './registry';

const PROJECT = 'Oculus workspace chat';
const ORIGINAL = 'Existing website investigation';
const OTHER = 'Unrelated session marker';
const RESPONSE = 'All four project documents are available; continuing from gaps.';
const FILES = [1, 2, 3, 4].map(index => ({
  name: `oculus-cleanroom-0${index}${index === 4 ? '-gaps' : ''}.md`,
  type: 'text/markdown',
  text: `# Investigation ${index}\noculus-evidence-marker-${index}`,
}));
type PageRead = {
  ok: boolean;
  body: string;
  transcript: string;
  input: string;
  inputDisabled?: boolean;
  error?: string;
};

async function workspace(op: string, extra: Record<string, unknown> = {}): Promise<PageRead> {
  const result = (await chrome.runtime.sendMessage({ nbTest: 'workspace', op, ...extra })) as PageRead;
  assert(result.ok, `workspace ${op}: ${result.error ?? JSON.stringify(extra)}`);
  await sleep(100);
  return result;
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const result = await read();
    if (matches(result)) return result;
    await sleep(100);
  }
  throw new Error(`${label}: ${JSON.stringify(await read())}`);
}

async function prepareSessions() {
  const project = await saveProject({
    name: PROJECT,
    objective: 'Continue the website build',
    targetSites: [],
    instructions: '',
    notes: '',
    archived: false,
  });
  const current = await createConversation({ mode: 'ask', title: 'Oculus working chat' });
  const other = await createConversation({ mode: 'ask', title: 'Separate investigation' });
  for (const [conversationId, text] of [
    [current.id, ORIGINAL],
    [other.id, OTHER],
  ]) {
    await appendEntry(conversationId, { type: 'message', message: { role: 'user', parts: [{ type: 'text', text }] } });
  }
  await assignProject(other.id, project.id);
  return { project, current, other };
}

async function connectExistingChat(
  projectId: string,
  conversationId: string,
  targetId: number,
): Promise<chrome.tabs.Tab> {
  const view = await chrome.tabs.create({
    url: chrome.runtime.getURL(`/workspace.html?projectId=${projectId}`),
    active: true,
  });
  await waitForLoad(view.id!);
  await until(
    () => workspace('read'),
    read => read.body.includes('Link existing chat'),
    'link action',
  );
  await workspace('select', { label: 'Existing chat', value: conversationId });
  await workspace('click', { label: 'Link existing chat' });
  await until(
    () => panel(targetId, 'read'),
    read => read.body.includes(`Project: ${PROJECT}`),
    'side panel project badge',
  );
  await until(
    () => workspace('read'),
    read => read.transcript.includes(ORIGINAL),
    'existing chat transcript',
  );
  assert((await getConversation(conversationId))?.projectId === projectId, 'same conversation joined project');
  assert((await chrome.tabs.get(view.id!)).active, 'opening embedded chat retained workspace focus');
  assert((await runManager.scope.conversationOf(view.id!)) === null, 'workspace tab was not shared with agent');
  assert(
    (await runManager.scope.conversationOf(targetId)) === conversationId,
    'website remains bound to original chat',
  );
  return view;
}

async function linkFromSidePanel(projectId: string, conversationId: string, targetId: number): Promise<void> {
  await until(
    () => panel(targetId, 'read'),
    read => read.body.includes(PROJECT),
    'project selector loaded',
  );
  await panel(targetId, 'select', { label: 'Project for this chat', value: projectId });
  await until(
    () => getConversation(conversationId),
    value => value?.projectId === projectId,
    'side panel linked existing chat',
  );
  await until(
    () => panel(targetId, 'read'),
    read => read.body.includes(`Project: ${PROJECT}`),
    'side panel assignment label',
  );
  await panel(targetId, 'select', { label: 'Project for this chat', value: '' });
  await until(
    () => getConversation(conversationId),
    value => !value?.projectId,
    'side panel unlinked existing chat',
  );
  await waitForText(targetId, ORIGINAL);
}

async function attachDocuments(conversationId: string, targetId: number): Promise<void> {
  await workspace('click', { label: 'Files' });
  await workspace('upload-files', { label: 'Add files', files: FILES });
  await until(
    () => workspace('read'),
    read => FILES.every(file => read.body.includes(file.name)),
    'uploaded documents',
  );
  for (const file of FILES) await workspace('toggle', { label: `Select ${file.name}` });
  await workspace('select', { label: 'Select a session', value: conversationId });
  await workspace('click', { label: 'Add selected to session' });
  await until(
    () => workspace('read'),
    read => FILES.every(file => read.transcript.includes(file.name)),
    'attached chat documents',
  );
  await until(
    () => panel(targetId, 'read'),
    read => FILES.every(file => read.transcript.includes(file.name)),
    'side panel attachment refresh',
  );
  assert((await listBlobs(conversationId)).length === 4, 'all four files belong to selected conversation');
}

async function continueChat(targetId: number): Promise<void> {
  await scriptReplies([{ text: RESPONSE }]);
  await workspace('type-send', { text: 'Read all four project documents and continue from 04-gaps.md.' });
  await until(
    () => workspace('read'),
    read => read.transcript.includes(RESPONSE),
    'workspace model reply',
  );
  await waitForText(targetId, RESPONSE);
  const requests = (await (await fetch('http://localhost:8787/__llm/requests')).json()) as unknown[];
  assert(requests.length === 1, 'one model request sent for workspace chat');
  const request = JSON.stringify(requests[0]);
  for (const file of FILES) {
    assert(request.includes(file.name), `model received ${file.name} identifier`);
    assert(request.includes(file.text.split('\n')[1]), `model received ${file.name} content after follow-up prompt`);
  }
}

async function resumeClosedTarget(conversationId: string, targetId: number): Promise<void> {
  await scriptReplies([{ text: 'Paused before completion.', delayMs: 5000 }]);
  await workspace('type-send', { text: 'Pause this follow-up for the recovery check.' });
  await until(
    () => workspace('read'),
    read => read.body.includes('Pause and save'),
    'running pause control',
  );
  await workspace('click', { label: 'Pause and save' });
  await until(
    () => getConversation(conversationId),
    value => value?.status === 'suspended',
    'saved pause',
  );
  await chrome.tabs.remove(targetId);
  await workspace('click', { label: 'Review and resume' });
  await until(
    () => workspace('read'),
    read => read.body.includes('1 saved tabs are not connected.'),
    'missing target review',
  );
  await scriptReplies([{ text: 'Recovered the original investigation.' }]);
  await workspace('click', { label: 'Resume session' });
  await until(
    () => workspace('read'),
    read => read.transcript.includes('Recovered the original investigation.'),
    'resumed chat',
  );
  const targets = await runManager.scope.tabsOf(conversationId);
  assert(targets.length === 1 && targets[0] !== targetId, 'resume reopened target with a fresh tab ID');
  await scriptReplies([{ text: 'Follow-up reached the reopened website session.' }]);
  await workspace('type-send', { text: 'Continue after reopening the website.' });
  await until(
    () => workspace('read'),
    read => read.transcript.includes('Follow-up reached the reopened website session.'),
    'follow-up after tab recovery',
  );
}

async function checkIsolation(otherId: string, currentId: string): Promise<void> {
  await workspace('select', { label: 'Select a session', value: otherId });
  const read = await until(
    () => workspace('read'),
    value => value.transcript.includes(OTHER),
    'second chat transcript',
  );
  assert(!read.transcript.includes(RESPONSE), 'second chat did not display the first reply');
  assert(!read.transcript.includes(FILES[0].name), 'second chat did not display attached files');
  assert((await listBlobs(otherId)).length === 0, 'second chat has no project attachments');
  assert(!JSON.stringify(await activeBranch(otherId)).includes(RESPONSE), 'second chat history remains separate');
  await workspace('select', { label: 'Select a session', value: currentId });
  await until(
    () => workspace('read'),
    value => value.transcript.includes(RESPONSE),
    'return to original chat',
  );
}

async function cleanup(projectId: string, conversations: string[], initialTabs: Set<number>): Promise<void> {
  for (const conversationId of conversations) await runManager.workspacePause(conversationId);
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined && !initialTabs.has(tab.id)) await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
  for (const conversationId of conversations) await deleteConversation(conversationId);
  const database = await db();
  for (const artifact of await listArtifacts(projectId)) await database.delete('artifacts', artifact.id);
  await database.delete('projects', projectId);
}

defineCheck({
  name: 'workspace-chat',
  title: 'Workspace and side-panel conversation handoff',
  description:
    'Links an existing chat to a project, attaches four documents, continues in embedded chat, and checks both views and session isolation.',
  async run() {
    const saved = await chrome.storage.local.get(['nb.providers', 'nb.settings']);
    const initialTabs = new Set((await chrome.tabs.query({})).map(tab => tab.id!));
    await chrome.storage.local.set({ 'nb.settings': { ...DEFAULT_SETTINGS, uiLanguage: 'en', onboarded: true } });
    await seedFixtureModel();
    const { project, current, other } = await prepareSessions();
    try {
      const target = await chrome.tabs.create({
        url: 'http://localhost:8787/index.html?workspace-chat',
        active: false,
      });
      await waitForLoad(target.id!);
      const bound = await runManager.scope.add(current.id, target.id!, 'start');
      assert(bound.ok, 'starting website belongs to existing chat');
      const side = await chrome.tabs.create({
        url: chrome.runtime.getURL(`/sidepanel.html#tab=${target.id}`),
        active: true,
      });
      await waitForLoad(side.id!);
      await waitForText(target.id!, ORIGINAL);
      await linkFromSidePanel(project.id, current.id, target.id!);
      const view = await connectExistingChat(project.id, current.id, target.id!);
      await attachDocuments(current.id, target.id!);
      await continueChat(target.id!);
      await checkIsolation(other.id, current.id);
      await resumeClosedTarget(current.id, target.id!);
      assert((await chrome.tabs.get(view.id!)).active, 'chat actions do not steal workspace focus');
      return {
        existingChatLinked: true,
        sidePanelLinkAndUnlink: true,
        projectLinkWithoutChatUrl: true,
        sidePanelRefreshed: true,
        fourDocumentsRead: true,
        followUpPromptReceivedFiles: true,
        sessionIsolation: true,
        workspaceNotControlled: true,
        recoveredChatRemainedConnected: true,
        image: await chrome.tabs.captureVisibleTab(view.windowId, { format: 'png' }),
      };
    } finally {
      await cleanup(project.id, [current.id, other.id], initialTabs);
      await chrome.storage.local.remove(['nb.providers', 'nb.settings']);
      await chrome.storage.local.set(saved);
    }
  },
});
