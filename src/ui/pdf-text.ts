import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { StoredBlob } from '@src/store/types';

export const MAX_PDF_PAGES = 200;
export const MAX_PDF_CHARS = 1_000_000;
export const PDF_TIMEOUT_MS = 30_000;

export class PdfExtractionError extends Error {
  constructor(readonly code: 'password' | 'invalid' | 'empty' | 'timeout') {
    super(code);
  }
}

export async function readPdfText(document: PDFDocumentProxy): Promise<NonNullable<StoredBlob['pdf']>> {
  let text = '';
  let pages = 0;
  let hasText = false;
  let truncated = document.numPages > MAX_PDF_PAGES;
  for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, MAX_PDF_PAGES); pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const words = content.items.map(item => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')).join('');
    hasText ||= !!words.trim();
    const section = `[Page ${pageNumber}]\n${words.trim()}\n\n`;
    const remaining = MAX_PDF_CHARS - text.length;
    text += section.slice(0, remaining);
    pages++;
    page.cleanup();
    if (section.length >= remaining) {
      truncated = section.length > remaining || pageNumber < document.numPages;
      break;
    }
  }
  if (!hasText) throw new PdfExtractionError('empty');
  return { text, pages, totalPages: document.numPages, truncated };
}
