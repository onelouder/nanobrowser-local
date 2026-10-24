import { useState } from 'react';
import { Button, Notice } from '@src/ui/components';
import { t } from '@src/ui/i18n';
import { useLocalFiles } from '@src/ui/local-files';
import { LOCAL_FILES_PERMISSION } from '@src/ui/manifest-permissions';
import { SettingsCard } from './SettingsCard';

export function FilesSection() {
  const { status, refresh } = useLocalFiles();
  const [error, setError] = useState<string | null>(null);
  const command = `node native-files/install.mjs --extension-id ${chrome.runtime.id}`;
  const connect = () => {
    void chrome.permissions
      .request({ permissions: [LOCAL_FILES_PERMISSION] })
      .then(async allowed => {
        setError(allowed ? null : t('localFiles.permissionNeeded'));
        if (allowed) await refresh();
      })
      .catch(cause => setError(String(cause)));
  };
  return (
    <SettingsCard
      title={t('localFiles.title')}
      description={t('localFiles.description')}
      className="flex flex-col gap-4">
      {status?.ok ? (
        <>
          <Notice tone="ok">{t('localFiles.ready')}</Notice>
          <ul className="space-y-2 text-sm">
            {status.roots.map(root => (
              <li key={root.id}>
                <strong>{root.id}</strong>: <code className="break-all">{root.path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className="text-sm text-nb-muted">{t('localFiles.setup')}</p>
          <pre className="overflow-x-auto rounded-lg bg-nb-surface p-3 text-sm">
            <code>{command}</code>
          </pre>
          <Button
            className="self-start"
            onClick={() => void navigator.clipboard.writeText(command).catch(cause => setError(String(cause)))}>
            {t('localFiles.copyCommand')}
          </Button>
          <Button className="self-start" variant="primary" onClick={connect}>
            {t('localFiles.connect')}
          </Button>
          {status ? <p className="break-words text-xs text-nb-muted">{status.error}</p> : null}
        </>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <p className="text-sm text-nb-muted">{t('localFiles.example')}</p>
      <p className="text-sm text-nb-muted">{t('localFiles.writeMode')}</p>
      <Button className="self-start" onClick={() => void refresh()}>
        {t('localFiles.check')}
      </Button>
    </SettingsCard>
  );
}
