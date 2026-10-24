import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { MAX_PDF_CHARS, MAX_PDF_PAGES, readPdfText } from '../pdf-text';

function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function textDocument(pages: number, text: string): PDFDocumentProxy {
  return {
    numPages: pages,
    getPage: async () => ({
      getTextContent: async () => ({ items: [{ str: text, hasEOL: true }] }),
      cleanup: () => true,
    }),
  } as unknown as PDFDocumentProxy;
}

describe('local PDF text extraction', () => {
  it('extracts a real PDF with page labels', async () => {
    const task = getDocument({ data: tinyPdf('Local PDF text'), useSystemFonts: true });
    try {
      expect(await readPdfText(await task.promise)).toEqual({
        text: '[Page 1]\nLocal PDF text\n\n',
        pages: 1,
        totalPages: 1,
        truncated: false,
      });
    } finally {
      await task.destroy();
    }
  });

  it('rejects a PDF without extractable text', async () => {
    await expect(readPdfText(textDocument(1, ''))).rejects.toMatchObject({ code: 'empty' });
  });

  it('bounds extraction by page count and reports the original size', async () => {
    const result = await readPdfText(textDocument(MAX_PDF_PAGES + 10, 'Text'));
    expect(result).toMatchObject({ pages: MAX_PDF_PAGES, totalPages: MAX_PDF_PAGES + 10, truncated: true });
    expect(result.text).toContain(`[Page ${MAX_PDF_PAGES}]`);
  });

  it('bounds extracted characters and reports partial page extraction', async () => {
    const result = await readPdfText(textDocument(1, 'x'.repeat(MAX_PDF_CHARS + 1)));
    expect(result.text).toHaveLength(MAX_PDF_CHARS);
    expect(result.truncated).toBe(true);
  });
});
