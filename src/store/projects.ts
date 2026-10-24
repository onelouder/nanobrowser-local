import { db } from './db';
import { MAX_CONVERSATION } from './attachments';
import { newId, listConversations } from './conversations';
import type { Conversation, Project, ProjectArtifact, Entry, StoredBlob } from './types';

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 250 * 1024 * 1024;
export type ProjectInput = Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export async function listProjects(): Promise<Project[]> {
  return (await (await db()).getAllFromIndex('projects', 'updatedAt')).reverse();
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await db()).get('projects', id);
}

export async function saveProject(input: ProjectInput): Promise<Project> {
  const database = await db();
  const previous = input.id ? await database.get('projects', input.id) : undefined;
  const now = new Date().toISOString();
  const project = { ...input, id: input.id ?? newId(), createdAt: previous?.createdAt ?? now, updatedAt: now };
  await database.put('projects', project);
  return project;
}

export async function archiveProject(id: string, archived = true): Promise<void> {
  const project = await getProject(id);
  if (!project) throw new Error('Project not found.');
  await saveProject({ ...project, archived });
}

export async function assignProject(conversationId: string, projectId: string | null): Promise<void> {
  const database = await db();
  const tx = database.transaction(['projects', 'conversations'], 'readwrite');
  const conversation = await tx.objectStore('conversations').get(conversationId);
  const project = projectId ? await tx.objectStore('projects').get(projectId) : undefined;
  if (!conversation || (projectId && !project)) throw new Error('Session or project not found.');
  if (project?.archived) throw new Error('Restore the project before adding sessions.');
  const next = { ...conversation, updatedAt: new Date().toISOString() };
  if (projectId) next.projectId = projectId;
  else delete next.projectId;
  await tx.objectStore('conversations').put(next);
  await tx.done;
}

export async function listProjectSessions(projectId?: string | null): Promise<Conversation[]> {
  const all = await listConversations();
  if (projectId === undefined) return all;
  return all.filter(c => (c.projectId ?? null) === projectId);
}

export async function listArtifacts(projectId: string): Promise<ProjectArtifact[]> {
  return (await (await db()).getAllFromIndex('artifacts', 'projectId', projectId)).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function getArtifact(id: string): Promise<ProjectArtifact | undefined> {
  return (await db()).get('artifacts', id);
}

export async function deleteArtifact(id: string): Promise<void> {
  await (await db()).delete('artifacts', id);
}

export async function putArtifact(
  input: Omit<ProjectArtifact, 'id' | 'createdAt' | 'sha256' | 'size'>,
): Promise<ProjectArtifact> {
  if (input.data.size > MAX_ARTIFACT_BYTES) throw new Error('Each project file must be 25 MB or smaller.');
  const digest = await crypto.subtle.digest('SHA-256', await input.data.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const artifact = { ...input, id: newId(), size: input.data.size, sha256, createdAt: new Date().toISOString() };
  const tx = (await db()).transaction(['projects', 'artifacts'], 'readwrite');
  if (!(await tx.objectStore('projects').get(input.projectId))) throw new Error('Project not found.');
  const existing = await tx.objectStore('artifacts').index('projectId').getAll(input.projectId);
  if (existing.length >= 1000) throw new Error('A project can contain at most 1,000 files.');
  if (existing.reduce((n, a) => n + a.size, artifact.size) > MAX_PROJECT_BYTES) {
    throw new Error('This project has reached its 250 MB file budget. Remove files before adding more.');
  }
  await tx.objectStore('artifacts').put(artifact);
  await tx.done;
  return artifact;
}

export async function projectContext(projectId?: string): Promise<string> {
  if (!projectId) return '';
  const project = await getProject(projectId);
  if (!project) return '';
  return [
    `Project: ${project.name.slice(0, 120)}`,
    `Objective: ${project.objective.slice(0, 2_000)}`,
    project.instructions.slice(0, 6_000),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function attachProjectArtifacts(conversationId: string, artifactIds: string[]): Promise<void> {
  const tx = (await db()).transaction(['conversations', 'artifacts', 'blobs', 'entries'], 'readwrite');
  const conversation = await tx.objectStore('conversations').get(conversationId);
  if (!conversation) throw new Error('Session not found.');
  const blobs: StoredBlob[] = [];
  for (const id of artifactIds) {
    const artifact = await tx.objectStore('artifacts').get(id);
    if (!artifact || artifact.projectId !== conversation.projectId) throw new Error('File belongs to another project.');
    blobs.push({
      id: newId(),
      conversationId,
      name: artifact.name,
      mimeType: artifact.mimeType,
      size: artifact.size,
      data: artifact.data,
      pdf: artifact.pdf,
      createdAt: new Date().toISOString(),
    });
  }
  const existing = await tx.objectStore('blobs').index('conversationId').getAll(conversationId);
  if ([...existing, ...blobs].reduce((bytes, blob) => bytes + blob.size, 0) > MAX_CONVERSATION) {
    throw new Error('The selected files exceed this session’s 100 MB attachment budget.');
  }
  const entry: Entry = {
    id: newId(),
    conversationId,
    parentId: conversation.leafId,
    at: new Date().toISOString(),
    type: 'message',
    message: {
      role: 'user',
      parts: [
        { type: 'text', text: 'Use these selected project files as evidence for this investigation.' },
        ...blobs.map(blob => ({
          type: 'attachment' as const,
          id: blob.id,
          name: blob.name,
          mimeType: blob.mimeType,
          size: blob.size,
        })),
      ],
    },
  };
  for (const blob of blobs) await tx.objectStore('blobs').add(blob);
  await tx.objectStore('entries').add(entry);
  await tx.objectStore('conversations').put({ ...conversation, leafId: entry.id, updatedAt: entry.at });
  await tx.done;
}
