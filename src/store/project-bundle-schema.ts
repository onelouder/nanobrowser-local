import { z } from 'zod';
import { WIRE_EFFORTS } from '@src/llm/catalogue';

const id = z.string().min(1).max(200);
const text = z.string().max(2_000_000);
const at = z.string().max(80);
const model = z.object({ providerId: id, model: z.string().max(300) });
const status = z.enum([
  'idle',
  'running',
  'awaiting_user',
  'interrupted',
  'done',
  'failed',
  'stopped',
  'capped',
  'suspended',
]);
const usage = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  reasoning: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});
const guards = z.object({
  recent: z.array(z.string()).max(100),
  noEffect: z.record(z.string(), z.number().int().nonnegative()),
  errorsInRow: z.number().int().nonnegative(),
  plainEndings: z.number().int().nonnegative(),
  doneRefusals: z.number().int().nonnegative(),
});
const debt = z
  .array(z.object({ toolCallId: id, tabId: z.number().int(), state: z.enum(['open', 'unverifiable']), label: text }))
  .max(10000);
const savedTab = z.object({
  id,
  url: z.url().refine(value => /^https?:\/\//i.test(value)),
  title: z.string().max(2000),
  origin: z.enum(['start', 'user', 'agent']),
  active: z.boolean().optional(),
});
const pdf = z.object({
  text: z.string().max(1_000_000),
  pages: z.number().int().min(1).max(200),
  totalPages: z.number().int().positive(),
  truncated: z.boolean(),
});
const filename = z
  .string()
  .min(1)
  .max(240)
  .refine(value => !value.includes('/') && !value.includes('\\') && [...value].every(c => c.charCodeAt(0) >= 32));
const encoded = z
  .string()
  .refine(value => value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value) && !/=[^=]|={3}/.test(value));
const part = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text,
    attached: z.object({ kind: z.enum(['outline', 'file', 'selection']), label: text }).optional(),
  }),
  z.object({
    type: z.literal('image'),
    data: encoded,
    mediaType: z.string().max(200),
    note: text.optional(),
    thumb: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool-call'),
    toolCallId: id,
    toolName: z.string().max(100),
    input: z.unknown(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('tool-result'),
    toolCallId: id,
    toolName: z.string().max(100),
    text,
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal('attachment'),
    id,
    name: filename,
    mimeType: z.string().max(200),
    size: z.number().int().nonnegative(),
    inlined: z.boolean().optional(),
  }),
  z.object({ type: z.literal('selection'), text, url: text, title: text, inlined: z.boolean().optional() }),
]);
const meta = z.object({
  model: model.optional(),
  reasoning: z.enum(WIRE_EFFORTS).optional(),
  usage: usage.optional(),
  durationMs: z.number().nonnegative().optional(),
  stopReason: text.optional(),
  runId: id.optional(),
  runStartedAt: at.optional(),
});
const identity = z.object({ id, parentId: id.nullable(), conversationId: id, at });
const entry = z.discriminatedUnion('type', [
  identity.extend({
    type: z.literal('message'),
    message: z.object({ role: z.enum(['user', 'assistant', 'tool']), parts: z.array(part).max(10000) }),
    result: z.unknown().optional(),
    appOwned: z.object({ kind: z.enum(['notice', 'header']) }).optional(),
    meta: meta.optional(),
  }),
  identity.extend({
    type: z.literal('ui'),
    kind: z.enum(['write-card', 'handover', 'notice', 'download']),
    data: z.unknown(),
  }),
  identity.extend({ type: z.literal('intent'), toolCallId: id, tool: z.string().max(100), args: z.unknown() }),
  identity.extend({ type: z.literal('context_edit'), targetId: id, replacement: text.nullable() }),
  identity.extend({
    type: z.literal('compaction'),
    ledger: z
      .array(
        z.object({
          turn: z.number().int().nonnegative(),
          tabId: z.number().int().optional(),
          kind: z.enum(['action', 'read', 'write', 'declined', 'blocked', 'handover', 'file', 'visit', 'merged']),
          text,
          toolCallId: id.optional(),
        }),
      )
      .max(100000),
    summary: text.nullable(),
    firstKeptId: id,
    cutUpTo: id.optional(),
    tokensBefore: z.number().nonnegative(),
    tokensAfter: z.number().nonnegative(),
  }),
  identity.extend({ type: z.literal('model_change'), model }),
  identity.extend({ type: z.literal('mode_change'), mode: z.enum(['ask', 'auto']) }),
]);
const project = z.object({
  id,
  name: z.string().min(1).max(120),
  objective: z.string().max(2000),
  targetSites: z.array(z.string().max(2048)).max(100),
  instructions: z.string().max(6000),
  notes: z.string().max(50000),
  archived: z.boolean(),
  createdAt: at,
  updatedAt: at,
});
const session = z.object({
  id,
  projectId: id,
  title: z.string().max(500),
  titleByUser: z.boolean().optional(),
  createdAt: at,
  updatedAt: at,
  leafId: id.nullable(),
  mode: z.enum(['ask', 'auto']),
  tabs: z.array(z.number().int()).max(0),
  status,
  savedTabs: z.array(savedTab).max(100).optional(),
});
const run = z.object({
  conversationId: id,
  runId: id,
  leafEntryId: id.nullable(),
  status,
  outcome: z.enum(['success', 'partial', 'failed']).optional(),
  reason: text.optional(),
  steering: z.array(z.object({ id, text, attachments: z.array(id), at })).max(1000),
  turns: z.number().int().nonnegative(),
  usage,
  debt,
  guards,
  tabs: z.array(z.number()).max(0),
  startedAt: at,
  updatedAt: at,
});
const checkpoint = z.object({
  conversationId: id,
  runId: id,
  leafEntryId: id.nullable(),
  status,
  reason: text.optional(),
  tabs: z.array(savedTab).max(100),
  debt,
  guards,
  turns: z.number().int().nonnegative(),
  usage,
  updatedAt: at,
});
const blob = z.object({
  id,
  conversationId: id,
  name: filename,
  mimeType: z.string().max(200),
  size: z
    .number()
    .int()
    .max(25 * 1024 * 1024)
    .nonnegative(),
  data: encoded,
  pdf: pdf.optional(),
  sourceIds: z.array(id).max(100).optional(),
  createdAt: at,
});
const artifact = z.object({
  id,
  projectId: id,
  conversationId: id.optional(),
  runId: id.optional(),
  entryId: id.optional(),
  kind: z.enum(['evidence', 'file']),
  name: filename,
  mimeType: z.string().max(200),
  size: z
    .number()
    .int()
    .max(25 * 1024 * 1024)
    .nonnegative(),
  data: encoded,
  pdf: pdf.optional(),
  sourceUrl: z
    .url()
    .max(10000)
    .refine(value => /^https?:\/\//i.test(value))
    .optional(),
  createdAt: at,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: at.optional(),
});

export const bundleSchema = z.object({
  format: z.literal('nanobrowser-project'),
  version: z.literal(1),
  exportedAt: at,
  project,
  sessions: z.array(session).max(500),
  entries: z.array(entry).max(100000),
  runs: z.array(run).max(500),
  runHistory: z.array(run).max(10000),
  checkpoints: z.array(checkpoint).max(500),
  blobs: z.array(blob).max(10000),
  artifacts: z.array(artifact).max(1000),
});
export type ProjectBundle = z.infer<typeof bundleSchema>;
