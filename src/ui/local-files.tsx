import { useCallback, useEffect, useState } from 'react';
import { t } from './i18n';

export type LocalFilesStatus =
  | { ok: true; version: 1; roots: Array<{ id: 'downloads' | 'documents'; path: string }> }
  | { ok: false; error: string };

export function useLocalFiles() {
  const [status, setStatus] = useState<LocalFilesStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      const reply = (await chrome.runtime.sendMessage({ type: 'nb-local-files-status' })) as LocalFilesStatus;
      setStatus(reply);
    } catch (cause) {
      setStatus({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, []);
  useEffect(() => {
    void refresh();
    const read = () => void refresh();
    window.addEventListener('focus', read);
    chrome.permissions.onAdded.addListener(read);
    chrome.permissions.onRemoved.addListener(read);
    return () => {
      window.removeEventListener('focus', read);
      chrome.permissions.onAdded.removeListener(read);
      chrome.permissions.onRemoved.removeListener(read);
    };
  }, [refresh]);
  return { status, refresh };
}

export function LocalFilesButton() {
  const { status } = useLocalFiles();
  return (
    <button
      type="button"
      className="border-b border-nb-border/60 px-3 py-2 text-left text-xs text-nb-muted hover:bg-nb-surface"
      onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#files') })}>
      {t(status?.ok ? 'localFiles.connected' : 'localFiles.enable')}
    </button>
  );
}
