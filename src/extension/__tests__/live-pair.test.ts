// Settings and the live pair: the setting's default, the session key, the pair a run uses, the conversation record
// without a model, and the clearing on a base URL change.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createConversation, getConversation, updateConversation } from '@src/store/conversations';
import { closeDb, db } from '@src/store/db';
import {
  capabilityOf,
  getLive,
  mergeSettings,
  removeLive,
  setLive,
  usableModel,
  withBaseUrl,
  type ProviderConfig,
  type Settings,
} from '@src/store/settings';
import { livePair, resolveModel } from '../models';

/** A chrome.storage with a local and a session area, as plain maps. */
function fakeChrome(local: Record<string, unknown> = {}) {
  const area = (data: Record<string, unknown>) => ({
    get: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
    remove: vi.fn(async (key: string) => void delete data[key]),
    onChanged: { addListener: () => undefined },
  });
  const session: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { local: area(local), session: area(session) } });
  return { local, session };
}

const PROVIDERS: ProviderConfig[] = [
  { id: 'a', kind: 'anthropic', name: 'Anthropic', models: [{ name: 'claude-sonnet-5-5' }, { name: 'claude-x' }] },
  { id: 'o', kind: 'openai', name: 'OpenAI', models: [{ name: 'gpt-4o' }, { name: 'unknown-model' }] },
  {
    id: 'l',
    kind: 'ollama',
    name: 'Ollama',
    models: [
      { name: 'mystery', reasoningSupport: 'optional' },
      { name: 'tested', tested: { reasons: true, acceptsNone: true, at: '' } },
    ],
  },
];

function settings(patch: Partial<Settings>): Settings {
  return { ...mergeSettings({}), ...patch };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('settings', () => {
  it('gives Medium to stored settings without the field', () => {
    expect(mergeSettings({ defaultMode: 'auto' }).reasoning).toBe('medium');
    expect(mergeSettings({ reasoning: 'high' }).reasoning).toBe('high');
  });

  it('clears what was learnt about the models when the base URL changes', () => {
    const provider: ProviderConfig = {
      id: 'p',
      kind: 'openai-compatible',
      name: 'P',
      baseUrl: 'http://a/v1',
      models: [
        {
          name: 'm',
          detectedContext: 8192,
          noToolCalling: true,
          reasoningSupport: 'none',
          overrides: { vision: true },
        },
      ],
    };
    expect(withBaseUrl(provider, 'http://a/v1')).toBe(provider);
    expect(withBaseUrl(provider, 'http://b/v1').models).toEqual([{ name: 'm', overrides: { vision: true } }]);
  });

  it('reads the capability from the probe, then the catalogue', () => {
    expect(capabilityOf(PROVIDERS, { providerId: 'a', model: 'claude-sonnet-5-5' })).toBe('optional');
    expect(capabilityOf(PROVIDERS, { providerId: 'o', model: 'gpt-4o' })).toBe('none');
    // An unknown Claude name reaches the Claude family: it reasons.
    expect(capabilityOf(PROVIDERS, { providerId: 'a', model: 'claude-x' })).toBe('always');
    expect(capabilityOf(PROVIDERS, { providerId: 'o', model: 'unknown-model' })).toBeUndefined();
    // An older version's stored `optional` reads as "reasons" only, since that probe never proved None.
    expect(capabilityOf(PROVIDERS, { providerId: 'l', model: 'mystery' })).toBe('always');
    expect(capabilityOf(PROVIDERS, { providerId: 'l', model: 'tested' })).toBe('optional');
    expect(capabilityOf(PROVIDERS, { providerId: 'gone', model: 'x' })).toBeUndefined();
  });
});

describe('the live pair', () => {
  it('is kept under nb.live.<id> in storage.session and removed with the conversation', async () => {
    const { session } = fakeChrome();
    const pair = { model: { providerId: 'a', model: 'claude-sonnet-5-5' }, reasoning: 'high' as const };
    await setLive('c1', pair);
    expect(session['nb.live.c1']).toEqual(pair);
    expect(await getLive('c1')).toEqual(pair);
    await removeLive('c1');
    expect(await getLive('c1')).toBeUndefined();
  });

  it('a run uses the key, then a pair made from the settings', async () => {
    fakeChrome({
      'nb.settings': settings({ defaultModel: { providerId: 'a', model: 'claude-sonnet-5-5' }, reasoning: 'medium' }),
      'nb.providers': PROVIDERS,
    });
    // No key: the setting's effort for a model that reasons.
    expect(await livePair('c1')).toEqual({
      model: { providerId: 'a', model: 'claude-sonnet-5-5' },
      reasoning: 'medium',
    });
    // The key wins over the settings, whatever its model.
    const pair = { model: { providerId: 'o', model: 'gpt-4o' }, reasoning: 'low' as const };
    await setLive('c1', pair);
    expect(await livePair('c1')).toEqual(pair);
  });

  it('makes None for a model that does not reason or is unknown, and nothing without any model', async () => {
    fakeChrome({
      'nb.settings': settings({ defaultModel: { providerId: 'o', model: 'gpt-4o' }, reasoning: 'high' }),
      'nb.providers': PROVIDERS,
    });
    expect((await livePair(null))?.reasoning).toBe('none');
    fakeChrome({
      'nb.settings': settings({ defaultModel: { providerId: 'o', model: 'unknown-model' }, reasoning: 'high' }),
      'nb.providers': PROVIDERS,
    });
    expect((await livePair(null))?.reasoning).toBe('none');
    fakeChrome({ 'nb.settings': settings({ defaultModel: null }), 'nb.providers': [] });
    expect(await livePair('c1')).toBeNull();
  });
});

describe('a model that is no longer configured', () => {
  it("falls back to the default model, then the first usable one, keeping the pair's effort", async () => {
    fakeChrome({
      'nb.settings': settings({ defaultModel: { providerId: 'o', model: 'gpt-4o' }, reasoning: 'low' }),
      'nb.providers': PROVIDERS,
    });
    await setLive('c1', { model: { providerId: 'gone', model: 'x' }, reasoning: 'high' });
    expect(await livePair('c1')).toEqual({ model: { providerId: 'o', model: 'gpt-4o' }, reasoning: 'high' });
    fakeChrome({ 'nb.settings': settings({ defaultModel: null, reasoning: 'medium' }), 'nb.providers': PROVIDERS });
    expect(await livePair(null)).toEqual({
      model: { providerId: 'a', model: 'claude-sonnet-5-5' },
      reasoning: 'medium',
    });
  });

  it('skips a model that failed the tool test', () => {
    const providers: ProviderConfig[] = [
      { id: 'p', kind: 'ollama', name: 'P', models: [{ name: 'bad', noToolCalling: true }, { name: 'good' }] },
    ];
    expect(usableModel(providers, { providerId: 'p', model: 'bad' })).toEqual({ providerId: 'p', model: 'good' });
    expect(usableModel([])).toBeNull();
  });
});

describe('the conversation record', () => {
  it('loses the model field of an older record on its next write', async () => {
    const old = {
      id: 'c',
      title: 't',
      createdAt: 'x',
      updatedAt: 'x',
      leafId: null,
      mode: 'ask',
      model: { providerId: 'p', model: 'm' },
      tabs: [],
      status: 'idle',
    };
    await (await db()).put('conversations', old as never);
    await updateConversation('c', { title: 'u' });
    const stored = await getConversation('c');
    expect(stored?.title).toBe('u');
    expect(stored).not.toHaveProperty('model');
  });
});

describe('provider request limits', () => {
  it.each(['openai-compatible', 'openai', 'anthropic'] as const)(
    'defaults %s to four concurrent requests',
    async kind => {
      fakeChrome({ 'nb.providers': [{ id: 'p', kind, name: 'P', models: [{ name: 'm' }] }] });
      const resolved = await resolveModel({ model: { providerId: 'p', model: 'm' }, reasoning: 'none' });
      expect(resolved.chat.spec.maxConcurrent).toBe(4);
    },
  );

  it('uses the configured limit and keeps aliases in the same queue', async () => {
    const provider: ProviderConfig = {
      id: 'lan',
      kind: 'openai-compatible',
      name: 'LAN',
      baseUrl: 'http://lan/v1',
      maxConcurrent: 6,
      concurrencyGroup: 'local',
      models: [{ name: 'm' }],
    };
    fakeChrome({ 'nb.providers': [provider, { ...provider, id: 'vpn', baseUrl: 'http://vpn/v1' }] });
    for (const providerId of ['lan', 'vpn']) {
      const resolved = await resolveModel({ model: { providerId, model: 'm' }, reasoning: 'none' });
      expect(resolved.chat.spec).toMatchObject({ maxConcurrent: 6, concurrencyGroup: 'local' });
    }
  });

  it('honors the lowest limit if stored aliases disagree', async () => {
    const provider: ProviderConfig = {
      id: 'lan',
      kind: 'openai-compatible',
      name: 'LAN',
      maxConcurrent: 6,
      concurrencyGroup: 'local',
      models: [{ name: 'm' }],
    };
    fakeChrome({ 'nb.providers': [provider, { ...provider, id: 'vpn', maxConcurrent: 2 }] });
    const resolved = await resolveModel({ model: { providerId: 'lan', model: 'm' }, reasoning: 'none' });
    expect(resolved.chat.spec.maxConcurrent).toBe(2);
  });
});

describe('durable workspace model choices', () => {
  it('keeps the chosen model and effort after session storage is lost', async () => {
    fakeChrome({
      'nb.providers': PROVIDERS,
      'nb.settings': settings({ defaultModel: { providerId: 'o', model: 'gpt-4o' } }),
    });
    const c = await createConversation({ mode: 'ask' });
    const pair = { model: { providerId: 'a', model: 'claude-x' }, reasoning: 'high' as const };
    await updateConversation(c.id, {
      resumeConfig: { ...pair, turnCap: 100, errorCap: 4, noEffectCap: 4, contextWindow: 150000, maxOutput: 10000 },
    });
    expect(await livePair(c.id)).toEqual(pair);
    fakeChrome({ 'nb.providers': [], 'nb.settings': settings({}) });
    expect(await livePair(c.id)).toEqual(pair);
    await expect(resolveModel(await livePair(c.id))).rejects.toThrow('no longer configured');
  });

  it('requires an explicit local model choice for imported sessions', async () => {
    fakeChrome({
      'nb.providers': PROVIDERS,
      'nb.settings': settings({ defaultModel: { providerId: 'o', model: 'gpt-4o' } }),
    });
    const c = await createConversation({ mode: 'ask' });
    await updateConversation(c.id, { needsModelSelection: true });
    expect(await livePair(c.id)).toBeNull();
  });
});
