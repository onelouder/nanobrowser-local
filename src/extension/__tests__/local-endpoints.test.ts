import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@src/store/settings';
import { DEFAULT_SETTINGS } from '@src/store/settings';

const state = vi.hoisted(() => ({ providers: [] as ProviderConfig[], settings: {} as typeof DEFAULT_SETTINGS }));
vi.mock('@src/store', () => ({
  providersStorage: {
    set: async (update: (list: ProviderConfig[]) => ProviderConfig[]) => {
      state.providers = update(state.providers);
    },
  },
  settingsStorage: {
    set: async (update: (settings: typeof DEFAULT_SETTINGS) => typeof DEFAULT_SETTINGS) => {
      state.settings = update(state.settings);
    },
  },
}));

import { DEFAULT_LOCAL_MODEL, LOCAL_ENDPOINTS, seedLocalEndpoints } from '../local-endpoints';

let stored: Record<string, unknown>;
beforeEach(() => {
  state.providers = [];
  state.settings = { ...DEFAULT_SETTINGS };
  stored = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async () => stored,
        set: async (values: Record<string, unknown>) => Object.assign(stored, values),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const context = (id: string, name: string) =>
  state.providers.find(p => p.id === id)?.models.find(m => m.name === name)?.overrides?.contextWindow;

describe('local inference defaults', () => {
  it('uses 150k for the large-context lanes and retains smaller endpoint limits', async () => {
    await seedLocalEndpoints();
    expect(context('ether10-lan', 'dsv4-agent')).toBe(150_000);
    expect(context('ether10-tailscale', 'dsv4-code')).toBe(150_000);
    expect(context('ether10-lan', 'dsv4-chat')).toBe(131_072);
    expect(context('ether9-agentic', 'agentic')).toBe(100_000);
    expect(state.settings.defaultModel).toEqual(DEFAULT_LOCAL_MODEL);
  });

  it('migrates old presets without restoring deleted providers or replacing custom settings', async () => {
    stored['nb.localEndpointsSeeded'] = 1;
    state.providers = [
      {
        ...LOCAL_ENDPOINTS[0],
        maxConcurrent: 7,
        models: [
          { name: 'dsv4-agent', overrides: { contextWindow: 1_048_576, maxOutput: 131_072 } },
          { name: 'dsv4-code', overrides: { contextWindow: 200_000, outputLimit: 32_000 } },
        ],
      },
    ];
    await seedLocalEndpoints();
    expect(state.providers).toHaveLength(1);
    expect(context('ether10-lan', 'dsv4-agent')).toBe(150_000);
    expect(context('ether10-lan', 'dsv4-code')).toBe(200_000);
    expect(state.providers[0].maxConcurrent).toBe(7);
    expect(state.providers[0].models[1].overrides?.outputLimit).toBe(32_000);
    expect(state.settings.defaultModel).toBeNull();
  });

  it('leaves changed endpoints and already migrated profiles alone', async () => {
    stored['nb.localEndpointsSeeded'] = 1;
    state.providers = [
      {
        ...LOCAL_ENDPOINTS[0],
        baseUrl: 'http://custom.invalid/v1',
        models: [{ name: 'dsv4-agent', overrides: { contextWindow: 1_048_576 } }],
      },
    ];
    await seedLocalEndpoints();
    expect(context('ether10-lan', 'dsv4-agent')).toBe(1_048_576);
    state.providers = [];
    await seedLocalEndpoints();
    expect(state.providers).toEqual([]);
  });
});
