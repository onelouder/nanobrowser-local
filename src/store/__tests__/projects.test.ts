import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { closeDb, db, DB_NAME } from '../db';
import {
  appendEntry,
  createConversation,
  deleteConversation,
  getBlobForConversation,
  getConversation,
  getEntries,
  getRun,
  listBlobs,
  putRun,
  putBlob,
  updateConversation,
} from '../conversations';
import {
  archiveProject,
  assignProject,
  attachProjectArtifacts,
  getProject,
  listArtifacts,
  listProjects,
  listProjectSessions,
  projectContext,
  putArtifact,
  saveProject,
} from '../projects';
import { archiveRun, getCheckpoint, listRunHistory, saveCheckpoint } from '../checkpoints';
import { exportProjectBundle, importProjectBundle } from '../project-bundle';
import { EMPTY_GUARDS, ZERO_USAGE } from '../types';
import type { RunRecord } from '../types';
import { MAX_FILE } from '../attachments';

const project = () =>
  saveProject({
    name: 'Site audit',
    objective: 'Map checkout',
    targetSites: ['example.com'],
    instructions: 'Keep citations.',
    notes: 'Private working notes',
    archived: false,
  });
const run = (conversationId: string): RunRecord => ({
  conversationId,
  runId: 'r1',
  leafEntryId: null,
  status: 'running',
  steering: [],
  turns: 3,
  usage: ZERO_USAGE,
  debt: [],
  guards: EMPTY_GUARDS,
  tabs: [91],
  startedAt: '2026-01-01',
  updatedAt: '2026-01-01',
});

afterEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('project storage', () => {
  it('migrates version one without losing existing conversations', async () => {
    const legacy = await openDB(DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore('conversations', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        for (const name of ['entries', 'blobs'])
          database.createObjectStore(name, { keyPath: 'id' }).createIndex('conversationId', 'conversationId');
        database.createObjectStore('runs', { keyPath: 'conversationId' }).createIndex('status', 'status');
        database.createObjectStore('shortcuts', { keyPath: 'id' });
      },
    });
    await legacy.put('conversations', {
      id: 'old',
      title: 'Existing',
      leafId: null,
      mode: 'ask',
      tabs: [],
      status: 'idle',
      createdAt: '',
      updatedAt: '',
    });
    legacy.close();
    expect((await listProjectSessions(null)).map(c => c.id)).toEqual(['old']);
    expect((await db()).version).toBe(2);
    expect(await listProjects()).toEqual([]);
  });

  it('assigns sessions, bounds project context, and archives without deleting history', async () => {
    const p = await project();
    const c = await createConversation({ mode: 'ask' });
    await assignProject(c.id, p.id);
    expect((await listProjectSessions(p.id))[0].id).toBe(c.id);
    expect(await projectContext(p.id)).toContain('Keep citations.');
    expect(await projectContext(p.id)).not.toContain('Private working notes');
    await archiveProject(p.id);
    await expect(assignProject(c.id, p.id)).rejects.toThrow('Restore');
    expect((await getProject(p.id))?.archived).toBe(true);
    expect(await getConversation(c.id)).toBeDefined();
  });

  it('serializes concurrent attachments against the session byte budget without partial writes', async () => {
    const p = await project();
    const c = await createConversation({ mode: 'ask' });
    await assignProject(c.id, p.id);
    const full = new Blob([new Uint8Array(MAX_FILE)]);
    for (let i = 0; i < 4; i++) {
      const data = i === 3 ? full.slice(1) : full;
      await putBlob({
        id: `existing-${i}`,
        conversationId: c.id,
        name: `part-${i}.txt`,
        mimeType: 'text/plain',
        size: data.size,
        data,
        createdAt: '',
      });
    }
    const artifact = await putArtifact({
      projectId: p.id,
      kind: 'file',
      name: 'last.txt',
      mimeType: 'text/plain',
      data: new Blob(['x']),
    });
    const results = await Promise.allSettled([
      attachProjectArtifacts(c.id, [artifact.id]),
      attachProjectArtifacts(c.id, [artifact.id]),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await listBlobs(c.id)).toHaveLength(5);
    expect(await getEntries(c.id)).toHaveLength(1);
    expect((await getConversation(c.id))?.leafId).toBe((await getEntries(c.id))[0].id);
  });

  it('attaches selected artifacts atomically and retains project files when deleting a session', async () => {
    const p = await project();
    const c = await createConversation({ mode: 'ask' });
    await assignProject(c.id, p.id);
    const a = await putArtifact({
      projectId: p.id,
      conversationId: c.id,
      kind: 'file',
      name: 'styles.css',
      mimeType: 'text/css',
      data: new Blob(['body { color: red; }']),
    });
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(attachProjectArtifacts(c.id, [a.id, 'missing'])).rejects.toThrow();
    expect(await listBlobs(c.id)).toEqual([]);
    expect(await getEntries(c.id)).toEqual([]);
    await attachProjectArtifacts(c.id, [a.id]);
    expect(await listBlobs(c.id)).toHaveLength(1);
    expect(await getEntries(c.id)).toHaveLength(1);
    await saveCheckpoint(run(c.id));
    await archiveRun({ ...run(c.id), status: 'done' });
    await deleteConversation(c.id);
    expect(await getCheckpoint(c.id)).toBeUndefined();
    expect(await listRunHistory(c.id)).toEqual([]);
    expect(await listArtifacts(p.id)).toHaveLength(1);
  });
});

describe('durable checkpoints', () => {
  it('commits a result, log position and recovery counters in one transaction', async () => {
    const c = await createConversation({ mode: 'ask' });
    const record = run(c.id);
    await putRun(record);
    const entry = await appendEntry(
      c.id,
      {
        type: 'message',
        message: {
          role: 'tool',
          parts: [{ type: 'tool-result', toolCallId: 't', toolName: 'snapshot', text: 'page', isError: false }],
        },
      },
      { checkpoint: record },
    );
    expect((await getCheckpoint(c.id))?.leafEntryId).toBe(entry.id);
    expect((await getRun(c.id))?.leafEntryId).toBe(entry.id);
    expect((await getConversation(c.id))?.leafId).toBe(entry.id);
    await putRun({ ...record, runId: 'r2' });
    expect(await saveCheckpoint({ ...record, turns: 99 })).toBeUndefined();
    expect((await getRun(c.id))?.runId).toBe('r2');
  });

  it('archives attempts once and reads only the newest hundred', async () => {
    const c = await createConversation({ mode: 'ask' });
    for (let i = 0; i < 102; i++)
      await archiveRun({ ...run(c.id), runId: `r${i}`, status: 'done', startedAt: String(i).padStart(4, '0') });
    await archiveRun({ ...run(c.id), runId: 'r101', status: 'failed', startedAt: '0101' });
    const history = await listRunHistory(c.id);
    expect(history).toHaveLength(100);
    expect(history[0]).toMatchObject({ runId: 'r101', status: 'done' });
  });
});

async function populated() {
  const p = await project();
  const c = await createConversation({ mode: 'auto' });
  await assignProject(c.id, p.id);
  await updateConversation(c.id, {
    resumeConfig: {
      model: { providerId: 'private-lan', model: 'local' },
      reasoning: 'high',
      turnCap: 100,
      errorCap: 5,
      noEffectCap: 3,
      contextWindow: 150000,
      maxOutput: 32000,
    },
    savedTabs: [{ id: 'logical', url: 'https://example.com/cart', title: 'Cart', origin: 'start' }],
  });
  const a = await putArtifact({
    projectId: p.id,
    kind: 'file',
    name: 'data.bin',
    mimeType: 'application/octet-stream',
    data: new Blob([new Uint8Array([0, 255, 12, 33])]),
  });
  await attachProjectArtifacts(c.id, [a.id]);
  const b = (await listBlobs(c.id))[0];
  await appendEntry(c.id, {
    type: 'message',
    message: { role: 'user', parts: [{ type: 'text', text: `Read ${b.id} exactly as written — 日本語` }] },
  });
  await saveCheckpoint({
    ...run(c.id),
    pendingPrompt: { kind: 'write-card', request: { secret: 'live approval' }, openedAt: '' },
  });
  return { p, c, b };
}

describe('portable project bundles', () => {
  it('round-trips files and history with fresh identities, no live bindings, and scoped aliases', async () => {
    const { p, c, b } = await populated();
    const serialized = await exportProjectBundle(p.id);
    expect(serialized).not.toContain('private-lan');
    expect(serialized).not.toContain('live approval');
    const imported = await importProjectBundle(serialized);
    const [session] = await listProjectSessions(imported.id);
    expect(imported.id).not.toBe(p.id);
    expect(session.id).not.toBe(c.id);
    expect(session).toMatchObject({ mode: 'ask', tabs: [], needsModelSelection: true, status: 'interrupted' });
    expect(session.resumeConfig).toBeUndefined();
    expect(await (await getBlobForConversation(b.id, session.id))?.data.arrayBuffer()).toEqual(
      await b.data.arrayBuffer(),
    );
    const second = await importProjectBundle(await exportProjectBundle(imported.id));
    const [again] = await listProjectSessions(second.id);
    expect(await (await getBlobForConversation(b.id, again.id))?.data.arrayBuffer()).toEqual(
      await b.data.arrayBuffer(),
    );
    expect(JSON.stringify(await getEntries(again.id))).toContain(`Read ${b.id} exactly as written — 日本語`);
    expect(await getBlobForConversation(b.id, 'unrelated')).toBeUndefined();
  });

  it('removes machine-specific download actions and preserves capture provenance', async () => {
    const { p, c } = await populated();
    await appendEntry(c.id, {
      type: 'ui',
      kind: 'download',
      data: { name: 'styles.css', bytes: 10, downloadId: 12345 },
    });
    await putArtifact({
      projectId: p.id,
      kind: 'evidence',
      name: 'capture.txt',
      mimeType: 'text/plain',
      data: new Blob(['observed']),
      sourceUrl: 'https://example.com/cart',
      capturedAt: '2026-01-01T00:00:00Z',
    });
    const exported = await exportProjectBundle(p.id);
    expect(exported).not.toContain('"downloadId":12345');
    const imported = await importProjectBundle(exported);
    const [session] = await listProjectSessions(imported.id);
    expect((await getEntries(session.id)).some(e => e.type === 'ui' && e.kind === 'download')).toBe(false);
    expect((await listArtifacts(imported.id)).find(a => a.kind === 'evidence')?.capturedAt).toBe(
      '2026-01-01T00:00:00Z',
    );
  });

  it('rejects invalid histories and corrupted artifacts before writing any project', async () => {
    const { p } = await populated();
    const original = JSON.parse(await exportProjectBundle(p.id));
    const bad = structuredClone(original);
    bad.entries[0].parentId = bad.entries[0].id;
    await expect(importProjectBundle(JSON.stringify(bad))).rejects.toThrow(/cyclic/);
    const corrupt = structuredClone(original);
    corrupt.artifacts[0].data = btoa('oops');
    await expect(importProjectBundle(JSON.stringify(corrupt))).rejects.toThrow(/integrity/);
    const missing = structuredClone(original);
    missing.blobs = [];
    await expect(importProjectBundle(JSON.stringify(missing))).rejects.toThrow(/attachment/);
    expect(await listProjects()).toHaveLength(1);
  });
});
