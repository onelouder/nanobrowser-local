import { useState } from 'react';
import type { Project } from '@src/store/types';
import { Button, Field, Input } from '@src/ui/components';
import { t } from '@src/ui/i18n';

export type ProjectDraft = Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
const TEXTAREA = 'min-h-24 w-full rounded-lg border border-nb-border bg-nb-bg p-2 text-sm focus:outline-nb-accent';

export function ProjectForm({
  project,
  busy,
  onSave,
  onCancel,
}: {
  project?: Project;
  busy: boolean;
  onSave: (project: ProjectDraft) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [objective, setObjective] = useState(project?.objective ?? '');
  const [sites, setSites] = useState(project?.targetSites.join('\n') ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [notes, setNotes] = useState(project?.notes ?? '');
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={e => {
        e.preventDefault();
        onSave({
          id: project?.id,
          name,
          objective,
          targetSites: sites
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean),
          instructions,
          notes,
          archived: project?.archived ?? false,
        });
      }}>
      <p className="text-sm text-nb-muted">{t('workspace.contextHint')}</p>
      <Field label={t('workspace.name')}>
        <Input
          aria-label={t('workspace.name')}
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={120}
          required
        />
      </Field>
      <Field label={t('workspace.objective')}>
        <textarea
          aria-label={t('workspace.objective')}
          className={TEXTAREA}
          value={objective}
          onChange={e => setObjective(e.target.value)}
          maxLength={2000}
        />
      </Field>
      <Field label={t('workspace.sites')}>
        <textarea
          aria-label={t('workspace.sites')}
          className={TEXTAREA}
          value={sites}
          onChange={e => setSites(e.target.value)}
          maxLength={10000}
        />
      </Field>
      <Field label={t('workspace.instructions')}>
        <textarea
          aria-label={t('workspace.instructions')}
          className={TEXTAREA}
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          maxLength={6000}
        />
      </Field>
      <Field label={t('workspace.notes')}>
        <textarea
          aria-label={t('workspace.notes')}
          className={TEXTAREA}
          value={notes}
          onChange={e => setNotes(e.target.value)}
          maxLength={50000}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {t('common.save')}
        </Button>
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

export function ProjectOverview({ project }: { project: Project }) {
  const rows = [
    [t('workspace.objective'), project.objective],
    [t('workspace.sites'), project.targetSites.join('\n')],
    [t('workspace.instructions'), project.instructions],
    [t('workspace.notes'), project.notes],
  ];
  return (
    <div className="space-y-5">
      <p className="text-sm text-nb-muted">{t('workspace.contextHint')}</p>
      <dl className="grid gap-6">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="mb-1 font-medium">{label}</dt>
            <dd className="whitespace-pre-wrap break-words text-sm text-nb-muted">{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
