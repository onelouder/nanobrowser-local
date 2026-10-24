import type {
  Checkpoint,
  Conversation,
  LivePair,
  Project,
  ProjectArtifact,
  ResumeConfig,
  RunRecord,
  RunStatus,
  SavedTab,
} from '@src/store/types';
import type { ScopeTab } from './protocol';

export const WORKSPACE_REQUEST = 'nb-workspace';
export type ArtifactSummary = Omit<ProjectArtifact, 'data' | 'pdf'>;
export interface WorkspaceOverview {
  projects: Project[];
  sessions: Conversation[];
}
export interface WorkspaceProjectData {
  project: Project;
  sessions: Conversation[];
  artifacts: ArtifactSummary[];
  checkpoints: Checkpoint[];
  runs: RunRecord[];
}
export type WorkspaceList = WorkspaceOverview;
export type WorkspaceProject = WorkspaceProjectData;

export interface ResumePreview {
  conversationId: string;
  title: string;
  status: RunStatus;
  checkpoint: Checkpoint | null;
  tabs: SavedTab[];
  liveTabs: ScopeTab[];
  model: LivePair | null;
  modelAvailable: boolean;
  missingTabs: number;
  reason?: string;
  currentConfig?: ResumeConfig;
  configurationChanged: boolean;
  blockedTabs: string[];
}
export type WorkspaceCommand =
  | { op: 'list' }
  | { op: 'project'; projectId: string }
  | { op: 'save-project'; project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string } }
  | { op: 'archive-project'; projectId: string; archived: boolean }
  | { op: 'assign'; conversationId: string; projectId: string | null }
  | { op: 'create-session'; projectId: string; title: string; objective: string }
  | { op: 'open-session' | 'resume-preview' | 'pause' | 'collect-evidence'; conversationId: string }
  | { op: 'resume'; conversationId: string; reopenTabs: boolean; model?: LivePair }
  | {
      op: 'add-artifact';
      projectId: string;
      name: string;
      mimeType: string;
      base64: string;
      kind: 'file' | 'evidence';
      sourceUrl?: string;
      pdf?: ProjectArtifact['pdf'];
    }
  | { op: 'read-artifact' | 'delete-artifact'; artifactId: string }
  | { op: 'attach-artifacts'; conversationId: string; artifactIds: string[] }
  | { op: 'export'; projectId: string }
  | { op: 'import'; text: string };

type WorkspaceReply<T> = { ok: true; data: T } | { ok: false; error: string };

export async function requestWorkspace<T>(command: WorkspaceCommand): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ type: WORKSPACE_REQUEST, ...command })) as WorkspaceReply<T>;
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
