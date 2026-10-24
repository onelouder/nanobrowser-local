// The local inference proxies this build ships with, added as OpenAI-compatible providers on the first worker start
// that has not added them yet. ether-10's agent lane becomes the default model when none is set. A provider the user
// removes stays removed: the seed runs once per SEED_VERSION. The proxies need no key.
import { providersStorage, settingsStorage } from '@src/store';
import type { ModelEntry, ProviderConfig } from '@src/store';

const SEED_KEY = 'nb.localEndpointsSeeded';
const SEED_VERSION = 2;
const DEFAULT_CONTEXT = 150_000;

const model = (name: string, contextWindow: number, maxOutput: number): ModelEntry => ({
  name,
  overrides: { contextWindow, maxOutput },
});

// ether-10 (GLM-5.3 Flash, TP=2 with ether-11): context is prompt + output, enforced by the proxy, output capped at 131k.
const ETHER10_MODELS: ModelEntry[] = [
  model('dsv4-agent', DEFAULT_CONTEXT, 131_072),
  model('dsv4-chat', 131_072, 131_072),
  model('dsv4-max', DEFAULT_CONTEXT, 131_072),
  model('dsv4-code', DEFAULT_CONTEXT, 131_072),
];

export const LOCAL_ENDPOINTS: ProviderConfig[] = [
  {
    id: 'ether10-lan',
    concurrencyGroup: 'ether10',
    kind: 'openai-compatible',
    name: 'ether-10 GLM-5.3 (LAN)',
    baseUrl: 'http://192.168.146.34:8010/v1',
    models: ETHER10_MODELS,
  },
  {
    id: 'ether10-tailscale',
    concurrencyGroup: 'ether10',
    kind: 'openai-compatible',
    name: 'ether-10 GLM-5.3 (Tailscale)',
    baseUrl: 'http://100.66.169.18:8020/v1',
    models: ETHER10_MODELS,
  },
  // ether-9 (Qwen3.8 27B on one RTX 4090): each session is capped at 100k, output at 64k.
  {
    id: 'ether9-agentic',
    concurrencyGroup: 'ether9',
    kind: 'openai-compatible',
    name: 'ether-9 Qwen3.8 agentic',
    baseUrl: 'http://192.168.146.22:8080/v1',
    models: [model('agentic', 100_000, 65_536)],
  },
  {
    id: 'ether9-fast',
    concurrencyGroup: 'ether9',
    kind: 'openai-compatible',
    name: 'ether-9 Qwen3.8 fast',
    baseUrl: 'http://192.168.146.22:8082/v1',
    models: [model('fast', 100_000, 65_536)],
  },
];

export const DEFAULT_LOCAL_MODEL = { providerId: 'ether10-lan', model: 'dsv4-agent' };

/** Only unchanged built-in presets are migrated; deleted providers stay deleted. */
function migrateProvider(provider: ProviderConfig): ProviderConfig {
  const preset = LOCAL_ENDPOINTS.find(p => p.id === provider.id && p.baseUrl === provider.baseUrl);
  if (!preset) return provider;
  const models = provider.models.map(entry => {
    const updated = preset.models.find(m => m.name === entry.name);
    if (entry.overrides?.contextWindow !== 1_048_576 || updated?.overrides?.contextWindow !== DEFAULT_CONTEXT) {
      return entry;
    }
    return { ...entry, overrides: { ...entry.overrides, contextWindow: DEFAULT_CONTEXT } };
  });
  return { ...provider, concurrencyGroup: provider.concurrencyGroup ?? preset.concurrencyGroup, models };
}

export async function seedLocalEndpoints(): Promise<void> {
  const stored = await chrome.storage.local.get(SEED_KEY);
  const version = stored[SEED_KEY] as number | undefined;
  if (version !== undefined && version >= SEED_VERSION) return;
  await providersStorage.set(list => {
    if (version !== undefined) return list.map(migrateProvider);
    return [...list, ...LOCAL_ENDPOINTS.filter(p => !list.some(existing => existing.id === p.id))];
  });
  if (version === undefined) {
    await settingsStorage.set(s => (s.defaultModel ? s : { ...s, defaultModel: DEFAULT_LOCAL_MODEL }));
  }
  await chrome.storage.local.set({ [SEED_KEY]: SEED_VERSION });
}
