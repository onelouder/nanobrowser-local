import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  activeBranch,
  appendEntry,
  createConversation,
  deleteConversation,
  getConversation,
  listBlobs,
} from '@src/store/conversations';
import { closeDb } from '@src/store/db';
import { assignProject, listArtifacts, putArtifact, saveProject } from '@src/store/projects';
import { handleWorkspace } from '../workspace';
import { collectProjectEvidence } from '../workspace-evidence';
import type { RunManager } from '../run-manager';
import type { Conversation } from '@src/store/types';

const manager = { isRunning: vi.fn(() => false), workspaceChanged: vi.fn(async () => {}) } as unknown as RunManager;
const project = () =>
  saveProject({
    name: 'Investigation',
    objective: 'Map interactions',
    targetSites: ['https://example.com/start'],
    instructions: '',
    notes: '',
    archived: false,
  });

afterEach(async () => {
  vi.clearAllMocks();
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('workspace commands', () => {
  it('creates a dormant project session with a portable target page and original task', async () => {
    const p = await project();
    const session = (await handleWorkspace(manager, {
      op: 'create-session',
      projectId: p.id,
      title: 'Checkout',
      objective: 'Inspect checkout states',
    })) as Conversation;
    expect(session).toMatchObject({
      projectId: p.id,
      status: 'idle',
      tabs: [],
      savedTabs: [{ url: 'https://example.com/start', origin: 'start' }],
    });
    expect((await activeBranch(session.id))[0]).toMatchObject({
      type: 'message',
      message: { role: 'user', parts: [{ text: 'Inspect checkout states' }] },
    });
  });

  it('rejects unsupported targets and malformed command arguments', async () => {
    const p = await project();
    await expect(
      handleWorkspace(manager, { op: 'save-project', project: { ...p, targetSites: ['ftp://example.com'] } }),
    ).rejects.toThrow('HTTP');
    await expect(
      handleWorkspace(manager, { op: 'create-session', projectId: p.id, title: '', objective: 'x' }),
    ).rejects.toThrow();
  });

  it('keeps arbitrary file bytes while only attaching readable evidence from the same project', async () => {
    const p = await project();
    const session = await createConversation({ mode: 'ask' });
    await assignProject(session.id, p.id);
    const stored = (await handleWorkspace(manager, {
      op: 'add-artifact',
      projectId: p.id,
      name: 'theme.css',
      mimeType: 'text/css',
      base64: btoa('body { color: red; }'),
      kind: 'file',
    })) as { id: string };
    await handleWorkspace(manager, { op: 'attach-artifacts', conversationId: session.id, artifactIds: [stored.id] });
    expect(await (await listBlobs(session.id))[0].data.text()).toBe('body { color: red; }');
    const other = await project();
    const foreign = await putArtifact({
      projectId: other.id,
      kind: 'file',
      name: 'secret.txt',
      mimeType: 'text/plain',
      data: new Blob(['other project']),
    });
    await expect(
      handleWorkspace(manager, { op: 'attach-artifacts', conversationId: session.id, artifactIds: [foreign.id] }),
    ).rejects.toThrow('this session');
    await deleteConversation(session.id);
    expect(await listArtifacts(p.id)).toHaveLength(1);
  });

  it('refuses project reassignment during execution', async () => {
    const running = { isRunning: () => true } as unknown as RunManager;
    await expect(
      handleWorkspace(running, { op: 'assign', conversationId: 'working', projectId: null }),
    ).rejects.toThrow('Pause');
  });
});

describe('retained project evidence', () => {
  it('copies page captures with source provenance and does not duplicate repeated collections', async () => {
    const p = await project();
    const session = await createConversation({ mode: 'ask' });
    await assignProject(session.id, p.id);
    const capture = await appendEntry(session.id, {
      type: 'message',
      message: {
        role: 'tool',
        parts: [
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'read',
            text: '<<<page-content N>>>Observed state<<<end-page-content N>>>',
            isError: false,
          },
        ],
      },
      result: { page: { url: 'https://example.com/cart' } },
    });
    expect(await collectProjectEvidence(session.id)).toEqual({ saved: 1, considered: 1, limit: 20 });
    const [artifact] = await listArtifacts(p.id);
    expect(artifact).toMatchObject({
      kind: 'evidence',
      entryId: capture.id,
      capturedAt: capture.at,
      sourceUrl: 'https://example.com/cart',
    });
    expect(await artifact.data.text()).toContain('Observed state');
    expect((await collectProjectEvidence(session.id)).saved).toBe(0);
    expect((await getConversation(session.id))?.leafId).toBe(capture.id);
  });
});
