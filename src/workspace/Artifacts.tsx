import { useEffect, useRef, useState } from 'react';
import type { Conversation, StoredBlob } from '@src/store/types';
import { Button, Input, Notice, Select } from '@src/ui/components';
import { t } from '@src/ui/i18n';
import { PdfExtractionError } from '@src/ui/pdf-text';
import { requestWorkspace } from '@src/ui/workspace-protocol';
import type { ArtifactSummary } from '@src/ui/workspace-protocol';
import type { RunAction } from './Sessions';
import { decodedFile, downloadFile, fileBase64 } from './files';

interface ArtifactFile {
  name: string;
  mimeType: string;
  base64: string;
  pdf?: StoredBlob['pdf'];
}
interface Preview {
  name: string;
  mimeType: string;
  text?: string;
  url: string;
  truncated: boolean;
  pdfTruncated: boolean;
}

async function artifactPdf(file: File): Promise<{ pdf?: StoredBlob['pdf']; warning?: string }> {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return {};
  try {
    return { pdf: await (await import('@src/side-panel/pdf')).extractPdf(file) };
  } catch (error) {
    const key = error instanceof PdfExtractionError ? (`attach.pdf.${error.code}` as const) : 'attach.pdf.invalid';
    return { warning: `${t('workspace.pdfStored')} ${t(key, { name: file.name })}` };
  }
}

export function Artifacts({
  projectId,
  kind,
  artifacts,
  sessions,
  busy,
  run,
}: {
  projectId: string;
  kind: 'file' | 'evidence';
  artifacts: ArtifactSummary[];
  sessions: Conversation[];
  busy: boolean;
  run: RunAction;
}) {
  const [query, setQuery] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [session, setSession] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  const shown = artifacts.filter(
    a => a.kind === kind && `${a.name} ${a.sourceUrl ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const upload = async (files: File[]) => {
    setWarnings([]);
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name}: ${t('workspace.fileTooLarge')}`);
      const { pdf, warning } = await artifactPdf(file);
      await requestWorkspace({
        op: 'add-artifact',
        projectId,
        kind,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        base64: await fileBase64(file),
        pdf,
      });
      if (warning) setWarnings(current => [...current, warning]);
    }
  };
  const read = async (artifactId: string) => requestWorkspace<ArtifactFile>({ op: 'read-artifact', artifactId });
  const show = async (artifactId: string) => {
    const file = await read(artifactId);
    const blob = decodedFile(file.base64, file.mimeType);
    let text = file.pdf?.text;
    if (text === undefined && /^(text\/|application\/(json|javascript|xml))/.test(file.mimeType))
      text = await blob.text();
    setPreview({
      name: file.name,
      mimeType: file.mimeType,
      text: text?.slice(0, 100000),
      truncated: text !== undefined && text.length > 100000,
      pdfTruncated: file.pdf?.truncated === true,
      url: URL.createObjectURL(blob),
    });
  };
  return (
    <div className="flex flex-col gap-4">
      {warnings.map((warning, index) => (
        <Notice key={index} tone="warn">
          {warning}
        </Notice>
      ))}
      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          aria-label={t('workspace.search')}
          placeholder={t('workspace.search')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="flex-1"
        />
        <Button disabled={busy} onClick={() => input.current?.click()}>
          {t('workspace.upload')}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          aria-label={t('workspace.upload')}
          onChange={e => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void run(() => upload(files));
          }}
        />
      </div>
      {!shown.length ? <p className="text-sm text-nb-muted">{t('workspace.noArtifacts')}</p> : null}
      <ul className="flex flex-col gap-3">
        {shown.map(artifact => (
          <ArtifactRow
            key={artifact.id}
            artifact={artifact}
            busy={busy}
            selected={selected.includes(artifact.id)}
            onSelect={() =>
              setSelected(ids =>
                ids.includes(artifact.id) ? ids.filter(id => id !== artifact.id) : [...ids, artifact.id],
              )
            }
            onPreview={() => void run(() => show(artifact.id))}
            onDownload={() =>
              void run(async () => {
                const file = await read(artifact.id);
                downloadFile(file.name, decodedFile(file.base64, file.mimeType));
              })
            }
            onDelete={() =>
              void run(async () => {
                await requestWorkspace({ op: 'delete-artifact', artifactId: artifact.id });
                setSelected(ids => ids.filter(id => id !== artifact.id));
              })
            }
          />
        ))}
      </ul>
      {selected.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-nb-border p-3">
          <Select aria-label={t('workspace.selectSession')} value={session} onChange={e => setSession(e.target.value)}>
            <option value="">{t('workspace.selectSession')}</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
          <Button
            disabled={busy || !session}
            onClick={() =>
              void run(async () => {
                await requestWorkspace({ op: 'attach-artifacts', conversationId: session, artifactIds: selected });
                setSelected([]);
              })
            }>
            {t('workspace.attach')}
          </Button>
        </div>
      ) : null}
      {preview ? <ArtifactPreview preview={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

function ArtifactRow({
  artifact,
  selected,
  busy,
  onSelect,
  onPreview,
  onDownload,
  onDelete,
}: {
  artifact: ArtifactSummary;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="rounded-xl border border-nb-border bg-nb-bg p-4">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          aria-label={t('workspace.selectArtifact', { name: artifact.name })}
          checked={selected}
          onChange={onSelect}
        />
        <div className="min-w-0 flex-1">
          <h3 className="break-all font-medium">{artifact.name}</h3>
          <p className="my-1 text-xs text-nb-muted">
            {artifact.mimeType} · {t('workspace.bytes', { size: artifact.size.toLocaleString() })} ·{' '}
            {new Date(artifact.capturedAt ?? artifact.createdAt).toLocaleString()}
          </p>
          {artifact.sourceUrl ? (
            <p className="mb-2 break-all text-xs text-nb-muted">
              {t('workspace.source')}: {artifact.sourceUrl}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={onPreview}>
              {t('workspace.preview')}
            </Button>
            <Button disabled={busy} onClick={onDownload}>
              {t('workspace.download')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
              {t('workspace.delete')}
            </Button>
          </div>
        </div>
      </div>
      {confirming ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span>{t('workspace.deleteConfirm')}</span>
          <Button variant="danger" disabled={busy} onClick={onDelete}>
            {t('workspace.delete')}
          </Button>
          <Button onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
        </div>
      ) : null}
    </li>
  );
}

function ArtifactPreview({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  return (
    <section className="rounded-xl border border-nb-border bg-nb-bg p-4" aria-label={t('workspace.preview')}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="break-all font-medium">{preview.name}</h3>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </div>
      {preview.truncated ? <Notice tone="warn">{t('workspace.previewTruncated')}</Notice> : null}
      {preview.pdfTruncated ? <Notice tone="warn">{t('workspace.pdfTruncated')}</Notice> : null}
      <PreviewContent preview={preview} />
    </section>
  );
}

function PreviewContent({ preview }: { preview: Preview }) {
  if (preview.text !== undefined)
    return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{preview.text}</pre>;
  if (preview.mimeType.startsWith('image/'))
    return <img src={preview.url} alt={preview.name} className="max-h-96 max-w-full" />;
  return <Notice>{t('workspace.previewDownload')}</Notice>;
}
