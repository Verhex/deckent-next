import { userInfo } from 'node:os';
import { RECOVERY_ROLLOUT, type RecoveryRolloutView, type VerifiedPrincipal } from '#domain/index.js';
import { AuditApplication, DispatchInventoryPolicyAuthorization, NERVOUS_EXECUTABLE_ACTIONS, NERVOUS_RULES_SEED, PolicyAdministrationInspection, RecoveryPolicyCard, RecoveryReviewApplication,
  loadNervousRules, readRecoveryRollout, type RecoveryPolicyCommand, type RecoveryRolloutPorts } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalPeer, openLocalIntegrityAuthority, openReadOnlyAuditStore, openSqliteAuditStore, openSqliteRecoveryStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { withPolicyAdministration } from '#composition/core/approvals/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const interactive = async () => { const peer = localPrincipalPeer(); return attestLocalInteractiveTerminal(peer?.pid, peer?.uid); };
/** The measured lost-worker rules at their current Core seed version (only the registry's rules are shown or promoted, owner Q-A4). */
const measuredRules = () => loadNervousRules(NERVOUS_RULES_SEED).rules.filter(rule => RECOVERY_ROLLOUT.rules.includes(rule.id)).map(rule => ({ id: rule.id, version: rule.version }));
/** The sealed records of one scope (verified with the installation key) and its Runs, for `work` only; `write` opens the audit writer too. */
async function withRecords<T>(c: Context, write: boolean, work: (ports: RecoveryRolloutPorts, ledger: AuditApplication) => Promise<T>): Promise<T> {
  const path = await c.path(), sqlite = c.config.storage.sqlite, integrity = await openLocalIntegrityAuthority(c.layout, c.config.approvals.keyFile, write);
  const audit = write ? await openSqliteAuditStore(path, sqlite) : await openReadOnlyAuditStore(path, sqlite), runs = openSqliteRecoveryStore(path, sqlite);
  try {
    const ledger = new AuditApplication(audit, integrity);
    return await work({ listRecentKind: (scopeId, kind, since, limit) => ledger.listRecentKind(scopeId, kind, since, limit), loadRun: (scopeId, runId) => runs.loadRun(scopeId, runId) }, ledger);
  } finally { audit.close(); runs.close(); }
}
const rollout = (c: Context, scopeId: string) => withRecords(c, false, ports => readRecoveryRollout(ports, scopeId, measuredRules()));

/** alpha.56 G4 read-only: the recovery rollout view of one scope (exit progress per measured rule, blind decision agreement) under inventory `inspect`. */
export async function inspectConfiguredRecoveryRollout(projectRoot: string, input: Readonly<{ schemaVersion: 1; scopeId: string }>, options: ConfigLoadOptions = {}): Promise<RecoveryRolloutView> {
  try {
    const c = await loadConfiguredScopeContext(projectRoot, input.scopeId, { ...options, heal: false }, 'read');
    await new DispatchInventoryPolicyAuthorization({ async load() { return c.document; } }).authorize(input.scopeId, c.principal);
    return await rollout(c, input.scopeId);
  } catch (error) { throw queryFailure(error); }
}
/** alpha.56 G4 person card: the blind review (pending cases, one verdict per case), at the person's witnessed terminal in this process. */
export async function configuredRecoveryReview<T>(projectRoot: string, scopeId: string, options: ConfigLoadOptions,
  use: (review: RecoveryReviewApplication, person: VerifiedPrincipal) => Promise<T>): Promise<T> {
  try {
    const c = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write');
    const inspection = new PolicyAdministrationInspection(createLayoutPolicySource(c.layout, userInfo().uid, c.config.inspection.policyMaxBytes));
    return await withRecords(c, true, (ports, ledger) => use(new RecoveryReviewApplication({ ...ports, load: (scope, eventId) => ledger.load(scope, eventId),
      record: event => ledger.record(event), authorize: async (principal, scope) => { await inspection.inspect(principal, { schemaVersion: 1, scopeId: scope }); }, interactive,
      policyRevision: c.document.revision, now: Date.now }), c.principal));
  } catch (error) { throw queryFailure(error); }
}
const card = (projectRoot: string, options: ConfigLoadOptions, deps: ConstructorParameters<typeof RecoveryPolicyCard>[0]) => new RecoveryPolicyCard(deps, { executable: NERVOUS_EXECUTABLE_ACTIONS,
  rollout: async scopeId => rollout(await loadConfiguredScopeContext(projectRoot, scopeId, { ...options, heal: false }, 'read'), scopeId) }, interactive);
/** alpha.56 G2 + G3 read: the recovery policy card of one scope (action grants, rule promotions, their measured exits). */
export function inspectConfiguredRecoveryPolicy(projectRoot: string, input: Readonly<{ schemaVersion: 1; scopeId: string }>, options: ConfigLoadOptions = {}) {
  return withPolicyAdministration(projectRoot, input.scopeId, options, 'read', (deps, person) => card(projectRoot, options, deps).inspect(input, person));
}
/** alpha.56 G2 + G3 change: one row on or off through `policy.administer` at the person's witnessed terminal (the card re-reads its view inside). */
export function changeConfiguredRecoveryPolicy(projectRoot: string, command: RecoveryPolicyCommand, options: ConfigLoadOptions = {}) {
  return withPolicyAdministration(projectRoot, command.scopeId, options, 'write', (deps, person) => card(projectRoot, options, deps).change(command, person));
}
