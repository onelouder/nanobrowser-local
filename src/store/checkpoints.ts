import type { IDBPTransaction } from 'idb';
import { db } from './db';
import type { NanoDB } from './db';
import type { Conversation, RunRecord, SessionCheckpoint } from './types';

type CheckpointTransaction = IDBPTransaction<
  NanoDB,
  ('conversations' | 'runs' | 'checkpoints' | 'entries')[],
  'readwrite'
>;

export function checkpointOf(record: RunRecord, conversation: Conversation): SessionCheckpoint {
  return {
    conversationId: record.conversationId,
    runId: record.runId,
    leafEntryId: conversation.leafId,
    status: record.status,
    reason: record.reason,
    tabs: conversation.savedTabs ?? [],
    config: conversation.resumeConfig,
    debt: record.debt,
    guards: record.guards,
    turns: record.turns,
    usage: record.usage,
    updatedAt: new Date().toISOString(),
  };
}

/** Commit the log position and recovery metadata together; stale attempts cannot replace a newer run. */
export async function writeCheckpoint(
  tx: CheckpointTransaction,
  record: RunRecord,
  conversation: Conversation,
): Promise<SessionCheckpoint | undefined> {
  const current = await tx.objectStore('runs').get(record.conversationId);
  if (current && current.runId !== record.runId) return undefined;
  const checkpoint = checkpointOf(record, conversation);
  await tx.objectStore('runs').put({ ...record, leafEntryId: checkpoint.leafEntryId, updatedAt: checkpoint.updatedAt });
  await tx.objectStore('checkpoints').put(checkpoint);
  await tx
    .objectStore('conversations')
    .put({ ...conversation, status: record.status, updatedAt: checkpoint.updatedAt });
  return checkpoint;
}

export async function saveCheckpoint(record: RunRecord): Promise<SessionCheckpoint | undefined> {
  const tx = (await db()).transaction(['conversations', 'runs', 'checkpoints', 'entries'], 'readwrite');
  const conversation = await tx.objectStore('conversations').get(record.conversationId);
  const checkpoint = conversation ? await writeCheckpoint(tx, record, conversation) : undefined;
  await tx.done;
  return checkpoint;
}

export async function getCheckpoint(conversationId: string): Promise<SessionCheckpoint | undefined> {
  return (await db()).get('checkpoints', conversationId);
}

export async function archiveRun(record: RunRecord): Promise<void> {
  const tx = (await db()).transaction('runHistory', 'readwrite');
  if (!(await tx.store.get(record.runId))) await tx.store.add(record);
  await tx.done;
}

export async function listRunHistory(conversationId: string): Promise<RunRecord[]> {
  const tx = (await db()).transaction('runHistory');
  const range = IDBKeyRange.bound([conversationId, ''], [conversationId, '\uffff']);
  let cursor = await tx.store.index('conversationStartedAt').openCursor(range, 'prev');
  const history: RunRecord[] = [];
  while (cursor && history.length < 100) {
    history.push(cursor.value);
    cursor = await cursor.continue();
  }
  await tx.done;
  return history;
}
