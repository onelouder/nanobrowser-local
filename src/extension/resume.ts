import { isBlockedSite } from '@src/browser-control';
import { resolveProfile } from '@src/llm';
import type { ModelProfile } from '@src/llm';
import { findModel, learnt } from '@src/store/settings';
import type { ProviderConfig, Settings } from '@src/store/settings';
import type { Conversation, LivePair, ResumeConfig, SavedTab } from '@src/store/types';
import type { ScopeTab } from '@src/ui/protocol';

export function resumeConfiguration(pair: LivePair, profile: ModelProfile, settings: Settings): ResumeConfig {
  return {
    model: pair.model,
    reasoning: pair.reasoning,
    turnCap: settings.turnCap,
    errorCap: settings.errorCap,
    noEffectCap: settings.noEffectCap,
    contextWindow: profile.contextWindow,
    maxOutput: profile.maxOutput,
    ...(profile.outputLimit !== undefined ? { outputLimit: profile.outputLimit } : {}),
  };
}

export function configuredResume(
  pair: LivePair | null,
  providers: ProviderConfig[],
  settings: Settings,
): ResumeConfig | undefined {
  if (!pair) return undefined;
  const found = findModel(providers, pair.model);
  if (!found || found.model.noToolCalling) return undefined;
  const profile = resolveProfile({
    kind: found.provider.kind,
    modelName: found.model.name,
    baseUrl: found.provider.baseUrl,
    overrides: found.model.overrides,
    detectedContext: found.model.detectedContext,
    ...learnt(found.model),
  });
  return resumeConfiguration(pair, profile, settings);
}

export function resumableUrl(url: string, blocked: string[]): boolean {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password && !isBlockedSite(url, blocked);
  } catch {
    return false;
  }
}

/** Reuse logical identities by URL and occurrence; Chrome tab IDs never enter the durable manifest. */
export function savedTabs(
  tabs: ScopeTab[],
  previous: SavedTab[],
  activeTabId?: number,
  identities = new Map<number, string>(),
): SavedTab[] {
  const unused = [...previous];
  return tabs
    .filter(tab => resumableUrl(tab.url, []))
    .slice(0, 50)
    .map(tab => {
      const identity = identities.get(tab.tabId);
      const index = unused.findIndex(old =>
        identity ? old.id === identity : old.url === tab.url && old.origin === tab.origin,
      );
      const old = index >= 0 ? unused.splice(index, 1)[0] : undefined;
      const id = old?.id ?? crypto.randomUUID();
      identities.set(tab.tabId, id);
      return {
        id,
        url: tab.url,
        title: tab.title,
        origin: tab.origin,
        active: tab.tabId === activeTabId,
      };
    });
}

export function resumePair(conversation: Conversation, live?: LivePair): LivePair | null {
  if (live) return live;
  const config = conversation.resumeConfig;
  return config ? { model: config.model, reasoning: config.reasoning } : null;
}

export function missingSavedTabs(saved: SavedTab[], live: ScopeTab[]): SavedTab[] {
  const available = live.map(tab => tab.url);
  return saved.filter(tab => {
    const index = available.indexOf(tab.url);
    if (index < 0) return true;
    available.splice(index, 1);
    return false;
  });
}
