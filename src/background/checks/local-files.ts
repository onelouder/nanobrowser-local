import { requestLocalFiles } from '@src/extension/local-files';
import { runManager } from '@src/extension/index';
import { activeBranch, getConversation } from '@src/store/conversations';
import { assert, sleep, waitForLoad } from './helpers';
import { panel, scriptReplies, seedFixtureModel, waitForText } from './panel-chat';
import { defineCheck } from './registry';

const CSS = 'body { color: rebeccapurple; }\n';
const RESULT = 'Continued from all four local documents and wrote the stylesheet.';
const tool = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ name, input }] });

async function assertIsolatedHost(expected: unknown): Promise<void> {
  assert(expected && typeof expected === 'object', 'Run local-files through pnpm autorun to isolate its file roots.');
  const status = await requestLocalFiles({ op: 'status' });
  assert(status.ok && 'roots' in status, `Native helper status: ${JSON.stringify(status)}`);
  const actual = Object.fromEntries(status.roots.map(root => [root.id, root.path]));
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    'Native helper must use the fixture roots before writing.',
  );
}

async function approveFileWrite(tabId: number): Promise<string> {
  let body = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    body = (await panel(tabId, 'read')).body;
    if (body.includes('Allow this action?') && body.includes('documents/cleanroom/style.css')) break;
    await sleep(150);
  }
  assert(body.includes('Create file documents/cleanroom/style.css'), `Missing file confirmation: ${body}`);
  assert(!body.includes('Allow on this site'), 'Local-file confirmation cannot grant site permission.');
  const before = await requestLocalFiles({ op: 'read', root: 'documents', path: 'cleanroom/style.css' });
  assert(!before.ok, 'The CSS file must not exist before approval.');
  assert((await panel(tabId, 'click', { label: 'Allow' })).ok, 'Approved the local-file write.');
  return body;
}

async function verifyConversation(tabId: number): Promise<void> {
  const conversationId = await runManager.scope.conversationOf(tabId);
  assert(conversationId, 'The chat was saved.');
  const conversation = await getConversation(conversationId);
  assert(conversation && !conversation.projectId, 'Direct file tools do not require a project.');
  const branch = await activeBranch(conversationId);
  assert(
    !branch.some(entry => entry.type === 'message' && entry.message.parts.some(part => part.type === 'attachment')),
    'Direct file tools do not require attachments.',
  );
}

async function verifyFileAndModel(): Promise<number> {
  const saved = await requestLocalFiles({ op: 'read', root: 'documents', path: 'cleanroom/style.css' });
  assert(
    saved.ok && 'base64' in saved && atob(saved.base64) === CSS,
    'The CSS was written to the real fixture filesystem.',
  );
  const requests = (await (await fetch('http://localhost:8787/__llm/requests')).json()) as unknown[];
  const last = JSON.stringify(requests.at(-1));
  for (let index = 1; index <= 4; index++)
    assert(last.includes(`oculus-local-evidence-${index}`), `Model received document ${index} through read_file.`);
  assert(last.includes(CSS.trim()), 'Model received the written CSS through read_file.');
  return requests.length;
}

defineCheck({
  name: 'local-files',
  title: 'Direct local files in chat',
  description:
    'Uses a real native-messaging helper with isolated Downloads/Documents roots to read four Markdown files and write CSS from a chat without a project or attachments.',
  async run(args) {
    await assertIsolatedHost(args.fixtureRoots);
    await seedFixtureModel();
    await scriptReplies([
      tool('list_files', { root: 'downloads', path: '' }),
      ...[1, 2, 3, 4].map(index => tool('read_file', { root: 'downloads', path: `oculus-cleanroom-0${index}.md` })),
      tool('write_file', { root: 'documents', path: 'cleanroom/style.css', content: CSS }),
      tool('read_file', { root: 'documents', path: 'cleanroom/style.css' }),
      { text: RESULT },
    ]);
    const page = await chrome.tabs.create({ url: 'http://localhost:8787/c-text.html', active: false });
    await waitForLoad(page.id!);
    const view = await chrome.tabs.create({
      url: chrome.runtime.getURL(`/sidepanel.html#tab=${page.id}`),
      active: true,
    });
    await waitForLoad(view.id!);
    await sleep(600);
    try {
      await panel(page.id!, 'type-send', {
        text: 'Read oculus-cleanroom-01 through 04 from Downloads, then write Documents/cleanroom/style.css and read it back.',
      });
      const confirmation = await approveFileWrite(page.id!);
      const final = await waitForText(page.id!, RESULT, 15000);
      await verifyConversation(page.id!);
      const requests = await verifyFileAndModel();
      const image = await chrome.tabs.captureVisibleTab(view.windowId, { format: 'png' });
      return {
        requests,
        nativeMessaging: true,
        noProjectOrAttachments: true,
        confirmation,
        transcript: final.transcript,
        image,
      };
    } finally {
      await chrome.tabs.remove(view.id!).catch(() => undefined);
      await chrome.tabs.remove(page.id!).catch(() => undefined);
    }
  },
});
