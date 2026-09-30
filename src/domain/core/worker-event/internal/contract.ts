import { z } from 'zod';

/** Worker Event Contract. One current version; provider normalizers map native streams onto it. Events are reported by the
 * worker container (untrusted evidence): they never grant authority, acceptance or terminal truth. */
export const WORKER_EVENT_SCHEMA_VERSION = 1;
const count = z.number().int().nonnegative().safe();
const text = (max: number) => z.string().max(max);
const MAX_MODELS = 16;
export const workerToolClassSchema = z.enum(['read', 'edit', 'write', 'shell', 'search', 'network', 'agent', 'other']);
export type WorkerToolClass = z.infer<typeof workerToolClassSchema>;
export const workerProviderSchema = z.enum(['claude', 'codex', 'cursor']);
const tokens = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, thinking: count.nullable() }).strict().readonly();
export type WorkerTokens = z.infer<typeof tokens>;
const base = { schemaVersion: z.literal(WORKER_EVENT_SCHEMA_VERSION), sequence: z.number().int().positive().safe(), atMs: count };
export const workerEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('session.started'), provider: workerProviderSchema, model: text(128).nullable(), cliVersion: text(64).nullable() }).strict(),
  z.object({ ...base, kind: z.literal('message'), role: z.enum(['assistant']), textBytes: count, thinking: z.boolean(), excerpt: text(240) }).strict(),
  z.object({ ...base, kind: z.literal('tool.call'), toolId: text(96), name: text(64), toolClass: workerToolClassSchema,
    target: text(256).nullable(), detail: text(240).nullable() }).strict(),
  z.object({ ...base, kind: z.literal('tool.result'), toolId: text(96), status: z.enum(['ok', 'error']), bytes: count }).strict(),
  z.object({ ...base, kind: z.literal('usage'), tokens }).strict(),
  z.object({ ...base, kind: z.literal('quota'), window: text(32), utilization: z.number().min(0).max(1), resetsAtMs: count.nullable(), status: text(32) }).strict(),
  z.object({ ...base, kind: z.literal('limit'), limit: z.enum(['max-turns', 'budget', 'duration', 'structured-output']), detail: text(120) }).strict(),
  z.object({ ...base, kind: z.literal('session.ended'), outcome: z.enum(['success', 'error', 'limit']), turns: count, durationMs: count,
    apiDurationMs: count.nullable(), costUsd: z.number().nonnegative().finite().nullable(), costBasis: text(32).nullable(), tokens: tokens.nullable(),
    permissionDenials: count, models: z.array(text(128)).max(MAX_MODELS).readonly().optional() }).strict(),
  z.object({ ...base, kind: z.literal('unmapped'), nativeType: text(64), count: z.number().int().positive().safe() }).strict(),
  /** Host-generated after the gateway closed (WORKER-CURRENCY-1): the admitted exact model compared with the models the worker reported.
   * `substituted` lists every unexpected model; `unverified` means the provider reports no per-model evidence. Never accepted from a worker. */
  z.object({ ...base, kind: z.literal('model.verification'), status: z.enum(['verified', 'substituted', 'unverified']), admitted: text(256).nullable(),
    observed: z.array(text(128)).max(MAX_MODELS + 1).readonly(), unexpected: z.array(text(128)).max(MAX_MODELS + 1).readonly() }).strict(),
  /** Host-generated when caps drop events; never produced by a worker. */
  z.object({ ...base, kind: z.literal('dropped'), reason: z.enum(['event-cap', 'byte-cap', 'invalid', 'order']), count: z.number().int().positive().safe() }).strict(),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;

/** Deterministic, human-readable phase of a worker from its latest meaningful event (no model call, no scoring). */
export type WorkerPhase = 'starting' | 'thinking' | 'reading' | 'editing' | 'running' | 'searching' | 'fetching' | 'delegating' | 'finished' | 'failed';
const phaseOf: Readonly<Record<WorkerToolClass, WorkerPhase>> = { read: 'reading', edit: 'editing', write: 'editing', shell: 'running',
  search: 'searching', network: 'fetching', agent: 'delegating', other: 'running' };
export interface WorkerActivityPhase { readonly phase: WorkerPhase; readonly detail: string | null; readonly target: string | null; readonly atMs: number }
export function workerActivityPhase(events: readonly WorkerEvent[]): WorkerActivityPhase | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind === 'session.ended') return { phase: event.outcome === 'success' ? 'finished' : 'failed', detail: null, target: null, atMs: event.atMs };
    if (event.kind === 'tool.call') return { phase: phaseOf[event.toolClass], detail: event.detail, target: event.target, atMs: event.atMs };
    if (event.kind === 'message') return { phase: 'thinking', detail: null, target: null, atMs: event.atMs };
    if (event.kind === 'session.started') return { phase: 'starting', detail: event.model, target: null, atMs: event.atMs };
  }
  return null;
}

export interface WorkerEventSummary {
  readonly provider: string | null; readonly model: string | null; readonly outcome: 'success' | 'error' | 'limit' | 'running';
  readonly turns: number | null; readonly durationMs: number | null; readonly apiDurationMs: number | null;
  readonly tokens: WorkerTokens; readonly cacheReadRatio: number | null; readonly costUsd: number | null; readonly costBasis: string | null;
  readonly toolCalls: Readonly<Record<WorkerToolClass, number>>; readonly toolErrors: number; readonly filesTouched: readonly string[];
  readonly messages: number; readonly quota: readonly { readonly window: string; readonly utilization: number }[];
  readonly unmapped: number; readonly dropped: number; readonly events: number;
  /** Models the provider reported for the session (Claude `result.modelUsage` keys) and the host verdict, when present. */
  readonly models: readonly string[] | null;
  readonly modelVerification: Readonly<{ status: 'verified' | 'substituted' | 'unverified'; unexpected: readonly string[] }> | null;
}
const MAX_FILES = 100;
/** Pure summary for interpretation: what the worker did, how long, how many tokens and how well the cache served it. */
export function summarizeWorkerEvents(events: readonly WorkerEvent[]): WorkerEventSummary {
  const toolCalls: Record<WorkerToolClass, number> = { read: 0, edit: 0, write: 0, shell: 0, search: 0, network: 0, agent: 0, other: 0 };
  const running = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: null as number | null };
  const files = new Set<string>(), quota = new Map<string, number>();
  let provider: string | null = null, model: string | null = null, ended: Extract<WorkerEvent, { kind: 'session.ended' }> | null = null;
  let toolErrors = 0, messages = 0, unmapped = 0, dropped = 0;
  let verification: WorkerEventSummary['modelVerification'] = null;
  for (const event of events) {
    if (event.kind === 'session.started') { provider = event.provider; model = event.model; }
    else if (event.kind === 'tool.call') { toolCalls[event.toolClass]++; if (event.target && (event.toolClass === 'edit' || event.toolClass === 'write') && files.size < MAX_FILES) files.add(event.target); }
    else if (event.kind === 'tool.result' && event.status === 'error') toolErrors++;
    else if (event.kind === 'message') messages++;
    else if (event.kind === 'usage') {
      running.input += event.tokens.input; running.output += event.tokens.output; running.cacheRead += event.tokens.cacheRead; running.cacheWrite += event.tokens.cacheWrite;
      if (event.tokens.thinking !== null) running.thinking = (running.thinking ?? 0) + event.tokens.thinking;
    }
    else if (event.kind === 'quota') quota.set(event.window, event.utilization);
    else if (event.kind === 'unmapped') unmapped += event.count;
    else if (event.kind === 'dropped') dropped += event.count;
    else if (event.kind === 'session.ended') ended = event;
    else if (event.kind === 'model.verification') verification = Object.freeze({ status: event.status, unexpected: event.unexpected });
  }
  // The provider's final totals are authoritative over the running sum of per-message usage.
  const total = ended?.tokens ?? running;
  const prompt = total.input + total.cacheRead + total.cacheWrite;
  return Object.freeze({ provider, model, outcome: ended?.outcome ?? 'running', turns: ended?.turns ?? null, durationMs: ended?.durationMs ?? null,
    apiDurationMs: ended?.apiDurationMs ?? null, tokens: Object.freeze({ ...total }), cacheReadRatio: prompt > 0 ? total.cacheRead / prompt : null,
    costUsd: ended?.costUsd ?? null, costBasis: ended?.costBasis ?? null, toolCalls: Object.freeze(toolCalls), toolErrors,
    filesTouched: Object.freeze([...files].sort()), messages, quota: Object.freeze([...quota].map(([window, utilization]) => Object.freeze({ window, utilization }))),
    unmapped, dropped, events: events.length, models: ended?.models ?? null, modelVerification: verification });
}

export type WorkerModelVerification = Readonly<{ status: 'verified' | 'substituted' | 'unverified'; admitted: string | null;
  observed: readonly string[]; unexpected: readonly string[] }>;
/**
 * Pure host verdict (WORKER-CURRENCY-1, Jev f49cb4f6): a Claude session is `verified` only when it started on the admitted exact model,
 * reported usage for it, and every other reported model is one the profile declared as auxiliary. Anything else the worker used is
 * `substituted` (listed). Providers without per-model evidence, profiles without an admitted model, or a session without usage are `unverified`.
 */
export function verifyWorkerModels(input: Readonly<{ provider: 'claude' | 'codex' | 'cursor';
  admitted: Readonly<{ modelId: string; auxiliaryModelIds: readonly string[] }> | null; startedModel: string | null; usedModels: readonly string[] | null }>): WorkerModelVerification {
  const observed = Object.freeze([...new Set([...(input.startedModel === null ? [] : [input.startedModel]), ...(input.usedModels ?? [])])].sort());
  const admitted = input.admitted?.modelId ?? null;
  if (input.provider !== 'claude' || input.admitted === null) return Object.freeze({ status: 'unverified', admitted, observed, unexpected: Object.freeze([]) });
  const allowed = new Set([input.admitted.modelId, ...input.admitted.auxiliaryModelIds]);
  const unexpected = new Set(observed.filter(model => !allowed.has(model)));
  if (input.startedModel !== null && input.startedModel !== input.admitted.modelId) unexpected.add(input.startedModel);
  const list = Object.freeze([...unexpected].sort());
  if (list.length > 0) return Object.freeze({ status: 'substituted', admitted, observed, unexpected: list });
  const complete = input.startedModel === input.admitted.modelId && (input.usedModels ?? []).includes(input.admitted.modelId);
  return Object.freeze({ status: complete ? 'verified' : 'unverified', admitted, observed, unexpected: list });
}
