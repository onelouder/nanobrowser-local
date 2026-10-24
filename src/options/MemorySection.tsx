// Settings → Memory: user-authored instructions for every conversation and individual sites.
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, settingsStorage } from '@src/store/settings';
import { CUSTOM_INSTRUCTIONS_MAX } from '@src/store/types';
import { useStorage } from '@src/ui/hooks';
import { t } from '@src/ui/i18n';
import { SettingsCard } from './SettingsCard';
import { isStartUrl } from '@src/store/shortcuts';
import { Button, Input } from '@src/ui/components';
import { siteFromInput } from './PermissionsSection';

/**
 * Custom instructions: edited here only, kept as typed and saved after a pause or on leaving the field, so the stored
 * value never moves the caret.
 */
function CustomInstructions() {
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const value = draft ?? settings.customInstructions;
  const save = (text: string) => {
    clearTimeout(timer.current);
    void settingsStorage.set(s => ({ ...s, customInstructions: text })).then(() => setSaved(true));
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <SettingsCard
      title={t('agent.instructions')}
      description={t('agent.instructionsHint')}
      className="flex flex-col gap-2">
      <textarea
        aria-label={t('agent.instructions')}
        value={value}
        rows={6}
        maxLength={CUSTOM_INSTRUCTIONS_MAX}
        className="rounded-lg border border-nb-border bg-nb-bg px-3 py-2 text-[15px] leading-relaxed focus:border-nb-accent focus:outline-none focus:ring-2 focus:ring-nb-accent/25"
        onChange={e => {
          const text = e.target.value;
          setDraft(text);
          setSaved(false);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => save(text), 600);
        }}
        onBlur={() => draft !== null && draft !== settings.customInstructions && save(draft)}
      />
      <p className="text-sm text-nb-muted">
        {t('agent.instructionsCount', {
          count: value.length.toLocaleString(),
          max: CUSTOM_INSTRUCTIONS_MAX.toLocaleString(),
        })}
        {saved && draft !== null && draft === settings.customInstructions ? ` · ${t('agent.instructionsSaved')}` : ''}
      </p>
    </SettingsCard>
  );
}

function SiteNotes() {
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  const [site, setSite] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState(false);
  const save = async () => {
    const address = site.includes('://') ? site.trim() : `https://${site.trim()}`;
    const key = siteFromInput(address);
    if (!isStartUrl(address) || !key || !text.trim()) return setError(true);
    await settingsStorage.set(s => ({ ...s, siteNotes: { ...s.siteNotes, [key]: text.trim() } }));
    setSite('');
    setText('');
    setError(false);
  };
  return (
    <SettingsCard title={t('memory.sites')} description={t('memory.sitesHint')} className="flex flex-col gap-4">
      <SiteNotesList
        notes={settings.siteNotes}
        onEdit={(key, note) => {
          setSite(key);
          setText(note);
        }}
      />
      <form
        className="flex flex-col gap-3"
        onSubmit={e => {
          e.preventDefault();
          void save();
        }}>
        <label className="flex flex-col gap-1 text-sm">
          {t('memory.site')}
          <Input
            aria-label={t('memory.site')}
            placeholder={t('memory.sitePlaceholder')}
            value={site}
            onChange={e => setSite(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('memory.note')}
          <textarea
            aria-label={t('memory.note')}
            value={text}
            rows={4}
            maxLength={CUSTOM_INSTRUCTIONS_MAX}
            className="rounded-lg border border-nb-border bg-nb-bg px-2.5 py-1.5 text-sm focus:border-nb-accent focus:outline-none focus:ring-2 focus:ring-nb-accent/25"
            onChange={e => setText(e.target.value)}
            required
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {t('memory.siteError')}
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="self-start">
          {t('common.save')}
        </Button>
      </form>
    </SettingsCard>
  );
}

function SiteNotesList({
  notes,
  onEdit,
}: {
  notes: Record<string, string>;
  onEdit: (site: string, text: string) => void;
}) {
  const entries = Object.entries(notes).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return <p className="text-sm text-nb-muted">{t('memory.emptySites')}</p>;
  const remove = (site: string) =>
    settingsStorage.set(s => {
      const siteNotes = { ...s.siteNotes };
      delete siteNotes[site];
      return { ...s, siteNotes };
    });
  return (
    <ul className="divide-y divide-nb-border">
      {entries.map(([site, text]) => (
        <li key={site} className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 font-mono text-sm">{site}</span>
            <Button aria-label={t('memory.editSite', { site })} onClick={() => onEdit(site, text)}>
              {t('shortcut.edit')}
            </Button>
            <Button aria-label={t('memory.deleteSite', { site })} onClick={() => void remove(site)}>
              {t('shortcut.delete')}
            </Button>
          </div>
          <p className="whitespace-pre-wrap text-sm text-nb-muted">{text}</p>
        </li>
      ))}
    </ul>
  );
}

export function MemorySection() {
  return (
    <div className="flex flex-col gap-6">
      <h2 className="sr-only">{t('settings.nav.memory')}</h2>
      <CustomInstructions />
      <SiteNotes />
    </div>
  );
}
