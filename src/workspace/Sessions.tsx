import { useState } from 'react';
import type { Checkpoint, Conversation, Project, RunRecord } from '@src/store/types';
import { Button, Field, Input, Select } from '@src/ui/components';
import { t } from '@src/ui/i18n';
import { requestWorkspace } from '@src/ui/workspace-protocol';

export type RunAction = (operation: () => Promise<void>) => Promise<void>;

export function NewSession({
  projectId,
  busy,
  run,
  onCreated,
}: {
  projectId: string;
  busy: boolean;
  run: RunAction;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  return (
    <details className="rounded-xl border border-nb-border bg-nb-bg p-4">
      <summary className="cursor-pointer font-medium">{t('workspace.newSession')}</summary>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            const session = await requestWorkspace<Conversation>({ op: 'create-session', projectId, title, objective });
            onCreated(session.id);
            setTitle('');
            setObjective('');
          });
        }}>
        <Field label={t('workspace.sessionTitle')}>
          <Input
            aria-label={t('workspace.sessionTitle')}
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={120}
            required
          />
        </Field>
        <Field label={t('workspace.sessionObjective')}>
          <textarea
            className="min-h-24 w-full rounded-lg border border-nb-border bg-nb-bg p-2 text-sm focus:outline-nb-accent"
            aria-label={t('workspace.sessionObjective')}
            value={objective}
            onChange={e => setObjective(e.target.value)}
            maxLength={20000}
            required
          />
        </Field>
        <Button type="submit" className="self-start" disabled={busy || !title.trim() || !objective.trim()}>
          {t('workspace.newSession')}
        </Button>
      </form>
    </details>
  );
}

export function Sessions({
  sessions,
  projects,
  checkpoints,
  runs,
  busy,
  run,
  onResume,
  onOpen,
}: {
  sessions: Conversation[];
  projects: Project[];
  checkpoints: Checkpoint[];
  runs: RunRecord[];
  busy: boolean;
  run: RunAction;
  onResume: (conversationId: string) => void;
  onOpen: (conversationId: string) => void;
}) {
  if (!sessions.length) return <p className="text-sm text-nb-muted">{t('workspace.noSessions')}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {sessions.map(session => (
        <SessionRow
          key={session.id}
          session={session}
          projects={projects}
          checkpoint={checkpoints.find(c => c.conversationId === session.id)}
          runs={runs.filter(r => r.conversationId === session.id)}
          busy={busy}
          run={run}
          onResume={() => onResume(session.id)}
          onOpen={() => onOpen(session.id)}
        />
      ))}
    </ul>
  );
}

function SessionRow({
  session,
  projects,
  checkpoint,
  runs,
  busy,
  run,
  onResume,
  onOpen,
}: {
  session: Conversation;
  projects: Project[];
  checkpoint?: Checkpoint;
  runs: RunRecord[];
  busy: boolean;
  run: RunAction;
  onResume: () => void;
  onOpen: () => void;
}) {
  const active = session.status === 'running' || session.status === 'awaiting_user';
  const [collected, setCollected] = useState<number | null>(null);
  return (
    <li className="rounded-xl border border-nb-border bg-nb-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-medium">{session.title || t('history.untitled')}</h3>
          <p className="mt-1 text-sm text-nb-muted">
            {t(`status.${session.status}`)} · {new Date(session.updatedAt).toLocaleString()}
          </p>
        </div>
        <Select
          aria-label={`${session.title}: ${t('workspace.assign')}`}
          value={session.projectId ?? ''}
          disabled={busy || active}
          onChange={e => {
            const projectId = e.target.value || null;
            void run(async () => {
              await requestWorkspace({ op: 'assign', conversationId: session.id, projectId });
            });
          }}>
          <option value="">{t('workspace.unassigned')}</option>
          {projects
            .filter(p => !p.archived || p.id === session.projectId)
            .map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </Select>
      </div>
      <p className="my-3 text-xs text-nb-muted">
        {checkpoint
          ? `${t('workspace.checkpoint')}: ${new Date(checkpoint.updatedAt).toLocaleString()}`
          : t('workspace.noCheckpoint')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onOpen}>
          {t('workspace.openChat')}
        </Button>
        {active ? (
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await requestWorkspace({ op: 'pause', conversationId: session.id });
              })
            }>
            {t('workspace.pause')}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || projects.some(p => p.id === session.projectId && p.archived)}
            onClick={onResume}>
            {t('workspace.resume')}
          </Button>
        )}
        {session.projectId ? (
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await requestWorkspace<{ saved: number }>({
                  op: 'collect-evidence',
                  conversationId: session.id,
                });
                setCollected(result.saved);
              })
            }>
            {t('workspace.collectEvidence')}
          </Button>
        ) : null}
      </div>
      {collected !== null ? (
        <p className="mt-2 text-xs text-nb-muted" role="status">
          {t('workspace.evidenceSaved', { count: collected })}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-nb-muted">{t('workspace.chatHint')}</p>
      {runs.length ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-nb-muted">
            {t('workspace.runs')} ({runs.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {runs.map(r => (
              <li key={r.runId}>
                {new Date(r.startedAt).toLocaleString()} · {t(`status.${r.status}`)} ·{' '}
                {t('workspace.turns', { count: r.turns })}
                {r.reason ? <p className="text-xs text-nb-muted">{r.reason}</p> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}
