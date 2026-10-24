import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import type { LivePair } from '@src/store/types';
import { findModel, learnt, providersStorage } from '@src/store/settings';
import { requestOutputLimit, resolveProfile } from '@src/llm';
import type { ProviderConfig } from '@src/store/settings';
import type { ReasoningEffort } from '@src/llm/catalogue';
import { Button, Field, Notice, Select } from '@src/ui/components';
import { useStorage } from '@src/ui/hooks';
import { t } from '@src/ui/i18n';
import { requestWorkspace } from '@src/ui/workspace-protocol';
import type { ResumePreview } from '@src/ui/workspace-protocol';
import type { RunAction } from './Sessions';

const EMPTY_PROVIDERS: ProviderConfig[] = [];
const EFFORTS: ReasoningEffort[] = ['none', 'low', 'medium', 'high'];

export function ResumeDialog({
  preview,
  error,
  busy,
  run,
  onClose,
}: {
  preview: ResumePreview;
  error: string | null;
  busy: boolean;
  run: RunAction;
  onClose: () => void;
}) {
  const providers = useStorage(providersStorage, EMPTY_PROVIDERS);
  const [model, setModel] = useState(
    preview.modelAvailable && preview.model
      ? `${preview.model.model.providerId}\u0000${preview.model.model.model}`
      : '',
  );
  const [reasoning, setReasoning] = useState<ReasoningEffort>(preview.model?.reasoning ?? 'none');
  const [reopenTabs, setReopenTabs] = useState(preview.missingTabs > 0);
  const resume = async () => {
    const [providerId, name] = model.split('\u0000');
    const pair: LivePair = { model: { providerId, model: name }, reasoning };
    await requestWorkspace({ op: 'resume', conversationId: preview.conversationId, reopenTabs, model: pair });
    onClose();
  };
  return (
    <Dialog.Root
      open
      onOpenChange={open => {
        if (!open && !busy) onClose();
      }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-nb-border bg-nb-bg p-6 shadow-pop">
          <Dialog.Title className="text-xl font-semibold">{t('workspace.resumeTitle')}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nb-muted">{t('workspace.resumeHint')}</Dialog.Description>
          <h3 className="my-4 break-words font-medium">{preview.title}</h3>
          {preview.reason ? <p className="mb-3 text-sm text-nb-muted">{preview.reason}</p> : null}
          <div className="flex flex-col gap-4">
            {error ? (
              <div role="alert">
                <Notice tone="error">{error}</Notice>
              </div>
            ) : null}
            <ResumeState preview={preview} />
            {!preview.tabs.length && !preview.liveTabs.length ? (
              <div className="flex flex-col items-start gap-2">
                <Notice>{t('workspace.openHint')}</Notice>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await requestWorkspace({ op: 'open-session', conversationId: preview.conversationId });
                      onClose();
                    })
                  }>
                  {t('workspace.open')}
                </Button>
              </div>
            ) : null}
            <Field label={t('workspace.model')}>
              <Select aria-label={t('workspace.model')} value={model} onChange={e => setModel(e.target.value)}>
                <option value="">{t('workspace.modelMissing')}</option>
                {providers.flatMap(p =>
                  p.models
                    .filter(m => !m.noToolCalling)
                    .map(m => (
                      <option key={`${p.id}\u0000${m.name}`} value={`${p.id}\u0000${m.name}`}>
                        {p.name} · {m.name}
                      </option>
                    )),
                )}
              </Select>
            </Field>
            <SelectedBudget providers={providers} model={model} />
            <Field label={t('agent.reasoning')}>
              <Select
                aria-label={t('agent.reasoning')}
                value={reasoning}
                onChange={e => setReasoning(e.target.value as ReasoningEffort)}>
                {EFFORTS.map(e => (
                  <option key={e} value={e}>
                    {t(`reasoning.${e}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {preview.missingTabs > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={reopenTabs} onChange={e => setReopenTabs(e.target.checked)} />
                {t('workspace.reopen')}
              </label>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={busy || !model || (!preview.liveTabs.length && (!preview.missingTabs || !reopenTabs))}
                onClick={() => void run(resume)}>
                {t('workspace.resumeAction')}
              </Button>
              <Button disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ResumeState({ preview }: { preview: ResumePreview }) {
  const saved = preview.checkpoint?.config;
  return (
    <>
      <p className="text-sm text-nb-muted">
        {preview.checkpoint
          ? `${t('workspace.checkpoint')}: ${new Date(preview.checkpoint.updatedAt).toLocaleString()}`
          : t('workspace.noCheckpoint')}
      </p>
      {saved ? (
        <p className="text-sm">
          {t('workspace.saved')}: {saved.model.model} · {saved.contextWindow.toLocaleString()}{' '}
          {t('models.contextLimit')}
        </p>
      ) : null}
      {preview.configurationChanged ? <Notice tone="warn">{t('workspace.configChanged')}</Notice> : null}
      {preview.missingTabs > 0 ? <Notice>{t('workspace.missingTabs', { count: preview.missingTabs })}</Notice> : null}
      {preview.blockedTabs.length ? (
        <Notice tone="warn">
          {t('workspace.blockedTabs')}
          <ul className="mt-1 break-all">
            {preview.blockedTabs.map(url => (
              <li key={url}>{url}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {preview.tabs.length ? (
        <ul className="max-h-32 overflow-y-auto rounded-lg border border-nb-border p-3 text-sm">
          {preview.tabs.map(tab => (
            <li key={tab.id} className="mb-1 break-all">
              {tab.title || tab.url}
              <span className="block text-xs text-nb-muted">{tab.url}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function SelectedBudget({ providers, model }: { providers: ProviderConfig[]; model: string }) {
  if (!model) return null;
  const [providerId, name] = model.split('\u0000');
  const found = findModel(providers, { providerId, model: name });
  if (!found) return null;
  const profile = resolveProfile({
    kind: found.provider.kind,
    baseUrl: found.provider.baseUrl,
    modelName: name,
    overrides: found.model.overrides,
    detectedContext: found.model.detectedContext,
    ...learnt(found.model),
  });
  return (
    <p className="text-xs text-nb-muted">
      {t('models.effectiveLimits', {
        context: profile.contextWindow.toLocaleString(),
        output: requestOutputLimit(profile).toLocaleString(),
      })}
    </p>
  );
}
