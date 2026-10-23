import { randomUUID } from 'node:crypto';
import { MemoryEvaluationApplication, MemoryJournalApplication, MemoryPolicyAuthorization, memoryCatalogFacts, memoryCatalogKey, memoryEvaluationDue, memoryEvaluationResolver,
  memoryEvaluationSpendOf, memoryEvaluatorFor, memoryEvaluatorReference, memoryEvaluatorRows, memoryEvaluatorView, type MemoryCatalogFact, type MemoryEvaluatorPorts, type MemoryEvaluatorRow,
  type RoleModelSources } from '#engine/index.js';
import { extractOpenAiChatTextFromInvocation, memoryKeyedDigest, openLocalIntegrityAuthority, openMemoryEvaluationSourceReader, openSqliteMemoryJournalStore, openSqliteModelActivationReader,
  openSqliteModelCatalogReader, openSqliteModelInvocationReader } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { invokeConfiguredModelAs } from '#composition/core/model-invocation/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
type Pass = { readonly c: Context; readonly path: string; readonly evaluator: ReturnType<typeof memoryEvaluatorFor>; readonly facts: ReadonlyMap<string, MemoryCatalogFact>;
  readonly roles: RoleModelSources };
/** The exact spend of one call from its sealed invocation and spend reservation; no claim receipt means nothing was sent (nothing spent). */
async function settledSpend(p: Pass, scopeId: string, commandId: string, billing: MemoryEvaluatorRow['billing']) {
  const reader = await openSqliteModelInvocationReader(p.path, { busyTimeoutMs: p.c.config.storage.sqlite.busyTimeoutMs });
  try {
    const record = await reader.loadReceipt!(scopeId, commandId);
    if (!record) return { invocationId: null, spend: { state: 'none' as const } };
    const held = await reader.loadInspection(scopeId, record.receipt.claim.invocationId);
    return { invocationId: record.receipt.claim.invocationId, spend: memoryEvaluationSpendOf(held ? { receipt: record.receipt, spending: held.spending } : null, billing) };
  } catch { return { invocationId: null, spend: { state: 'unknown' as const } }; } finally { reader.close(); }
}
const scopeRows = (c: Context, roles: RoleModelSources, facts: ReadonlyMap<string, MemoryCatalogFact>, scopeId: string) =>
  memoryEvaluatorRows(roles, c.config['provider_invocation_profiles'], scopeId, facts, Date.now());
/** The evaluator's model ports: active `memory-evaluator` role rows (S2) with catalog makers; one call under the evaluator's own principal. */
function evaluatorPorts(projectRoot: string, options: ConfigLoadOptions, p: Pass): MemoryEvaluatorPorts {
  const profiles = p.c.config['provider_invocation_profiles'], rows = (scopeId: string) => scopeRows(p.c, p.roles, p.facts, scopeId);
  return { rows, async invoke(request) {
    // N3: the exact row must still be an active role row with an invocation path, re-read just before the call (the role registry restricts V5).
    const current = (await rows(request.scopeId)).some(row => row.channelId === request.row.channelId && row.modelId === request.row.modelId && row.invocable);
    const reference = current ? memoryEvaluatorReference(p.roles, profiles, request.scopeId, request.row) : null;
    if (!reference) return { status: 'failed', code: 'MEMORY_EVALUATOR_NOT_INVOCABLE', invocationId: null, spend: { state: 'none' } };
    let text: string | null = null, code = 'MEMORY_EVALUATION_EMPTY', thrown: unknown = null;
    try {
      const { command } = await prepareTerminalChatCommand({ projectRoot, scopeId: request.scopeId, messages: [...request.messages], options }, false, reference,
        { maxCompletionTokens: request.maxCompletionTokens });
      // The record id is the command id: a replay after a crash finds the claimed invocation and never sends it again (retries 0).
      text = extractOpenAiChatTextFromInvocation(await invokeConfiguredModelAs(projectRoot, { ...command, commandId: request.commandId }, p.evaluator, options));
    } catch (error) { thrown = error; const raw = (error as { code?: unknown }).code; code = typeof raw === 'string' ? raw : 'MEMORY_EVALUATION_CALL_FAILED'; }
    const settled = await settledSpend(p, request.scopeId, request.commandId, request.row.billing);
    // Nothing was claimed (a configuration, binding, activation or authority refusal before the provider effect): not an answer, so nothing is
    // sealed and the candidate is asked once the cause is fixed; the pass stops with the typed error.
    if (thrown !== null && settled.invocationId === null) throw thrown;
    return text ? { status: 'responded', text, ...settled } : { status: 'failed', code, ...settled };
  } };
}
/**
 * S4B-3 (owner S-M3/S-M4/S-M5/S-M10/S-M14): the independent memory evaluator off the hot path, under the composition-root identity
 * `<owner>/memory-evaluator` (floor V1–V5), at most one pass per scope per `evaluation.passIntervalMs`. `memoryAutomation.verification.mode`
 * off (default: nothing loads) | shadow (sealed records, nothing verified) | on (live: a pass verifies; contests withdraw conflicting entries).
 */
export function prepareConfiguredMemoryEvaluation(projectRoot: string, options: ConfigLoadOptions, mode: string) {
  const run = mode === 'on' ? 'live' as const : mode === 'shadow' ? 'shadow' as const : null, last = new Map<string, number>();
  if (!run) return null;
  return Object.freeze({ async run(scopeId: string) { try {
    const c = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), now = Date.now();
    if (!memoryEvaluationDue(c.config.memoryAutomation.overlay, last.get(scopeId), now)) return null;
    last.set(scopeId, now);
    const path = await c.path(), integrity = await openLocalIntegrityAuthority(c.layout, c.config.approvals.keyFile, true), evaluator = memoryEvaluatorFor(c.principal, scopeId);
    const policy = new MemoryPolicyAuthorization({ async load() { return c.document; } }), view = await policy.readFilter(evaluator, scopeId);
    return await withModelFacts(c, path, async (facts, roles) => {
      const sources = await openMemoryEvaluationSourceReader(path, c.config.storage.sqlite, (channelId, modelId) => facts.get(memoryCatalogKey(channelId, modelId))?.maker ?? null,
        runId => view({ kind: 'run', id: runId }, 'inspect'));
      try {
        const openStore = async (access: 'read' | 'write') => openSqliteMemoryJournalStore(path, c.config.storage.sqlite, integrity, access);
        const deps = { verifier: { verify: async () => evaluator }, authorize: (...args: Parameters<MemoryPolicyAuthorization['authorize']>) => policy.authorize(...args),
          keyedDigest: memoryKeyedDigest(integrity), openStore, automation: c.config.memoryAutomation.overlay, now: Date.now, eventId: randomUUID, evaluationSources: sources };
        const journal = new MemoryJournalApplication({ ...deps, resolveEvaluation: memoryEvaluationResolver(openStore) });
        return await new MemoryEvaluationApplication({ deps, principal: evaluator, verify: command => journal.verify(command),
          evaluator: evaluatorPorts(projectRoot, options, { c, path, evaluator, facts, roles }) }).evaluatePage(scopeId, run);
      } finally { sources.close(); }
    });
  } catch (error) { throw queryFailure(error); } } });
}
/** The catalog facts (makers, billing, prices) and the S2 role sources of one read, closed after `work`. */
async function withModelFacts<T>(c: Context, path: string, work: (facts: ReadonlyMap<string, MemoryCatalogFact>, roles: RoleModelSources) => Promise<T>): Promise<T> {
  const busyTimeoutMs = c.config.storage.sqlite.busyTimeoutMs, catalog = await openSqliteModelCatalogReader(path, { busyTimeoutMs });
  try {
    const activation = await openSqliteModelActivationReader(path, { busyTimeoutMs });
    try { return await work(await memoryCatalogFacts(catalog), { modelRoles: c.config['model_roles'], providerCatalog: c.config['provider_catalog'],
      activation: (scope, reference) => activation.loadRecord(scope, reference) }); } finally { activation.close(); }
  } finally { catalog.close(); }
}
/** S4B-3 read-only: which evaluator would serve the scope and what it may cost (catalog data × registry caps), under the caller's `memory`/`inspect`. */
export async function inspectConfiguredMemoryEvaluators(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}) {
  try {
    const c = await loadConfiguredScopeContext(projectRoot, scopeId, { ...options, heal: false }, 'read');
    await new MemoryPolicyAuthorization({ async load() { return c.document; } }).authorize('inspect', scopeId, c.principal);
    return await withModelFacts(c, await c.path(), async (facts, roles) =>
      memoryEvaluatorView(await scopeRows(c, roles, facts, scopeId), facts, c.config.memoryAutomation.overlay));
  } catch (error) { throw queryFailure(error); }
}
