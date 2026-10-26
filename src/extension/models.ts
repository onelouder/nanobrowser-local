// Resolves a conversation's live model and effort to a callable model and its profile, from the stored providers and
// keys. The key leaves storage only to build the provider client.
import { createModel, detectContext, isCloudEndpoint, makePair, readModelInfo, resolveProfile } from '@src/llm';
import {
  capabilityOf,
  findModel,
  getLive,
  keysStorage,
  learnFacts,
  learnt,
  DEFAULT_MAX_CONCURRENT,
  providersStorage,
  settingsStorage,
  usableModel,
} from '@src/store/settings';
import type { LivePair } from '@src/store/types';
import type { ResolvedModel } from '@src/agent/run';
import { getConversation } from '@src/store/conversations';
import { resumePair } from './resume';

export class ModelUnavailable extends Error {}

/**
 * The model and effort a run uses: the conversation's live pair, or one made from the settings when there is none. A
 * model no longer configured falls back as the panel's picker does, keeping the pair's effort. Null when no model is
 * configured. The key is read first, so a pair written after the call does not reach it.
 */
export async function livePair(conversationId: string | null): Promise<LivePair | null> {
  const [stored, settings, providers] = await Promise.all([
    conversationId ? getLive(conversationId) : undefined,
    settingsStorage.get(),
    providersStorage.get(),
  ]);
  const conversation = conversationId ? await getConversation(conversationId) : undefined;
  if (conversation?.needsModelSelection) return stored ?? null;
  if (conversation?.resumeConfig) return resumePair(conversation, stored);
  const model = usableModel(providers, stored?.model, settings.defaultModel);
  if (!model) return null;
  if (stored) return { model, reasoning: stored.reasoning };
  return makePair(model, settings.reasoning, capabilityOf(providers, model));
}

export async function resolveModel(pair: LivePair | null): Promise<ResolvedModel> {
  if (!pair) throw new ModelUnavailable('No model is chosen. Add one in Settings → Providers.');
  const ref = pair.model;
  const providers = await providersStorage.get();
  const found = findModel(providers, ref);
  if (!found) throw new ModelUnavailable(`The model ${ref.model} is no longer configured. Choose another one.`);
  if (found.model.noToolCalling) {
    throw new ModelUnavailable(`${ref.model} did not pass the tool-calling test and cannot run the agent.`);
  }
  const keys = await keysStorage.get();
  // A local OpenAI-compatible model that no source gave a window would run at the 16k fallback: its API is asked again
  // at the start of each run until it says. A slow or silent server keeps the fallback.
  let fromApi = found.model.fromApi;
  const { overrides, tested } = found.model;
  if (
    found.provider.kind === 'openai-compatible' &&
    !isCloudEndpoint(found.provider.kind, found.provider.baseUrl) &&
    !overrides?.contextWindow &&
    !tested?.contextWindow &&
    !fromApi?.contextWindow
  ) {
    const spec = {
      kind: found.provider.kind,
      modelName: found.model.name,
      apiKey: keys[found.provider.id],
      baseUrl: found.provider.baseUrl,
    };
    const facts = await Promise.race([
      readModelInfo(spec),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 2_000)),
    ]);
    if (facts?.contextWindow) {
      fromApi = { ...fromApi, ...facts, at: new Date().toISOString() };
      const learntNow = fromApi;
      await providersStorage.set(list =>
        list.map(p =>
          p.id === found.provider.id && (p.baseUrl ?? '') === (found.provider.baseUrl ?? '')
            ? { ...p, models: p.models.map(m => (m.name === found.model.name ? { ...m, fromApi: learntNow } : m)) }
            : p,
        ),
      );
    }
  }
  // Ollama and LM Studio are asked again at the start of each run: the window a server loads can change. A slow or
  // silent server keeps the value found before.
  let detectedContext = found.model.detectedContext;
  if (found.provider.kind === 'ollama' || found.provider.kind === 'lmstudio') {
    const spec = { kind: found.provider.kind, modelName: found.model.name, baseUrl: found.provider.baseUrl };
    const fresh = await Promise.race([
      detectContext(spec),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2_000)),
    ]);
    if (fresh && fresh !== detectedContext) {
      detectedContext = fresh;
      // Stored only while the provider still has the address that was asked: a change of address clears what was learnt
      // about the old server.
      await providersStorage.set(list =>
        list.map(p =>
          p.id === found.provider.id && (p.baseUrl ?? '') === (found.provider.baseUrl ?? '')
            ? { ...p, models: p.models.map(m => (m.name === found.model.name ? { ...m, detectedContext: fresh } : m)) }
            : p,
        ),
      );
    }
  }
  const profile = resolveProfile({
    kind: found.provider.kind,
    modelName: found.model.name,
    baseUrl: found.provider.baseUrl,
    overrides: found.model.overrides,
    detectedContext,
    ...learnt({ ...found.model, fromApi }),
  });
  const group = found.provider.concurrencyGroup;
  const peers = group ? providers.filter(p => p.concurrencyGroup === group) : [found.provider];
  const maxConcurrent = Math.min(...peers.map(p => p.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
  const chat = createModel({
    kind: found.provider.kind,
    modelName: found.model.name,
    apiKey: keys[found.provider.id],
    baseUrl: found.provider.baseUrl,
    maxOutputTokens: profile.maxOutput,
    maxConcurrent,
    concurrencyGroup: group,
  });
  const learn = (facts: Parameters<NonNullable<ResolvedModel['learn']>>[0]) =>
    void learnFacts(found.provider.id, found.provider.baseUrl, found.model.name, facts);
  return { ref, chat, profile, reasoning: pair.reasoning, learn };
}
