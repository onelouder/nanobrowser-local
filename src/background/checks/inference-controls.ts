import { LOCAL_ENDPOINTS } from '@src/extension/local-endpoints';
import { deleteShortcut, listShortcuts } from '@src/store/shortcuts';
import { DEFAULT_SETTINGS } from '@src/store/settings';
import type { ProviderConfig, Settings } from '@src/store/settings';
import { assert, sleep, waitForLoad } from './helpers';
import { FIXTURE_PROVIDER } from './panel-chat';
import { defineCheck } from './registry';

type PageRead = { ok: boolean; body: string; value: string };
const MODEL = 'fixture-model';
const CONTEXT = `${MODEL}: Context budget (tokens)`;
const OUTPUT = `${MODEL}: Output budget (tokens)`;

async function options(op: string, extra: Record<string, unknown> = {}): Promise<PageRead> {
  const result = (await chrome.runtime.sendMessage({ nbTest: 'options', op, ...extra })) as PageRead;
  assert(result.ok, `options ${op}: ${JSON.stringify(extra)}`);
  await sleep(80);
  return result;
}

async function stored() {
  const data = await chrome.storage.local.get(['nb.providers', 'nb.settings']);
  return { providers: data['nb.providers'] as ProviderConfig[], settings: data['nb.settings'] as Settings };
}

async function reload(tabId: number): Promise<void> {
  await chrome.tabs.reload(tabId);
  await waitForLoad(tabId);
  await sleep(500);
}

async function seed(): Promise<void> {
  const local = LOCAL_ENDPOINTS.find(p => p.id === 'ether10-lan')!;
  const model = local.models.find(m => m.name === 'dsv4-agent')!;
  assert(model.overrides?.contextWindow === 150_000, 'local default context is 150,000');
  const provider = {
    ...FIXTURE_PROVIDER,
    name: 'Fixture LAN',
    concurrencyGroup: 'fixture-shared',
    models: [{ ...model, name: MODEL }],
  };
  await chrome.storage.local.set({
    'nb.providers': [provider, { ...provider, id: 'fixture-alias', name: 'Fixture alias', models: [] }],
    'nb.settings': { ...DEFAULT_SETTINGS, uiLanguage: 'en', onboarded: true },
  });
}

async function modelLimits(tabId: number): Promise<Record<string, boolean>> {
  await options('click', { label: 'Inference limits' });
  assert((await options('field', { label: CONTEXT })).value === '150000', 'default context shown');
  await options('fill', { label: CONTEXT, text: '200000' });
  await options('fill', { label: OUTPUT, text: '32768' });
  await options('click', { label: `Save limits for ${MODEL}` });
  const model = (await stored()).providers[0].models[0];
  assert(
    model.overrides?.contextWindow === 200_000 &&
      model.overrides.outputLimit === 32_768 &&
      model.overrides.maxOutput === 32_768,
    'limits persisted',
  );
  await reload(tabId);
  await options('click', { label: 'Inference limits' });
  assert((await options('field', { label: CONTEXT })).value === '200000', 'context survives reload');
  assert((await options('field', { label: OUTPUT })).value === '32768', 'output survives reload');
  await options('fill', { label: OUTPUT, text: '200000' });
  await options('click', { label: `Save limits for ${MODEL}` });
  assert((await stored()).providers[0].models[0].overrides?.outputLimit === 32_768, 'oversized output rejected');
  await options('fill', { label: OUTPUT, text: '32768' });
  return { defaultContext150k: true, limitsPersisted: true, limitsReloaded: true, invalidOutputRejected: true };
}

async function concurrency(tabId: number): Promise<Record<string, boolean>> {
  assert((await options('field', { label: 'Concurrent requests' })).value === '4', 'concurrency defaults to four');
  await options('fill', { label: 'Concurrent requests', text: '6' });
  await options('click', { label: 'Save concurrency for Fixture LAN' });
  assert(
    (await stored()).providers.every(p => p.maxConcurrent === 6),
    'shared aliases updated',
  );
  await options('fill', { label: 'Concurrent requests', text: '0' });
  await options('click', { label: 'Save concurrency for Fixture LAN' });
  assert(
    (await stored()).providers.every(p => p.maxConcurrent === 6),
    'zero concurrency rejected',
  );
  await reload(tabId);
  await options('click', { label: 'Inference limits' });
  assert((await options('field', { label: 'Concurrent requests' })).value === '6', 'concurrency survives reload');
  return {
    defaultConcurrency4: true,
    aliasesUpdated: true,
    invalidConcurrencyRejected: true,
    concurrencyReloaded: true,
  };
}

async function budget(label: string, text: string): Promise<void> {
  await options('focus', { label });
  await options('fill', { label, text });
  await options('key', { key: 'Enter' });
}

async function runLimits(tabId: number): Promise<Record<string, boolean>> {
  await options('click', { label: 'General' });
  await budget('Maximum turns', '1200');
  await budget('Consecutive error limit', '8');
  await budget('No-effect action limit', '6');
  let settings = (await stored()).settings;
  assert(settings.turnCap === 1200 && settings.errorCap === 8 && settings.noEffectCap === 6, 'run limits persisted');
  await budget('Maximum turns', '0');
  await budget('Consecutive error limit', '1.5');
  await budget('No-effect action limit', '101');
  settings = (await stored()).settings;
  assert(settings.turnCap === 1200 && settings.errorCap === 8 && settings.noEffectCap === 6, 'invalid limits rejected');
  assert((await options('read')).body.includes('Enter a whole number'), 'validation message shown');
  await reload(tabId);
  assert((await options('field', { label: 'Maximum turns' })).value === '1200', 'turn budget survives reload');
  return { turnsAbove500: true, guardLimitsSaved: true, invalidBudgetsRejected: true, runLimitsReloaded: true };
}

async function siteNotes(tabId: number): Promise<Record<string, boolean>> {
  await options('click', { label: 'Memory' });
  await options('fill', { label: 'Site', text: 'example.com' });
  await options('fill', { label: 'Instructions for this site', text: 'Use the saved research filters.' });
  await options('click', { label: 'Save' });
  assert((await stored()).settings.siteNotes['example.com'] === 'Use the saved research filters.', 'site note saved');
  await reload(tabId);
  assert((await options('read')).body.includes('Use the saved research filters.'), 'site note survives reload');
  return { siteNoteSaved: true, siteNoteReloaded: true };
}

async function workflow(tabId: number): Promise<Record<string, boolean>> {
  await options('click', { label: 'Shortcuts' });
  await options('click', { label: 'New shortcut' });
  await options('fill', { label: 'Name', text: 'inference-check-workflow' });
  await options('fill', { label: 'Prompt', text: 'Research the selected topic.' });
  await options('click', { label: 'Add step' });
  await options('fill', { label: 'Step 1', text: 'Collect three sources.' });
  await options('click', { label: 'Add step' });
  await options('fill', { label: 'Step 2', text: 'Compare their conclusions.' });
  await options('click', { label: 'Save' });
  const saved = (await listShortcuts()).find(s => s.name === 'inference-check-workflow');
  assert(saved?.steps?.join('|') === 'Collect three sources.|Compare their conclusions.', 'workflow steps saved');
  await reload(tabId);
  const body = (await options('read')).body;
  assert(body.includes('Collect three sources.') && body.includes('Compare their conclusions.'), 'workflow reloaded');
  await deleteShortcut(saved.id);
  return { workflowSaved: true, workflowReloaded: true };
}

defineCheck({
  name: 'inference-controls',
  title: 'Editable inference and run limits',
  description: 'Exercises token budgets, shared concurrency, long-task guards, and site notes through Settings.',
  async run() {
    const saved = await chrome.storage.local.get(['nb.providers', 'nb.settings']);
    await seed();
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#providers'), active: true });
    try {
      await waitForLoad(tab.id!);
      await sleep(600);
      const limits = await modelLimits(tab.id!);
      const parallel = await concurrency(tab.id!);
      await options('focus', { label: CONTEXT });
      const providerImage = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const runs = await runLimits(tab.id!);
      const runImage = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const notes = await siteNotes(tab.id!);
      const steps = await workflow(tab.id!);
      return { ...limits, ...parallel, ...runs, ...notes, ...steps, providerImage, runImage };
    } finally {
      await chrome.tabs.remove(tab.id!).catch(() => undefined);
      await chrome.storage.local.remove(['nb.providers', 'nb.settings']);
      await chrome.storage.local.set(saved);
    }
  },
});
