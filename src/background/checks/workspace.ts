import {
  appendEntry,
  createConversation,
  deleteConversation,
  getConversation,
  getRun,
  listConversations,
} from '@src/store/conversations';
import { db } from '@src/store/db';
import { getCheckpoint, listRunHistory } from '@src/store/checkpoints';
import { getProject, listArtifacts, listProjects, listProjectSessions } from '@src/store/projects';
import { DEFAULT_SETTINGS } from '@src/store/settings';
import type { Project } from '@src/store/types';
import type { WorkspaceCommand } from '@src/ui/workspace-protocol';
import { assert, sleep, waitForLoad } from './helpers';
import { seedFixtureModel, scriptReplies } from './panel-chat';
import { defineCheck } from './registry';

const NAME = 'Workspace fixture investigation';
const TARGET = 'http://localhost:8787/index.html';
const NOTE = 'Preserve the navigation and stylesheet evidence.';
const CSS = 'body { color: rebeccapurple; }';
type PageRead = { ok: boolean; body: string; dialog: string; error?: string };

async function workspace(op: string, extra: Record<string, unknown> = {}): Promise<PageRead> {
  const result = (await chrome.runtime.sendMessage({ nbTest: 'workspace', op, ...extra })) as PageRead;
  assert(result.ok, `workspace ${op}: ${JSON.stringify(extra)} ${result.error ?? ''}`);
  await sleep(100);
  return result;
}

async function rpc<T>(command: WorkspaceCommand): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ nbTest: 'workspace', op: 'workspace-request', command });
  assert(reply.ok, `workspace RPC ${command.op}: ${reply.error ?? ''}`);
  return reply.data as T;
}

async function waitForBody(text: string): Promise<PageRead> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await workspace('read');
    if (result.body.includes(text)) return result;
    await sleep(100);
  }
  throw new Error(`Workspace text did not appear: ${text}. ${(await workspace('read')).body}`);
}

async function createProject(tabId: number): Promise<Project> {
  await workspace('click', { label: 'New project' });
  await workspace('fill', { label: 'Project name', text: NAME });
  await workspace('fill', { label: 'Objective', text: 'Document the fixture site for a cleanroom rebuild.' });
  await workspace('fill', { label: 'Target sites (one per line)', text: TARGET });
  await workspace('fill', { label: 'Project instructions', text: 'Read before changing the site.' });
  await workspace('fill', { label: 'Project notes', text: NOTE });
  await workspace('click', { label: 'Save' });
  await waitForBody('Changes saved.');
  const project = (await listProjects()).find(p => p.name === NAME);
  assert(project, 'project was created');
  await workspace('click', { label: 'Edit project' });
  await workspace('fill', { label: 'Project notes', text: `${NOTE}\nEdited in workspace.` });
  await workspace('click', { label: 'Save' });
  await waitForBody('Edited in workspace.');
  await chrome.tabs.reload(tabId);
  await waitForLoad(tabId);
  await sleep(500);
  await workspace('click', { label: NAME });
  await waitForBody('Edited in workspace.');
  assert((await getProject(project.id))?.notes.endsWith('Edited in workspace.'), 'edited notes persisted');
  return project;
}

async function sessionFlow(project: Project, unassignedId: string): Promise<string> {
  const count = (await listConversations()).filter(c => !c.projectId).length;
  await workspace('click', { label: `Unassigned sessions (${count})` });
  await workspace('select', { label: 'Existing workspace session: Move to project', value: project.id });
  assert((await getConversation(unassignedId))?.projectId === project.id, 'existing session assigned');
  await workspace('click', { label: NAME });
  await workspace('click', { label: 'Sessions' });
  await workspace('click', { label: 'New chat in this project' });
  await waitForBody('Starting task');
  await workspace('click', { label: 'New session' });
  assert(!(await workspace('read')).body.includes('Starting task'), 'new chat form collapsed');
  await workspace('click', { label: 'New chat in this project' });
  await waitForBody('Starting task');
  await workspace('fill', { label: 'Session title', text: 'New investigation session' });
  await workspace('fill', { label: 'Starting task', text: 'Inspect the fixture navigation.' });
  await workspace('fill', { label: 'Starting task', text: 'Inspect the fixture navigation.', submit: true });
  await waitForBody('New investigation session');
  const session = (await listProjectSessions(project.id)).find(c => c.title === 'New investigation session');
  assert(session?.savedTabs?.[0].url === TARGET, 'new session retained project target');
  assert(session.status === 'idle', 'creating a session does not execute');
  return session.id;
}

async function fileFlow(projectId: string): Promise<void> {
  await workspace('click', { label: 'Files' });
  await workspace('upload-files', {
    label: 'Add files',
    files: [{ name: 'cleanroom.css', type: 'text/css', text: CSS }],
  });
  await waitForBody('cleanroom.css');
  await workspace('click', { label: 'Preview' });
  await waitForBody(CSS);
  const file = (await listArtifacts(projectId)).find(a => a.name === 'cleanroom.css');
  assert(file && (await file.data.text()) === CSS, 'CSS upload retained full bytes');
  const read = await rpc<{ base64: string }>({ op: 'read-artifact', artifactId: file.id });
  assert(atob(read.base64) === CSS, 'download payload matches uploaded bytes');
}

async function unreadablePdfFlow(projectId: string, conversationId: string): Promise<void> {
  const original = '%PDF-1.7\nDamaged forensic source file';
  await workspace('upload-files', {
    label: 'Add files',
    files: [{ name: 'damaged.pdf', type: 'application/pdf', text: original }],
  });
  await waitForBody('Original file saved. Text extraction is unavailable.');
  const file = (await listArtifacts(projectId)).find(a => a.name === 'damaged.pdf');
  assert(file && (await file.data.text()) === original, 'unreadable PDF original bytes retained');
  assert(file.pdf === undefined, 'unreadable PDF has no extracted text');
  const reply = await chrome.runtime.sendMessage({
    nbTest: 'workspace',
    op: 'workspace-request',
    command: { op: 'attach-artifacts', conversationId, artifactIds: [file.id] },
  });
  assert(!reply.ok && reply.error.includes('extract its text'), 'unreadable PDF cannot be sent as model evidence');
}

async function evidenceFlow(projectId: string, sessionId: string): Promise<void> {
  const entry = await appendEntry(sessionId, {
    type: 'message',
    message: {
      role: 'tool',
      parts: [
        {
          type: 'tool-result',
          toolCallId: 'workspace-capture',
          toolName: 'read',
          text: 'Fixture navigation evidence',
          isError: false,
        },
      ],
    },
    result: { page: { url: TARGET } },
  });
  await workspace('click', { label: 'Sessions' });
  await workspace('click', { label: 'Save recent evidence' });
  await waitForBody('Saved 1 captures');
  await workspace('click', { label: 'Evidence' });
  await waitForBody(`read-${entry.id}.txt`);
  const artifact = (await listArtifacts(projectId)).find(a => a.entryId === entry.id);
  assert(
    artifact?.sourceUrl === TARGET && artifact.capturedAt === entry.at,
    'evidence source and capture time retained',
  );
}

async function bundleFlow(projectId: string): Promise<string> {
  const bundle = await rpc<{ text: string }>({ op: 'export', projectId });
  await workspace('upload-files', {
    label: 'Import project',
    files: [{ name: 'project.json', type: 'application/json', text: bundle.text }],
  });
  await sleep(300);
  const copy = (await listProjects()).find(p => p.id !== projectId && p.name.startsWith(NAME));
  assert(copy, 'portable bundle imported through file picker');
  assert((await listProjectSessions(copy.id)).length === 2, 'bundle sessions restored');
  assert((await listArtifacts(copy.id)).length === 3, 'bundle files and evidence restored');
  return copy.id;
}

async function openResume(tabId: number, conversationId: string): Promise<void> {
  await chrome.tabs.update(tabId, {
    url: chrome.runtime.getURL(`/workspace.html?conversationId=${conversationId}&resume=1`),
  });
  await waitForLoad(tabId);
  await waitForBody('Resume investigation');
}

async function modelRequests(): Promise<unknown[]> {
  return (await fetch('http://localhost:8787/__llm/requests')).json() as Promise<unknown[]>;
}

async function pauseActive(conversationId: string): Promise<string> {
  for (let attempt = 0; attempt < 50 && !(await modelRequests()).length; attempt++) await sleep(100);
  assert((await modelRequests()).length === 1, 'first model request started');
  await workspace('click', { label: 'Refresh' });
  await workspace('click', { label: 'Sessions' });
  await waitForBody('Pause and save');
  await workspace('click', { label: 'Pause and save' });
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await getConversation(conversationId))?.status === 'suspended') break;
    await sleep(100);
  }
  const checkpoint = await getCheckpoint(conversationId);
  assert(checkpoint?.status === 'suspended', 'pause persisted suspended checkpoint');
  assert(
    checkpoint.tabs.some(tab => tab.url === TARGET),
    'pause saved browser manifest',
  );
  return checkpoint.runId;
}

async function resumeFlow(tabId: number, conversationId: string): Promise<void> {
  await openResume(tabId, conversationId);
  assert((await getConversation(conversationId))?.status === 'idle', 'review does not execute');
  assert((await modelRequests()).length === 0, 'preview made no model requests');
  await workspace('select', { label: 'Model connection', value: 'fixture\u0000fixture-model' });
  await scriptReplies([{ text: 'A response that will be paused.', delayMs: 5000 }]);
  await workspace('click', { label: 'Resume session' });
  const firstRunId = await pauseActive(conversationId);
  const pages = await chrome.tabs.query({ url: TARGET });
  for (const page of pages) await chrome.tabs.remove(page.id!);
  await openResume(tabId, conversationId);
  assert((await getConversation(conversationId))?.status === 'suspended', 'pause survives workspace reload');
  assert((await modelRequests()).length === 1, 'paused review made no new model requests');
  await waitForBody('1 saved tabs are not connected.');
  await scriptReplies([{ text: 'Workspace resume completed.' }]);
  await workspace('click', { label: 'Resume session' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await getConversation(conversationId))?.status === 'done') {
      assert((await getRun(conversationId))?.runId !== firstRunId, 'resume created a new execution attempt');
      assert(
        (await listRunHistory(conversationId)).some(run => run.runId === firstRunId),
        'previous attempt retained',
      );
      return;
    }
    await sleep(100);
  }
  throw new Error(`Explicit resume did not complete: ${JSON.stringify(await getConversation(conversationId))}`);
}

async function cleanup(projectIds: Set<string>, sessionId: string, initialTabs: Set<number>): Promise<void> {
  const database = await db();
  for (const projectId of projectIds) {
    for (const session of await listProjectSessions(projectId)) await deleteConversation(session.id);
    for (const artifact of await listArtifacts(projectId)) await database.delete('artifacts', artifact.id);
    await database.delete('projects', projectId);
  }
  await deleteConversation(sessionId);
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined && !initialTabs.has(tab.id)) await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

defineCheck({
  name: 'workspace',
  title: 'Project workspace and explicit resume',
  description:
    'Creates projects, assigns chats, preserves notes and CSS evidence, imports a bundle, and reviews before resume.',
  async run() {
    const saved = await chrome.storage.local.get(['nb.providers', 'nb.settings']);
    const initialTabs = new Set((await chrome.tabs.query({})).map(t => t.id!));
    const projectIds = new Set<string>();
    await chrome.storage.local.set({ 'nb.settings': { ...DEFAULT_SETTINGS, uiLanguage: 'en', onboarded: true } });
    await seedFixtureModel();
    const existing = await createConversation({ mode: 'ask', title: 'Existing workspace session' });
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('/workspace.html'), active: true });
    try {
      await waitForLoad(tab.id!);
      await waitForBody('New project');
      const project = await createProject(tab.id!);
      projectIds.add(project.id);
      const sessionId = await sessionFlow(project, existing.id);
      await fileFlow(project.id);
      await unreadablePdfFlow(project.id, sessionId);
      await evidenceFlow(project.id, sessionId);
      const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      projectIds.add(await bundleFlow(project.id));
      await resumeFlow(tab.id!, sessionId);
      return {
        projectCreated: true,
        notesPersisted: true,
        existingSessionAssigned: true,
        targetSaved: true,
        cssUploadedAndPreviewed: true,
        unreadablePdfRetained: true,
        evidenceProvenance: true,
        bundleRoundtrip: true,
        previewDidNotRun: true,
        explicitResumeCompleted: true,
        pauseCheckpointPersisted: true,
        missingTabReopened: true,
        executionHistoryRetained: true,
        image,
      };
    } finally {
      await cleanup(projectIds, existing.id, initialTabs);
      await chrome.storage.local.remove(['nb.providers', 'nb.settings']);
      await chrome.storage.local.set(saved);
    }
  },
});
