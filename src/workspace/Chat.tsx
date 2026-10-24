import { useEffect, useState } from 'react';
import type { Conversation } from '@src/store/types';
import { App as ConversationChat } from '@src/side-panel/App';
import { Button, Notice, Select } from '@src/ui/components';
import { t } from '@src/ui/i18n';
import { requestWorkspace } from '@src/ui/workspace-protocol';

export function Chat({
  session,
  sessions,
  onSelect,
  onNewSession,
  onResume,
}: {
  session: Conversation;
  sessions: Conversation[];
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onResume: () => void;
}) {
  const [binding, setBinding] = useState<{ tabId: number; conversationId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void requestWorkspace<number>({ op: 'open-session', conversationId: session.id, activate: false })
      .then(tabId => {
        if (current) setBinding({ tabId, conversationId: session.id });
      })
      .catch(cause => {
        if (current) setError(String(cause));
      });
    return () => {
      current = false;
    };
  }, [session.id]);
  const showWebsite = () => {
    if (!binding) return;
    void chrome.sidePanel.open({ tabId: binding.tabId }).catch(() => setError(t('workspace.openHint')));
    void chrome.tabs
      .update(binding.tabId, { active: true })
      .then(tab => (tab ? chrome.windows.update(tab.windowId, { focused: true }) : undefined))
      .catch(cause => setError(String(cause)));
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t('workspace.selectSession')} value={session.id} onChange={e => onSelect(e.target.value)}>
          {sessions.map(item => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </Select>
        <Button disabled={!binding} onClick={showWebsite}>
          {t('workspace.showWebsite')}
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="h-[calc(100vh-22rem)] min-h-96 overflow-hidden rounded-xl border border-nb-border bg-nb-bg">
        {binding ? (
          <ConversationChat
            session={binding}
            onNewSession={onNewSession}
            onResume={onResume}
            onReconnect={() => onSelect(session.id)}
          />
        ) : (
          <p className="p-4 text-sm text-nb-muted">{t('workspace.loading')}</p>
        )}
      </div>
    </div>
  );
}
