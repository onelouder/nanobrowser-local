import { z } from 'zod';
import { attachmentKind, MAX_CONVERSATION } from '@src/store/attachments';
import {
  appendEntry,
  createConversation,
  getConversation,
  listBlobs,
  updateConversation,
} from '@src/store/conversations';
import { getCheckpoint, listRunHistory } from '@src/store/checkpoints';
import {
  archiveProject,
  assignProject,
  attachProjectArtifacts,
  deleteArtifact,
  getArtifact,
  getProject,
  listArtifacts,
  listProjects,
  listProjectSessions,
  MAX_ARTIFACT_BYTES,
  putArtifact,
  saveProject,
} from '@src/store/projects';
import { exportProjectBundle, importProjectBundle } from '@src/store/project-bundle';
import { settingsStorage } from '@src/store/settings';
import type { Conversation, ProjectArtifact } from '@src/store/types';
import { WORKSPACE_PROJECTS_CHANGED, WORKSPACE_REQUEST } from '@src/ui/workspace-protocol';
import type { ArtifactSummary, WorkspaceCommand } from '@src/ui/workspace-protocol';
import type { RunManager } from './run-manager';
import { collectProjectEvidence } from './workspace-evidence';

const id = z.string().min(1).max(200);
function website(value: string): string {
  if (value.includes('://') && !/^https?:\/\//i.test(value)) throw new Error('Target sites must use HTTP or HTTPS.');
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Target sites must be HTTP or HTTPS addresses without credentials.');
  }
  return url.href;
}

const project = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(120),
  objective: z.string().max(2000),
  targetSites: z.array(z.string().max(2048)).max(100),
  instructions: z.string().max(6000),
  notes: z.string().max(50_000),
  archived: z.boolean(),
});
const model = z.object({
  model: z.object({ providerId: id, model: z.string().min(1).max(500) }),
  reasoning: z.enum(['none', 'low', 'medium', 'high']),
});
const pdf = z
  .object({
    text: z.string().max(1_000_000),
    pages: z.number().int().min(0).max(200),
    totalPages: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .optional();
const commandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }),
  z.object({ op: z.literal('project'), projectId: id }),
  z.object({ op: z.literal('save-project'), project }),
  z.object({ op: z.literal('archive-project'), projectId: id, archived: z.boolean() }),
  z.object({ op: z.literal('assign'), conversationId: id, projectId: id.nullable() }),
  z.object({
    op: z.literal('create-session'),
    projectId: id,
    title: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(20_000),
  }),
  z.object({ op: z.literal('open-session'), conversationId: id, activate: z.boolean().optional() }),
  z.object({ op: z.literal('resume-preview'), conversationId: id }),
  z.object({ op: z.literal('pause'), conversationId: id }),
  z.object({ op: z.literal('collect-evidence'), conversationId: id }),
  z.object({ op: z.literal('resume'), conversationId: id, reopenTabs: z.boolean(), model: model.optional() }),
  z.object({
    op: z.literal('add-artifact'),
    projectId: id,
    name: z.string().min(1).max(240),
    mimeType: z.string().max(255),
    base64: z.string().max(Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4),
    kind: z.enum(['file', 'evidence']),
    sourceUrl: z.string().url().max(8192).optional(),
    pdf,
  }),
  z.object({ op: z.literal('read-artifact'), artifactId: id }),
  z.object({ op: z.literal('delete-artifact'), artifactId: id }),
  z.object({ op: z.literal('attach-artifacts'), conversationId: id, artifactIds: z.array(id).min(1).max(100) }),
  z.object({ op: z.literal('export'), projectId: id }),
  z.object({ op: z.literal('import'), text: z.string().max(50 * 1024 * 1024) }),
]);

function summary({ data: _data, pdf: _pdf, ...rest }: ProjectArtifact): ArtifactSummary {
  return rest;
}

async function projectData(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found.');
  const sessions = await listProjectSessions(projectId);
  const checkpoints = await Promise.all(sessions.map(s => getCheckpoint(s.id)));
  const runs = (await Promise.all(sessions.map(s => listRunHistory(s.id)))).flat();
  return {
    project,
    sessions,
    artifacts: (await listArtifacts(projectId)).map(summary),
    checkpoints: checkpoints.filter(c => c !== undefined),
    runs,
  };
}

function assertIdle(manager: RunManager, conversationId: string): void {
  if (manager.isRunning(conversationId)) throw new Error('Pause this session before changing its project or evidence.');
}

async function createSession(command: Extract<WorkspaceCommand, { op: 'create-session' }>): Promise<Conversation> {
  const project = await getProject(command.projectId);
  if (!project || project.archived) throw new Error('Choose an active project first.');
  const startUrl = project.targetSites[0] ? website(project.targetSites[0]) : undefined;
  const settings = await settingsStorage.get();
  const session = await createConversation({ title: command.title, mode: settings.defaultMode });
  await assignProject(session.id, project.id);
  if (startUrl) {
    await updateConversation(session.id, {
      savedTabs: [{ id: crypto.randomUUID(), url: startUrl, title: project.name, origin: 'start', active: true }],
    });
  }
  await appendEntry(session.id, {
    type: 'message',
    message: { role: 'user', parts: [{ type: 'text', text: command.objective }] },
  });
  return (await getConversation(session.id))!;
}

async function addArtifact(command: Extract<WorkspaceCommand, { op: 'add-artifact' }>) {
  const bytes = Uint8Array.from(atob(command.base64), char => char.charCodeAt(0));
  const data = new Blob([bytes], { type: command.mimeType || 'application/octet-stream' });
  return summary(
    await putArtifact({
      projectId: command.projectId,
      name: command.name,
      mimeType: data.type,
      kind: command.kind,
      data,
      sourceUrl: command.sourceUrl,
      pdf: command.pdf,
    }),
  );
}

async function readArtifact(artifactId: string) {
  const artifact = await getArtifact(artifactId);
  if (!artifact) throw new Error('Artifact not found.');
  const bytes = new Uint8Array(await artifact.data.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { name: artifact.name, mimeType: artifact.mimeType, base64: btoa(binary), pdf: artifact.pdf };
}

async function attachArtifacts(manager: RunManager, conversationId: string, ids: string[]) {
  assertIdle(manager, conversationId);
  const session = await getConversation(conversationId);
  if (!session?.projectId) throw new Error('Assign this session to a project first.');
  const files = await Promise.all([...new Set(ids)].map(getArtifact));
  const artifacts: ProjectArtifact[] = [];
  for (const file of files) {
    if (!file || file.projectId !== session.projectId) throw new Error('Select files from this session’s project.');
    const kind = attachmentKind(file.name, file.mimeType);
    if ('refused' in kind) throw new Error(`${file.name}: ${kind.refused}`);
    if (kind.kind === 'pdf' && !file.pdf) throw new Error(`${file.name}: add the PDF again to extract its text.`);
    artifacts.push(file);
  }
  const bytes = [...(await listBlobs(conversationId)), ...artifacts].reduce((sum, f) => sum + f.size, 0);
  if (bytes > MAX_CONVERSATION) throw new Error('The selected files exceed this session’s 100 MB attachment budget.');
  await attachProjectArtifacts(
    conversationId,
    artifacts.map(a => a.id),
  );
  await manager.workspaceChanged(conversationId);
}

export async function handleWorkspace(manager: RunManager, raw: unknown): Promise<unknown> {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  const command = parsed.data;
  switch (command.op) {
    case 'list':
      return { projects: await listProjects(), sessions: await listProjectSessions() };
    case 'project':
      return projectData(command.projectId);
    case 'save-project':
      return saveProject({ ...command.project, targetSites: command.project.targetSites.map(website) });
    case 'archive-project': {
      const sessions = await listProjectSessions(command.projectId);
      if (command.archived && sessions.some(s => manager.isRunning(s.id)))
        throw new Error('Pause active sessions before archiving.');
      return archiveProject(command.projectId, command.archived);
    }
    case 'assign':
      assertIdle(manager, command.conversationId);
      await assignProject(command.conversationId, command.projectId);
      return manager.workspaceChanged(command.conversationId);
    case 'create-session':
      return createSession(command);
    case 'open-session':
      return manager.workspaceOpen(command.conversationId, command.activate);
    case 'pause':
      return manager.workspacePause(command.conversationId);
    case 'collect-evidence':
      return collectProjectEvidence(command.conversationId);
    case 'resume-preview':
      return manager.workspacePreview(command.conversationId);
    case 'resume':
      return manager.workspaceResume(command.conversationId, command);
    case 'add-artifact':
      return addArtifact(command);
    case 'read-artifact':
      return readArtifact(command.artifactId);
    case 'delete-artifact':
      return deleteArtifact(command.artifactId);
    case 'attach-artifacts':
      return attachArtifacts(manager, command.conversationId, command.artifactIds);
    case 'export':
      return { filename: 'nanobrowser-project.json', text: await exportProjectBundle(command.projectId) };
    case 'import':
      return importProjectBundle(command.text);
  }
}

export function listenForWorkspace(manager: RunManager): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
    if ((message as { type?: string } | null)?.type !== WORKSPACE_REQUEST) return;
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('/'))) return;
    void handleWorkspace(manager, message).then(
      data => {
        if (['save-project', 'archive-project', 'import'].includes((message as { op: string }).op)) {
          void chrome.runtime.sendMessage({ type: WORKSPACE_PROJECTS_CHANGED }).catch(() => undefined);
        }
        reply({ ok: true, data });
      },
      error => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}
