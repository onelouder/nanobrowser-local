import { describe, expect, it } from 'vitest';
import { configuredResume, missingSavedTabs, resumableUrl, savedTabs } from '../resume';
import { DEFAULT_SETTINGS } from '@src/store/settings';
import type { SavedTab } from '@src/store/types';

const saved: SavedTab[] = [
  { id: 'first', url: 'https://example.com/', title: 'First', origin: 'start' },
  { id: 'second', url: 'https://example.com/', title: 'Second', origin: 'user' },
];

describe('durable tab recovery', () => {
  it('uses URL occurrences and logical identities instead of old Chrome IDs', () => {
    const live = [{ tabId: 999, url: 'https://example.com/', title: 'New title', origin: 'start' as const }];
    expect(missingSavedTabs(saved, live)).toEqual([saved[1]]);
    expect(savedTabs(live, saved, 999)).toEqual([{ ...saved[0], title: 'New title', active: true }]);
    expect(JSON.stringify(savedTabs(live, saved))).not.toContain('999');
  });

  it('updates an existing logical page after navigation', () => {
    const identities = new Map([[999, 'first']]);
    const manifest = savedTabs(
      [{ tabId: 999, url: 'https://example.com/new', title: 'New route', origin: 'start' }],
      saved,
      999,
      identities,
    );
    expect(manifest).toEqual([{ ...saved[0], url: 'https://example.com/new', title: 'New route', active: true }]);
  });

  it.each(['file:///secret', 'chrome://settings', 'javascript:alert(1)', 'https://user:pass@example.com', 'bad url'])(
    'does not reopen %s',
    url => expect(resumableUrl(url, [])).toBe(false),
  );

  it('enforces blocked sites and accepts HTTP local inference/research pages', () => {
    expect(resumableUrl('https://example.com/path', ['example.com'])).toBe(false);
    expect(resumableUrl('http://localhost:8787/site', [])).toBe(true);
  });

  it('does not replace a missing saved model with a configured provider', () => {
    expect(
      configuredResume(
        { model: { providerId: 'gone', model: 'm' }, reasoning: 'high' },
        [{ id: 'available', kind: 'openai-compatible', name: 'Local', models: [{ name: 'm' }] }],
        DEFAULT_SETTINGS,
      ),
    ).toBeUndefined();
  });
});
