import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PdfExtractionError, PDF_TIMEOUT_MS, readPdfText } from '@src/ui/pdf-text';
import type { StoredBlob } from '@src/store/types';

export async function extractPdf(file: Blob): Promise<NonNullable<StoredBlob['pdf']>> {
  const data = new Uint8Array(await file.arrayBuffer());
  // A supplied port avoids PDF.js wrapping chrome-extension URLs in a blob worker, which extension CSP forbids.
  const port = new Worker(workerUrl, { type: 'module' });
  const worker = PDFWorker.create({ port });
  let task: ReturnType<typeof getDocument> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfExtractionError('timeout')), PDF_TIMEOUT_MS);
  });
  try {
    task = getDocument({ data, worker, useWorkerFetch: false, useSystemFonts: false, disableFontFace: true });
    return await Promise.race([task.promise.then(readPdfText), timeout]);
  } catch (error) {
    if (error instanceof PdfExtractionError) throw error;
    throw new PdfExtractionError(error instanceof Error && error.name === 'PasswordException' ? 'password' : 'invalid');
  } finally {
    clearTimeout(timer!);
    void task?.destroy().catch(() => undefined);
    worker.destroy();
    port.terminate();
  }
}
