import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@src/store/types';
import { DEFAULT_SETTINGS, settingsStorage } from '@src/store/settings';
import { Button, Notice } from '@src/ui/components';
import { useStorage } from '@src/ui/hooks';
import { setLanguage, t, useLanguage } from '@src/ui/i18n';
import { Logo } from '@src/ui/icons';
import { applyTheme } from '@src/ui/theme';
import { requestWorkspace } from '@src/ui/workspace-protocol';
import type { ResumePreview, WorkspaceList, WorkspaceProject } from '@src/ui/workspace-protocol';
import { Artifacts } from './Artifacts';
import { downloadFile } from './files';
import { ProjectForm, ProjectOverview } from './ProjectForm';
import type { ProjectDraft } from './ProjectForm';
import { ResumeDialog } from './ResumeDialog';
import { NewSession, Sessions } from './Sessions';
import { Chat } from './Chat';
import type { RunAction } from './Sessions';

const EMPTY: WorkspaceList = { projects: [], sessions: [] };
type Section = 'overview' | 'chat' | 'sessions' | 'evidence' | 'files';
const SECTIONS: Section[] = ['overview', 'chat', 'sessions', 'evidence', 'files'];

export function App() {
  useLanguage();
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  const [list, setList] = useState<WorkspaceList>(EMPTY);
  const [view, setView] = useState<WorkspaceProject | null>(null);
  const [projectId, setProjectId] = useState<string | null>(new URLSearchParams(location.search).get('projectId'));
  const [sessionId, setSessionId] = useState<string | null>(new URLSearchParams(location.search).get('conversationId'));
  const [section, setSection] = useState<Section>(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('section') === 'overview') return 'overview';
    return params.has('conversationId') && params.get('resume') !== '1' ? 'chat' : 'overview';
  });
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [preview, setPreview] = useState<ResumePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [chatRevision, setChatRevision] = useState(0);
  const initialized = useRef(false);
  const requestId = useRef(0);
  const resumeRequested = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  useEffect(() => void setLanguage(settings.uiLanguage), [settings.uiLanguage]);
  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const [overview, project] = await Promise.all([
        requestWorkspace<WorkspaceList>({ op: 'list' }),
        projectId ? requestWorkspace<WorkspaceProject>({ op: 'project', projectId }) : null,
      ]);
      if (id !== requestId.current) return;
      setList(overview);
      setView(project);
      setLoaded(true);
      if (!initialized.current) {
        initialized.current = true;
        const conversationId = new URLSearchParams(location.search).get('conversationId');
        const wanted = overview.sessions.find(s => s.id === conversationId)?.projectId;
        if (wanted && !projectId) setProjectId(wanted);
      }
    } catch (cause) {
      if (id === requestId.current) {
        setError(String(cause));
        setLoaded(true);
      }
    }
  }, [projectId]);
  const invalidateRequests = useCallback(() => {
    requestId.current++;
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 4000);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      invalidateRequests();
    };
  }, [refresh, revision, invalidateRequests]);

  useEffect(() => {
    if (!loaded || resumeRequested.current) return;
    resumeRequested.current = true;
    const params = new URLSearchParams(location.search);
    const conversationId = params.get('conversationId');
    if (params.get('resume') !== '1' || !conversationId) return;
    void requestWorkspace<ResumePreview>({ op: 'resume-preview', conversationId })
      .then(setPreview)
      .catch(cause => setError(String(cause)));
  }, [loaded]);

  const run: RunAction = async operation => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      setRevision(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const select = (id: string | null) => {
    setProjectId(id);
    setView(null);
    setEditing(null);
    setSection('overview');
    setNotice(null);
    if (!id) setSessionId(null);
    const query = new URLSearchParams({ section: 'overview' });
    if (id) query.set('projectId', id);
    if (id && sessionId) query.set('conversationId', sessionId);
    history.replaceState(null, '', `?${query}`);
  };
  const saveProject = (project: ProjectDraft) =>
    void run(async () => {
      const saved = await requestWorkspace<Project>({ op: 'save-project', project });
      setProjectId(saved.id);
      history.replaceState(null, '', `?projectId=${encodeURIComponent(saved.id)}`);
      setEditing(null);
      setNotice(t('workspace.savedNotice'));
    });
  const importProject = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) throw new Error(t('workspace.bundleTooLarge'));
    const project = await requestWorkspace<Project>({ op: 'import', text: await file.text() });
    setProjectId(project.id);
    history.replaceState(null, '', `?projectId=${encodeURIComponent(project.id)}`);
    setEditing(null);
    setSection('overview');
  };
  const unassigned = list.sessions.filter(s => !s.projectId);
  const linkedSession = list.sessions.find(s => s.id === sessionId);
  const availableSessions = view ? view.sessions : unassigned;
  const chatSession =
    sessionId && !linkedSession ? undefined : (availableSessions.find(s => s.id === sessionId) ?? availableSessions[0]);
  const openChat = (id: string) => {
    const targetProject = list.sessions.find(s => s.id === id)?.projectId ?? projectId;
    setSessionId(id);
    setChatRevision(value => value + 1);
    setSection('chat');
    if (targetProject !== projectId) setProjectId(targetProject);
    const query = new URLSearchParams({ conversationId: id });
    if (targetProject) query.set('projectId', targetProject);
    history.replaceState(null, '', `?${query}`);
  };
  const review = (id: string) =>
    void run(async () => {
      setPreview(await requestWorkspace<ResumePreview>({ op: 'resume-preview', conversationId: id }));
    });
  const chat = chatSession ? (
    <Chat
      key={`${chatSession.id}:${chatRevision}`}
      session={chatSession}
      sessions={availableSessions}
      onSelect={openChat}
      onNewSession={() => setSection('sessions')}
      onResume={() => review(chatSession.id)}
    />
  ) : (
    <p className="text-sm text-nb-muted">{t('workspace.noSessions')}</p>
  );

  return (
    <div className="min-h-screen bg-nb-canvas text-nb-fg">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-nb-border bg-nb-bg px-5 py-4">
        <div className="flex items-center gap-4">
          <Logo height={25} />
          <h1 className="font-serif text-xl">{t('workspace.title')}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => {
              setEditing('new');
              setNotice(null);
            }}>
            {t('workspace.newProject')}
          </Button>
          <Button disabled={busy} onClick={() => importInput.current?.click()} title={t('workspace.importHint')}>
            {t('workspace.import')}
          </Button>
          <Button disabled={busy} onClick={() => void refresh()}>
            {t('workspace.refresh')}
          </Button>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label={t('workspace.import')}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void run(() => importProject(file));
            }}
          />
        </div>
      </header>
      <div className="mx-auto grid max-w-screen-2xl gap-6 p-4 md:grid-cols-[15rem_minmax(0,1fr)] md:p-6">
        <ProjectPicker projects={list.projects} selected={projectId} unassigned={unassigned.length} onSelect={select} />
        <main className="min-w-0">
          {error ? (
            <div className="mb-4" role="alert">
              <Notice tone="error">{error}</Notice>
            </div>
          ) : null}
          {notice ? (
            <div className="mb-4" role="status">
              <Notice tone="ok">{notice}</Notice>
            </div>
          ) : null}
          {busy ? (
            <p className="mb-3 text-sm text-nb-muted" role="status">
              {t('workspace.busy')}
            </p>
          ) : null}
          {!loaded ? <p>{t('workspace.loading')}</p> : null}
          {editing ? (
            <section className="rounded-xl border border-nb-border bg-nb-bg p-5">
              <h2 className="mb-4 text-lg font-semibold">
                {t(editing === 'new' ? 'workspace.newProject' : 'workspace.edit')}
              </h2>
              <ProjectForm
                key={editing === 'new' ? 'new' : view?.project.id}
                project={editing === 'edit' && view ? view.project : undefined}
                busy={busy}
                onSave={saveProject}
                onCancel={() => setEditing(null)}
              />
            </section>
          ) : null}
          {!editing && view ? (
            <>
              <ProjectHeader view={view} busy={busy} run={run} onEdit={() => setEditing('edit')} />
              {linkedSession && linkedSession.projectId !== view.project.id ? (
                <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-nb-border bg-nb-bg p-3 text-sm">
                  <span>
                    {t('workspace.currentChat')}: {linkedSession.title}
                  </span>
                  <Button
                    disabled={
                      busy || view.project.archived || ['running', 'awaiting_user'].includes(linkedSession.status)
                    }
                    onClick={() =>
                      void run(async () => {
                        await requestWorkspace({
                          op: 'assign',
                          conversationId: linkedSession.id,
                          projectId: view.project.id,
                        });
                        setNotice(t('workspace.chatLinked'));
                        setSection('chat');
                      })
                    }>
                    {t('workspace.linkChat')}
                  </Button>
                </div>
              ) : null}
              <nav className="my-5 flex flex-wrap gap-2" aria-label={t('workspace.title')}>
                {SECTIONS.map(item => (
                  <Button
                    key={item}
                    variant={section === item ? 'primary' : 'ghost'}
                    aria-current={section === item ? 'page' : undefined}
                    onClick={() => {
                      if (item === 'chat' && chatSession) openChat(chatSession.id);
                      else setSection(item);
                    }}>
                    {t(`workspace.${item}`)}
                  </Button>
                ))}
              </nav>
              <section className="rounded-xl border border-nb-border bg-nb-bg p-5">
                {section === 'overview' ? <ProjectOverview project={view.project} /> : null}
                {section === 'chat' ? chat : null}
                {section === 'sessions' ? (
                  <div className="flex flex-col gap-4">
                    {!view.project.archived ? (
                      <NewSession projectId={view.project.id} busy={busy} run={run} onCreated={openChat} />
                    ) : null}
                    <Sessions
                      sessions={view.sessions}
                      projects={list.projects}
                      checkpoints={view.checkpoints}
                      runs={view.runs}
                      busy={busy}
                      run={run}
                      onOpen={openChat}
                      onResume={review}
                    />
                  </div>
                ) : null}
                {section === 'evidence' || section === 'files' ? (
                  <Artifacts
                    key={`${view.project.id}:${section}`}
                    projectId={view.project.id}
                    kind={section === 'evidence' ? 'evidence' : 'file'}
                    artifacts={view.artifacts}
                    sessions={view.sessions}
                    selectedSessionId={chatSession?.id ?? null}
                    onAttached={id => {
                      openChat(id);
                      setNotice(t('workspace.filesAttached'));
                    }}
                    busy={busy}
                    run={run}
                  />
                ) : null}
              </section>
            </>
          ) : null}
          {!editing && !view && loaded && !projectId ? (
            <section className="rounded-xl border border-nb-border bg-nb-bg p-5">
              <h2 className="mb-4 text-xl font-semibold">{t('workspace.unassigned')}</h2>
              {!list.projects.length ? <p className="mb-4 text-sm text-nb-muted">{t('workspace.empty')}</p> : null}
              {section === 'chat' && chatSession ? (
                chat
              ) : (
                <Sessions
                  sessions={unassigned}
                  projects={list.projects}
                  checkpoints={[]}
                  runs={[]}
                  busy={busy}
                  run={run}
                  onOpen={openChat}
                  onResume={review}
                />
              )}
            </section>
          ) : null}
        </main>
      </div>
      {preview ? (
        <ResumeDialog
          key={preview.conversationId}
          preview={preview}
          error={error}
          busy={busy}
          run={run}
          onResumed={() => openChat(preview.conversationId)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}

function ProjectPicker({
  projects,
  selected,
  unassigned,
  onSelect,
}: {
  projects: Project[];
  selected: string | null;
  unassigned: number;
  onSelect: (id: string | null) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const style = (active: boolean) =>
    `w-full rounded-lg px-3 py-2 text-left text-sm ${active ? 'bg-nb-surface font-medium text-nb-link' : 'hover:bg-nb-bg'}`;
  return (
    <aside>
      <h2 className="mb-3 px-3 font-semibold">{t('workspace.projects')}</h2>
      <nav className="flex flex-col gap-1" aria-label={t('workspace.projects')}>
        <button
          type="button"
          className={style(selected === null)}
          aria-current={selected === null ? 'page' : undefined}
          onClick={() => onSelect(null)}>
          {t('workspace.unassigned')} ({unassigned})
        </button>
        {projects
          .filter(p => showArchived || !p.archived || p.id === selected)
          .map(project => (
            <button
              type="button"
              key={project.id}
              className={style(project.id === selected)}
              aria-current={project.id === selected ? 'page' : undefined}
              onClick={() => onSelect(project.id)}>
              <span className="block break-words">{project.name}</span>
              {project.archived ? <span className="text-xs text-nb-muted">{t('workspace.archived')}</span> : null}
            </button>
          ))}
      </nav>
      <label className="mt-4 flex items-center gap-2 px-3 text-xs text-nb-muted">
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
        {t('workspace.showArchived')}
      </label>
    </aside>
  );
}

function ProjectHeader({
  view,
  busy,
  run,
  onEdit,
}: {
  view: WorkspaceProject;
  busy: boolean;
  run: RunAction;
  onEdit: () => void;
}) {
  const project = view.project;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="break-words text-2xl font-semibold">{project.name}</h2>
        <p className="mt-1 text-sm text-nb-muted">
          {t('workspace.sessionCount', { count: view.sessions.length })} ·{' '}
          {t('workspace.artifactCount', { count: view.artifacts.length })}
          {project.archived ? ` · ${t('workspace.archived')}` : ''}
        </p>
        <p className="mt-1 text-xs text-nb-muted">
          {t('workspace.storage', {
            used: (view.artifacts.reduce((sum, a) => sum + a.size, 0) / 1024 / 1024).toFixed(1),
          })}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onEdit}>
          {t('workspace.edit')}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await requestWorkspace({ op: 'archive-project', projectId: project.id, archived: !project.archived });
            })
          }>
          {t(project.archived ? 'workspace.restore' : 'workspace.archive')}
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const bundle = await requestWorkspace<{ filename: string; text: string }>({
                op: 'export',
                projectId: project.id,
              });
              downloadFile(bundle.filename, new Blob([bundle.text], { type: 'application/json' }));
            })
          }>
          {t('workspace.export')}
        </Button>
      </div>
    </div>
  );
}
