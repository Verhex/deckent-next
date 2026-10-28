import type { AttemptIdentity, VerifiedPrincipal } from '#domain/index.js';
import { AuditApplication, RecoveryApplication, RecoveryDecisionApplication, memoryCatalogFacts, memoryCatalogKey, recoveryContinuationApproval, recoveryDecisionPrincipal, recoveryDecisionRegistry,
  recoveryGrantState, recoveryModeState, recoveryModelReference, recoveryModelRows, type MemoryCatalogFact, type RecoveryDecisionOutcome, type RecoveryModeState, type RecoveryModelPorts,
  type RoleModelSources } from '#engine/index.js';
import { extractOpenAiChatTextFromInvocation, openLocalIntegrityAuthority, openSqliteAuditStore, openSqliteInventoryReader, openSqliteModelActivationReader, openSqliteModelCatalogReader,
  openSqliteModelInvocationReader, openSqliteRecoveryStore, recordedWorkerIsolation } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { prepareTerminalChatCommand } from '#composition/core/terminal-chat/index.js';
import { invokeConfiguredModelAs } from '#composition/core/model-invocation/index.js';
import { holdConfiguredRunForNervous } from './lifecycle.js';
type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
/** The Nervous stop steps whose execution ends in a slot release with proof: only their cases can be decided — released when the step ran, as
 * would-stop shadow input (alpha.56 G1, every other disposition) when it did not; the engine derives the basis from the sealed detection. */
const RELEASING = new Set(['fence-attempt', 'stop-orphan']);
const errorCode = (error: unknown, fallback: string) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' ? code : fallback; };
/** The invocation id a claimed call recorded under `commandId` (null: nothing was claimed, nothing sent). */
async function claimedInvocation(c: Context, path: string, scopeId: string, commandId: string) {
  const reader = await openSqliteModelInvocationReader(path, { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
  try { return (await reader.loadReceipt!(scopeId, commandId))?.receipt.claim.invocationId ?? null; } catch { return null; } finally { reader.close(); }
}
/** The recovery decision's model ports (S6R-5): active `recovery-decision` role rows (S2) with their channel's catalog billing and their profile's
 * delegated-use consent; one call under the recovery principal through the existing model-invocation path (policy, binding, activation, spend). */
function recoveryModelPorts(projectRoot: string, options: ConfigLoadOptions, c: Context, path: string, principal: VerifiedPrincipal, facts: ReadonlyMap<string, MemoryCatalogFact>,
  roles: RoleModelSources): RecoveryModelPorts {
  const profiles = c.config['provider_invocation_profiles'];
  const rows: RecoveryModelPorts['rows'] = scopeId => recoveryModelRows(roles, profiles, scopeId, (channelId, modelId) => facts.get(memoryCatalogKey(channelId, modelId))?.billing ?? null, Date.now());
  return { rows, async invoke(request) {
      // The exact row must still be an active, invocable role row just before the call (the role registry restricts the recovery principal's grant).
      const current = (await rows(request.scopeId)).some(row => row.channelId === request.row.channelId && row.modelId === request.row.modelId && row.invocable);
      const reference = current ? recoveryModelReference(roles, profiles, request.scopeId, request.row) : null;
      if (!reference) return { status: 'failed', code: 'RECOVERY_MODEL_NOT_INVOCABLE', invocationId: null };
      try {
        const { command } = await prepareTerminalChatCommand({ projectRoot, scopeId: request.scopeId, messages: [...request.messages], options }, false, reference,
          { maxCompletionTokens: request.maxCompletionTokens });
        // The command id is the decision id: a replay after a crash finds the claimed invocation and never sends it again (retries 0).
        const text = extractOpenAiChatTextFromInvocation(await invokeConfiguredModelAs(projectRoot, { ...command, commandId: request.commandId }, principal, options));
        const invocationId = await claimedInvocation(c, path, request.scopeId, request.commandId);
        return text ? { status: 'responded', text, invocationId } : { status: 'failed', code: 'RECOVERY_MODEL_EMPTY', invocationId };
      } catch (error) {
        return { status: 'failed', code: errorCode(error, 'RECOVERY_MODEL_CALL_FAILED'), invocationId: await claimedInvocation(c, path, request.scopeId, request.commandId) };
      }
    } };
}
/** alpha.56 D2: the isolation block the lost Attempt's dispatch record carries (null: no record, or none recorded — the engine holds then). */
async function recordedIsolation(c: Context, path: string, identity: AttemptIdentity) {
  const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
  try { const record = await reader.loadBoundDispatch(identity); return record ? recordedWorkerIsolation(record.profile) : null; } finally { reader.close(); }
}
/** The catalog facts (billing) and the S2 role sources of one read, closed after `work`. */
async function withRoleSources<T>(c: Context, path: string, work: (facts: ReadonlyMap<string, MemoryCatalogFact>, roles: RoleModelSources) => Promise<T>): Promise<T> {
  const busyTimeoutMs = c.config.storage.sqlite.busyTimeoutMs, catalog = await openSqliteModelCatalogReader(path, { busyTimeoutMs });
  try {
    const activation = await openSqliteModelActivationReader(path, { busyTimeoutMs });
    try { return await work(await memoryCatalogFacts(catalog), { modelRoles: c.config['model_roles'], providerCatalog: c.config['provider_catalog'],
      activation: (scope, reference) => activation.loadRecord(scope, reference) }); } finally { activation.close(); }
  } finally { catalog.close(); }
}

/**
 * S6R-5 recovery decision pass over the reconciliation loop (owner Q-R2: shadow first; `runRuntime.recovery.mode`, protected, default off: nothing
 * loads). Per scope pass it reads the next page of sealed Nervous `recovery-detection` records of a releasing stop step (fence / stop-orphan; executed or would-stop) and
 * decides each case under the composition-root recovery principal; a case whose slot is not released yet waits (bounded) for a later pass.
 * `shadow` seals what each decision would do and changes nothing; `live` applies a sealed decision (continuation under the owner's standing
 * grant, or a hold for a person). Memory (cursor, waiting cases) is per process: a restart re-reads the detections and every sealed case replays
 * without a second model call. S6R-6: the circuit breaker is the ledger's — the sealed model decisions of every service scope (`scopeIds`) in the
 * registry window — so a restart neither resets it nor spends new calls.
 */
export function prepareConfiguredRecovery(projectRoot: string, options: ConfigLoadOptions, mode: 'off' | 'shadow' | 'live', scopeIds: readonly string[] = []) {
  if (mode === 'off') return null;
  const registry = recoveryDecisionRegistry(), cursors = new Map<string, number>(), waiting = new Map<string, string[]>();
  return Object.freeze({ async run(scopeId: string): Promise<readonly RecoveryDecisionOutcome[]> { try {
    const c = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), path = await c.path();
    const integrity = await openLocalIntegrityAuthority(c.layout, c.config.approvals.keyFile, true), principal = recoveryDecisionPrincipal(c.principal, scopeId);
    const verifier = { async verify() { return principal; } }, owner = { issuer: c.principal.issuer, subject: c.principal.subject };
    const audit = await openSqliteAuditStore(path, c.config.storage.sqlite), cases = openSqliteRecoveryStore(path, c.config.storage.sqlite);
    try {
      const ledger = new AuditApplication(audit, integrity), approval = async (id: string) => recoveryContinuationApproval(c.document, c.principal, id, Date.now());
      const recovery = new RecoveryApplication({ store: cases, detections: ledger, recorder: target => new AuditApplication(target, integrity), approval,
        hold: command => holdConfiguredRunForNervous(projectRoot, command, options), isolation: identity => recordedIsolation(c, path, identity), policyRevision: c.document.revision, now: Date.now,
        timeoutMs: c.config.runRuntime.parking.timeoutMs }, verifier);
      const page = ledger.listKind(scopeId, 'recovery-detection', cursors.get(scopeId) ?? 0, registry.pass.pageSize);
      const fresh = page.flatMap(record => { const subject = record.event.subject;
        return subject.kind === 'recovery-detection' && subject.target && RELEASING.has(subject.action) ? [subject.caseId] : []; });
      const queue = [...new Set([...waiting.get(scopeId) ?? [], ...fresh])], still: string[] = [], outcomes: RecoveryDecisionOutcome[] = [], failures: unknown[] = [];
      await withRoleSources(c, path, async (facts, roles) => {
        const decider = new RecoveryDecisionApplication({ recovery, store: cases, seals: ledger, approval, owner, policyRevision: c.document.revision, registry, now: Date.now,
          breakerScopes: () => [...new Set([scopeId, ...scopeIds])],
          models: recoveryModelPorts(projectRoot, options, c, path, principal, facts, roles) }, verifier);
        // One case's failure never blocks the others; the first is reported after all of them (the case waits for the next pass).
        for (const caseId of queue) {
          try {
            const outcome = await decider.decide({ schemaVersion: 1, scopeId, caseId, mode });
            if (outcome.kind === 'skipped' && outcome.reason === 'not-ready') still.push(caseId); else outcomes.push(outcome);
          } catch (error) { still.push(caseId); failures.push(error); }
        }
      });
      const last = page.at(-1); if (last) cursors.set(scopeId, last.sequence);
      waiting.set(scopeId, still.slice(-registry.pass.maxPending));
      if (failures.length) throw failures[0];
      return Object.freeze(outcomes);
    } finally { audit.close(); cases.close(); }
  } catch (error) { throw queryFailure(error); } } });
}

/**
 * S6R-6 live switch semantics (doctor's recovery row): the protected `runRuntime.nervous.mode` and `runRuntime.recovery.mode` of this
 * installation and whether the owner's standing grant `recovery-action/apply continue-new-attempt` holds in the scope. `live` continues a lost
 * task only with that grant; without it every case is sealed and goes to a person (no model call). Read-only.
 */
export async function inspectConfiguredRecoveryMode(projectRoot: string, input: Readonly<{ schemaVersion: 1; scopeId: string }>, options: ConfigLoadOptions = {}): Promise<RecoveryModeState> {
  try {
    const c = await loadConfiguredScopeContext(projectRoot, input.scopeId, options, 'read');
    return recoveryModeState({ nervous: c.config.runRuntime.nervous.mode, recovery: c.config.runRuntime.recovery.mode },
      recoveryGrantState(c.document, c.principal, [input.scopeId], Date.now()));
  } catch (error) { throw queryFailure(error); }
}
