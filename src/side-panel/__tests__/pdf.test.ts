import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdf } from '../pdf';
import { PDF_TIMEOUT_MS } from '@src/ui/pdf-text';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(),
  PDFWorker: { create: () => ({ destroy: vi.fn() }) },
}));

const terminate = vi.fn();

function loading(promise: Promise<unknown>) {
  vi.stubGlobal(
    'Worker',
    class {
      terminate = terminate;
    },
  );
  const task = { promise, destroy: vi.fn(async () => undefined) };
  vi.mocked(getDocument).mockReturnValue(task as unknown as ReturnType<typeof getDocument>);
  return task;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('PDF worker lifecycle', () => {
  it.each([
    ['PasswordException', 'password'],
    ['InvalidPDFException', 'invalid'],
  ])('reports %s and terminates the worker', async (name, code) => {
    const task = loading(
      Promise.resolve().then(() => {
        throw Object.assign(new Error('unreadable'), { name });
      }),
    );
    await expect(extractPdf(new Blob(['pdf']))).rejects.toMatchObject({ code });
    expect(task.destroy).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
  });

  it('terminates the worker when document creation throws', async () => {
    loading(Promise.resolve());
    vi.mocked(getDocument).mockImplementationOnce(() => {
      throw new Error('creation failed');
    });
    await expect(extractPdf(new Blob(['pdf']))).rejects.toMatchObject({ code: 'invalid' });
    expect(terminate).toHaveBeenCalled();
  });

  it('ends an unresponsive extraction after its time budget', async () => {
    vi.useFakeTimers();
    const task = loading(new Promise(() => undefined));
    const result = expect(extractPdf(new Blob(['pdf']))).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(PDF_TIMEOUT_MS);
    await result;
    expect(task.destroy).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
  });
});
