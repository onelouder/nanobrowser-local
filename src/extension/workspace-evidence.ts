import { activeBranch, getConversation } from '@src/store/conversations';
import { listArtifacts, putArtifact } from '@src/store/projects';
import type { EntryOf, ProjectArtifact } from '@src/store/types';

const LIMIT = 20;
const PAGE_TOOLS = new Set(['snapshot', 'read', 'screenshot', 'observe']);

function evidenceEntry(entry: Awaited<ReturnType<typeof activeBranch>>[number]): entry is EntryOf<'message'> {
  return (
    entry.type === 'message' &&
    entry.message.role === 'tool' &&
    entry.message.parts.some(p => p.type === 'tool-result' && !p.isError && PAGE_TOOLS.has(p.toolName))
  );
}

function sourceUrl(entry: EntryOf<'message'>): string | undefined {
  const result = entry.result as { page?: { url?: string } } | undefined;
  return result?.page?.url;
}

function captures(entry: EntryOf<'message'>): Array<{ name: string; mimeType: string; data: Blob }> {
  const files = [];
  for (const part of entry.message.parts) {
    if (part.type === 'tool-result') {
      files.push({
        name: `${part.toolName}-${entry.id}.txt`,
        mimeType: 'text/plain',
        data: new Blob([part.text], { type: 'text/plain' }),
      });
    }
    if (part.type === 'image') {
      const bytes = Uint8Array.from(atob(part.data), char => char.charCodeAt(0));
      files.push({
        name: `screenshot-${entry.id}.${part.mediaType === 'image/jpeg' ? 'jpg' : 'png'}`,
        mimeType: part.mediaType,
        data: new Blob([bytes], { type: part.mediaType }),
      });
    }
  }
  return files;
}

async function keepEntry(projectId: string, entry: EntryOf<'message'>, existing: ProjectArtifact[]): Promise<number> {
  let saved = 0;
  for (const file of captures(entry)) {
    if (existing.some(a => a.entryId === entry.id && a.name === file.name)) continue;
    await putArtifact({
      ...file,
      projectId,
      conversationId: entry.conversationId,
      runId: entry.meta?.runId,
      entryId: entry.id,
      kind: 'evidence',
      sourceUrl: sourceUrl(entry),
      capturedAt: entry.at,
    });
    saved++;
  }
  return saved;
}

export async function collectProjectEvidence(conversationId: string) {
  const session = await getConversation(conversationId);
  if (!session?.projectId) throw new Error('Assign this session to a project first.');
  const entries = (await activeBranch(conversationId)).filter(evidenceEntry).slice(-LIMIT);
  const existing = await listArtifacts(session.projectId);
  let saved = 0;
  for (const entry of entries) saved += await keepEntry(session.projectId, entry, existing);
  return { saved, considered: entries.length, limit: LIMIT };
}
