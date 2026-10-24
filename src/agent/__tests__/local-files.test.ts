import { describe, expect, it } from 'vitest';
import { formatLocalFileReply, prepareLocalFileCall } from '../local-files';
import { toolsForRun, kindOf } from '../tools';
import { agentSystemPrompt } from '../prompt';

const read = (encoding = 'utf8') =>
  prepareLocalFileCall('read_file', { root: 'documents', path: 'notes.md', encoding });

describe('local file tools', () => {
  it('offers file access in any conversation without a project', () => {
    const tools = toolsForRun({ vision: false }).map(tool => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['list_files', 'read_file', 'write_file', 'create_directory']));
    expect(kindOf('read_file', {})).toBe('read');
    expect(kindOf('write_file', {})).toBe('state');
    expect(agentSystemPrompt({ tools })).toContain('without projects or attachments');
  });

  it('supports arbitrary extensions and encodes Unicode without allowing implicit replacement', () => {
    const call = prepareLocalFileCall('write_file', {
      root: 'downloads',
      path: 'clone/main.css',
      content: '/* café */',
    });
    expect(call.request).toEqual({
      op: 'write',
      root: 'downloads',
      path: 'clone/main.css',
      base64: btoa(unescape(encodeURIComponent('/* café */'))),
      overwrite: false,
    });
  });

  it.each(['/etc/passwd', '../secret', 'site/../../secret', 'C:/secret', '\\server\\share', 'safe\0.txt'])(
    'rejects paths outside the selected root: %s',
    path => {
      expect(() => prepareLocalFileCall('read_file', { root: 'downloads', path })).toThrow();
    },
  );

  it('rejects malformed binary data and oversized writes', () => {
    expect(() =>
      prepareLocalFileCall('write_file', { root: 'downloads', path: 'x.bin', content: 'bad===', encoding: 'base64' }),
    ).toThrow('base64');
    expect(() =>
      prepareLocalFileCall('write_file', { root: 'downloads', path: 'x.txt', content: 'é'.repeat(262145) }),
    ).toThrow('512 KiB');
  });

  it('preserves UTF-8 characters crossing a byte-page boundary', () => {
    const first = formatLocalFileReply(read(), {
      ok: true,
      base64: Buffer.from([65, 66, 0xe2, 0x82]).toString('base64'),
      offset: 0,
      size: 6,
      nextOffset: 4,
    });
    expect(first).toContain('"nextOffset":2');
    expect(first.endsWith('\nAB')).toBe(true);
    const second = formatLocalFileReply(read(), {
      ok: true,
      base64: Buffer.from('€C').toString('base64'),
      offset: 2,
      size: 6,
      nextOffset: null,
    });
    expect(second.endsWith('\n€C')).toBe(true);
    expect(second).toContain('"nextOffset":null');
  });

  it('reads binary data explicitly and does not pretend it is text', () => {
    const reply = { ok: true as const, base64: '/w==', offset: 0, size: 1, nextOffset: null };
    expect(() => formatLocalFileReply(read(), reply)).toThrow('not complete UTF-8');
    expect(formatLocalFileReply(read('base64'), reply)).toContain('/w==');
  });

  it('continues listing at the first omitted entry when names fill the result budget', () => {
    const prepared = prepareLocalFileCall('list_files', { root: 'documents', offset: 12 });
    const entries = Array.from({ length: 40 }, (_, index) => ({
      name: `${index}-${'x'.repeat(250)}`,
      kind: 'file' as const,
      size: 1,
    }));
    const text = formatLocalFileReply(prepared, { ok: true, entries, nextOffset: null });
    const [header, ...lines] = text.split('\n');
    expect(JSON.parse(header).nextOffset).toBe(12 + lines.length);
    expect(lines.length).toBeLessThan(40);
    expect(text.length).toBeLessThan(6500);
  });
});
