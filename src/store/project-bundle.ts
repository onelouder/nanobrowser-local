import { db } from './db';
import { newId } from './conversations';
import type { Entry, Project, ProjectArtifact, RunRecord, SessionCheckpoint, StoredBlob } from './types';
import { bundleSchema } from './project-bundle-schema';
import type { ProjectBundle } from './project-bundle-schema';
import { MAX_PROJECT_BYTES } from './projects';
import { MAX_CONVERSATION } from './attachments';

export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

function portableRun(run: RunRecord) {
  const portable = { ...run, tabs: [], debt: run.debt.map(d => ({ ...d, tabId: -1, state: 'unverifiable' as const })) };
  delete portable.pendingPrompt;
  delete portable.model;
  return portable;
}

function portableCheckpoint(checkpoint: SessionCheckpoint) {
  const portable = {
    ...checkpoint,
    debt: checkpoint.debt.map(d => ({ ...d, tabId: -1, state: 'unverifiable' as const })),
  };
  delete portable.config;
  return portable;
}

function portableEntry(entry: Entry): Entry {
  if (entry.type !== 'ui' || entry.kind !== 'download') return entry;
  const data = entry.data as { name: string; bytes: number };
  return {
    ...entry,
    kind: 'notice',
    data: {
      text: `Saved file: ${data.name} (${data.bytes} bytes). Open retained files from the project workspace.`,
      tone: 'info',
    },
  };
}

async function encodeBlob<T extends StoredBlob | ProjectArtifact>(value: T) {
  const bytes = new Uint8Array(await value.data.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { ...value, data: btoa(binary) };
}

/** Project exports contain records and file bytes, never connection profiles or live approval state. */
export async function exportProjectBundle(projectId: string): Promise<string> {
  const tx = (await db()).transaction([
    'projects',
    'conversations',
    'entries',
    'runs',
    'runHistory',
    'checkpoints',
    'blobs',
    'artifacts',
  ]);
  const project = await tx.objectStore('projects').get(projectId);
  if (!project) throw new Error('Project not found.');
  const sessions = await tx.objectStore('conversations').index('projectId').getAll(projectId);
  const ids = new Set(sessions.map(s => s.id));
  const entries = (
    await Promise.all(sessions.map(s => tx.objectStore('entries').index('conversationId').getAll(s.id)))
  ).flat();
  const runs = (await tx.objectStore('runs').getAll()).filter(r => ids.has(r.conversationId));
  const runHistory = (
    await Promise.all(sessions.map(s => tx.objectStore('runHistory').index('conversationId').getAll(s.id)))
  ).flat();
  const checkpoints = (await tx.objectStore('checkpoints').getAll()).filter(c => ids.has(c.conversationId));
  const blobs = (
    await Promise.all(sessions.map(s => tx.objectStore('blobs').index('conversationId').getAll(s.id)))
  ).flat();
  const artifacts = await tx.objectStore('artifacts').index('projectId').getAll(projectId);
  await tx.done;
  if ([...blobs, ...artifacts].reduce((bytes, file) => bytes + 4 * Math.ceil(file.size / 3), 0) > MAX_BUNDLE_BYTES) {
    throw new Error('Project exports are limited to 50 MB. Remove large files or split the project.');
  }
  const bundle = {
    format: 'nanobrowser-project',
    version: 1,
    exportedAt: new Date().toISOString(),
    project,
    sessions: sessions.map(({ resumeConfig: _config, needsModelSelection: _needs, ...session }) => ({
      ...session,
      tabs: [],
    })),
    entries: entries.map(portableEntry),
    runs: runs.map(portableRun),
    runHistory: runHistory.map(portableRun),
    checkpoints: checkpoints.map(portableCheckpoint),
    blobs: await Promise.all(blobs.map(encodeBlob)),
    artifacts: await Promise.all(artifacts.map(encodeBlob)),
  };
  const text = JSON.stringify(bundleSchema.parse(bundle));
  if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES)
    throw new Error('Project exports are limited to 50 MB. Remove large files or split the project.');
  return text;
}

function checkDepth(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 1_000_000 || current.depth > 64) throw new Error('The project bundle is too complex.');
    if (current.value && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function uniqueIds(values: Array<{ id: string }>, label: string): Set<string> {
  const ids = new Set(values.map(v => v.id));
  if (ids.size !== values.length) throw new Error(`Duplicate ${label} IDs in project bundle.`);
  return ids;
}

function validateEntries(bundle: ProjectBundle, sessions: Set<string>): void {
  const entries = new Map(bundle.entries.map(e => [e.id, e]));
  uniqueIds(bundle.entries, 'entry');
  const completed = new Set<string>();
  for (const entry of bundle.entries) {
    if (!sessions.has(entry.conversationId)) throw new Error('Entry belongs to an unknown session.');
    const path = new Set<string>();
    let at: typeof entry | undefined = entry;
    while (at && !completed.has(at.id)) {
      if (path.has(at.id)) throw new Error('The project contains a cyclic conversation.');
      path.add(at.id);
      const parent: typeof entry | undefined = at.parentId ? entries.get(at.parentId) : undefined;
      if (at.parentId && (!parent || parent.conversationId !== entry.conversationId))
        throw new Error('Invalid conversation parent.');
      at = parent;
    }
    path.forEach(id => completed.add(id));
  }
  for (const session of bundle.sessions) {
    if (session.leafId && entries.get(session.leafId)?.conversationId !== session.id)
      throw new Error('Invalid session history position.');
  }
}

function validateReferences(bundle: ProjectBundle): void {
  const sessions = uniqueIds(bundle.sessions, 'session');
  const blobs = uniqueIds(bundle.blobs, 'attachment');
  uniqueIds(bundle.artifacts, 'artifact');
  uniqueIds(
    bundle.runs.map(r => ({ id: r.conversationId })),
    'current run',
  );
  uniqueIds(
    bundle.runHistory.map(r => ({ id: r.runId })),
    'run history',
  );
  uniqueIds(
    bundle.checkpoints.map(c => ({ id: c.conversationId })),
    'checkpoint',
  );
  const aliases = new Set<string>();
  for (const blob of bundle.blobs) {
    for (const alias of new Set([blob.id, ...(blob.sourceIds ?? [])])) {
      const key = `${blob.conversationId}\0${alias}`;
      if (aliases.has(key)) throw new Error('Ambiguous attachment history reference.');
      aliases.add(key);
    }
  }
  validateEntries(bundle, sessions);
  const entries = new Map(bundle.entries.map(e => [e.id, e]));
  for (const value of [...bundle.sessions, ...bundle.artifacts]) {
    if (value.projectId !== bundle.project.id) throw new Error('Mismatched project membership.');
  }
  for (const value of [...bundle.blobs, ...bundle.runs, ...bundle.runHistory, ...bundle.checkpoints]) {
    if (!sessions.has(value.conversationId)) throw new Error('Unknown session reference.');
  }
  for (const record of [...bundle.runs, ...bundle.runHistory, ...bundle.checkpoints]) {
    if (record.leafEntryId && entries.get(record.leafEntryId)?.conversationId !== record.conversationId)
      throw new Error('Invalid checkpoint history position.');
  }
  for (const entry of bundle.entries) {
    const refs = contextReferences(entry);
    if (refs.some(id => entries.get(id)?.conversationId !== entry.conversationId))
      throw new Error('Invalid context history reference.');
    if (entry.type !== 'message') continue;
    for (const part of entry.message.parts) {
      if (
        part.type === 'attachment' &&
        (!blobs.has(part.id) || bundle.blobs.find(b => b.id === part.id)?.conversationId !== entry.conversationId)
      )
        throw new Error('Missing attachment data.');
    }
  }
}

function contextReferences(entry: ProjectBundle['entries'][number]): string[] {
  if (entry.type === 'context_edit') return [entry.targetId];
  if (entry.type === 'compaction') return [entry.firstKeptId, entry.cutUpTo].filter((id): id is string => !!id);
  return [];
}

function validateFileBudgets(bundle: ProjectBundle): void {
  if (bundle.artifacts.reduce((size, artifact) => size + artifact.size, 0) > MAX_PROJECT_BYTES) {
    throw new Error('The project exceeds its file budget.');
  }
  const sizes = new Map<string, number>();
  for (const blob of bundle.blobs) {
    const size = (sizes.get(blob.conversationId) ?? 0) + blob.size;
    if (size > MAX_CONVERSATION) throw new Error('A session exceeds its attachment budget.');
    sizes.set(blob.conversationId, size);
  }
}

function validateUiEntries(bundle: ProjectBundle): void {
  for (const entry of bundle.entries) {
    if (entry.type !== 'ui') continue;
    const data = entry.data as Record<string, unknown> | null;
    if (entry.kind === 'notice' && (!data || typeof data.text !== 'string')) throw new Error('Invalid notice record.');
    if (entry.kind === 'download' && (!data || typeof data.name !== 'string' || typeof data.bytes !== 'number'))
      throw new Error('Invalid download record.');
  }
}

function parseBundle(text: string): ProjectBundle {
  if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES)
    throw new Error('Project imports are limited to 50 MB.');
  const raw: unknown = JSON.parse(text);
  checkDepth(raw);
  const bundle = bundleSchema.parse(raw);
  validateReferences(bundle);
  validateFileBudgets(bundle);
  validateUiEntries(bundle);
  return bundle;
}

function idMapper(): (id: string) => string {
  const ids = new Map<string, string>();
  return id => {
    if (!ids.has(id)) ids.set(id, newId());
    return ids.get(id)!;
  };
}

function restoredStatus(status: RunRecord['status']): RunRecord['status'] {
  return status === 'running' || status === 'awaiting_user' ? 'interrupted' : status;
}

function importRun(run: ProjectBundle['runs'][number], id: (value: string) => string): RunRecord {
  return {
    ...run,
    conversationId: id(run.conversationId),
    runId: id(run.runId),
    leafEntryId: run.leafEntryId ? id(run.leafEntryId) : null,
    status: restoredStatus(run.status),
    tabs: [],
    debt: run.debt.map(d => ({ ...d, tabId: -1, state: 'unverifiable' })),
    steering: run.steering.map(q => ({ ...q, id: id(q.id), attachments: q.attachments.map(id) })),
  };
}

function importEntry(source: ProjectBundle['entries'][number], id: (value: string) => string): Entry {
  const entry = {
    ...portableEntry(source as Entry),
    id: id(source.id),
    conversationId: id(source.conversationId),
    parentId: source.parentId ? id(source.parentId) : null,
  } as Entry;
  if (entry.type === 'context_edit') entry.targetId = id(entry.targetId);
  if (entry.type === 'compaction') {
    entry.firstKeptId = id(entry.firstKeptId);
    if (entry.cutUpTo) entry.cutUpTo = id(entry.cutUpTo);
  }
  if (entry.type === 'message') {
    entry.message = {
      ...entry.message,
      parts: entry.message.parts.map(p => (p.type === 'attachment' ? { ...p, id: id(p.id) } : p)),
    };
    if (entry.meta?.runId) entry.meta = { ...entry.meta, runId: id(entry.meta.runId) };
  }
  return entry;
}

function decodeBlob(data: string, size: number, mimeType: string): Blob {
  const binary = atob(data);
  if (binary.length !== size) throw new Error('A project file has an incorrect size.');
  return new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))], { type: mimeType });
}

async function importArtifact(
  source: ProjectBundle['artifacts'][number],
  id: (value: string) => string,
): Promise<ProjectArtifact> {
  const data = decodeBlob(source.data, source.size, source.mimeType);
  const hash = await crypto.subtle.digest('SHA-256', await data.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== source.sha256) throw new Error('A project file failed its integrity check.');
  return {
    ...source,
    id: id(source.id),
    projectId: id(source.projectId),
    data,
    ...(source.conversationId ? { conversationId: id(source.conversationId) } : {}),
    ...(source.entryId ? { entryId: id(source.entryId) } : {}),
    ...(source.runId ? { runId: id(source.runId) } : {}),
  };
}

/** Import as a new project; no browser actions, permissions, credentials, or live model binding are restored. */
export async function importProjectBundle(text: string): Promise<Project> {
  const bundle = parseBundle(text);
  const id = idMapper();
  const now = new Date().toISOString();
  const project: Project = { ...bundle.project, id: id(bundle.project.id), archived: false, updatedAt: now };
  const blobs = bundle.blobs.map(b => {
    const sourceIds = [...new Set([b.id, ...(b.sourceIds ?? [])])];
    if (sourceIds.length > 100) throw new Error('This attachment has reached the 100-transfer history limit.');
    return {
      ...b,
      id: id(b.id),
      conversationId: id(b.conversationId),
      sourceIds,
      data: decodeBlob(b.data, b.size, b.mimeType),
    };
  });
  const artifacts = await Promise.all(bundle.artifacts.map(a => importArtifact(a, id)));
  const tx = (await db()).transaction(
    ['projects', 'conversations', 'entries', 'blobs', 'artifacts', 'runs', 'runHistory', 'checkpoints'],
    'readwrite',
  );
  await tx.objectStore('projects').add(project);
  for (const session of bundle.sessions)
    await tx.objectStore('conversations').add({
      ...session,
      id: id(session.id),
      projectId: project.id,
      leafId: session.leafId ? id(session.leafId) : null,
      mode: 'ask',
      tabs: [],
      needsModelSelection: true,
      status: restoredStatus(session.status),
      savedTabs: session.savedTabs?.map(tab => ({ ...tab, id: id(tab.id) })),
    });
  for (const entry of bundle.entries) await tx.objectStore('entries').add(importEntry(entry, id));
  for (const blob of blobs) await tx.objectStore('blobs').add(blob);
  for (const artifact of artifacts) await tx.objectStore('artifacts').add(artifact);
  for (const run of bundle.runs) await tx.objectStore('runs').add(importRun(run, id));
  for (const run of bundle.runHistory) await tx.objectStore('runHistory').add(importRun(run, id));
  for (const checkpoint of bundle.checkpoints)
    await tx.objectStore('checkpoints').add({
      ...checkpoint,
      conversationId: id(checkpoint.conversationId),
      runId: id(checkpoint.runId),
      leafEntryId: checkpoint.leafEntryId ? id(checkpoint.leafEntryId) : null,
      status: restoredStatus(checkpoint.status),
      tabs: checkpoint.tabs.map(tab => ({ ...tab, id: id(tab.id) })),
      debt: checkpoint.debt.map(d => ({ ...d, tabId: -1, state: 'unverifiable' })),
    });
  await tx.done;
  return project;
}
