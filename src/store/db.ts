// The IndexedDB schema, through `idb`. Versions migrate in place: each step of `upgrade` takes the database from one
// version to the next.
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type {
  Conversation,
  Entry,
  RunRecord,
  StoredBlob,
  StoredShortcut,
  Project,
  SessionCheckpoint,
  ProjectArtifact,
} from './types';

export interface NanoDB extends DBSchema {
  conversations: { key: string; value: Conversation; indexes: { updatedAt: string; projectId: string } };
  entries: { key: string; value: Entry; indexes: { conversationId: string } };
  runs: { key: string; value: RunRecord; indexes: { status: string } };
  blobs: { key: string; value: StoredBlob; indexes: { conversationId: string } };
  shortcuts: { key: string; value: StoredShortcut };
  projects: { key: string; value: Project; indexes: { updatedAt: string } };
  checkpoints: { key: string; value: SessionCheckpoint };
  runHistory: {
    key: string;
    value: RunRecord;
    indexes: { conversationId: string; conversationStartedAt: [string, string] };
  };
  artifacts: { key: string; value: ProjectArtifact; indexes: { projectId: string; conversationId: string } };
}

export const DB_NAME = 'nanobrowser';
export const DB_VERSION = 2;

let opening: Promise<IDBPDatabase<NanoDB>> | null = null;

export function db(): Promise<IDBPDatabase<NanoDB>> {
  opening ??= openDB<NanoDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        database.createObjectStore('conversations', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        database.createObjectStore('entries', { keyPath: 'id' }).createIndex('conversationId', 'conversationId');
        database.createObjectStore('runs', { keyPath: 'conversationId' }).createIndex('status', 'status');
        database.createObjectStore('blobs', { keyPath: 'id' }).createIndex('conversationId', 'conversationId');
        database.createObjectStore('shortcuts', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        transaction.objectStore('conversations').createIndex('projectId', 'projectId');
        database.createObjectStore('projects', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
        database.createObjectStore('checkpoints', { keyPath: 'conversationId' });
        const history = database.createObjectStore('runHistory', { keyPath: 'runId' });
        history.createIndex('conversationId', 'conversationId');
        history.createIndex('conversationStartedAt', ['conversationId', 'startedAt']);
        const artifacts = database.createObjectStore('artifacts', { keyPath: 'id' });
        artifacts.createIndex('projectId', 'projectId');
        artifacts.createIndex('conversationId', 'conversationId');
      }
    },
    blocking() {
      // A newer version is waiting: let it open.
      void opening?.then(d => d.close());
      opening = null;
    },
  });
  return opening;
}

/** For tests: forget the open connection. */
export async function closeDb(): Promise<void> {
  const current = opening;
  opening = null;
  if (current) (await current).close();
}
