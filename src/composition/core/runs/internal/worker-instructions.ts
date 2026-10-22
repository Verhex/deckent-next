import { randomUUID } from 'node:crypto';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, openHostProjectInstructionReader, openLocalIntegrityAuthority, openSqliteAuditStore,
  openWorkerInstructionTrust, selectWorkTarget, workerInstructionFile, workerInstructionSelection } from '#adapters/index.js';
import { assertAuthorityWitness, AuditApplication, AuthorityDecisionRecords, decideWorkerInstructionTrust, workerInstructionStatus, type AuthorityWitness,
  type WorkerInstructionTrustResult } from '#engine/index.js';
import { ErrorRegistry, getConfigKnownSecrets, SystemTrustedClock, type ConfigLoadOptions, type CoreConfig } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** The one answer to "which file, in which folder" for admission, `coding instructions status` and the trust path (same folder = same trust key). */
function workerInstructionPlace(projectRoot: string, config: CoreConfig) {
  const selected = config.execution?.workerInstructions?.source, source = selected ?? 'worker-md', target = selectWorkTarget(config.execution);
  const off = !config.execution ? 'no-execution' as const : source === 'none' ? 'source-none' as const : null;
  return { target: target?.id ?? null, root: target?.path ?? projectRoot, source, file: source === 'none' ? null : workerInstructionFile(source), explicit: selected !== undefined, off };
}
const readerOf = (place: ReturnType<typeof workerInstructionPlace>, config: CoreConfig, options: ConfigLoadOptions) =>
  openHostProjectInstructionReader(place.root, options.env ?? process.env, getConfigKnownSecrets(config), [place.file!]).catch(() => null);
/** DECKENT-MD-WORKERS (owner Q3): one bounded read of the project's selected worker instruction file at the Git work target root, once per
 * admission. No Git execution configured = explicit no-op; absent selection = `worker-md` when that file exists, else nothing. */
export async function readWorkerInstructions(projectRoot: string, config: CoreConfig, options: ConfigLoadOptions) {
  const place = workerInstructionPlace(projectRoot, config);
  if (place.off || place.source === 'none') return { parts: [], withheld: null, oversize: false };
  // A missing or unreadable target root is a visible reason, never an unexpected admission failure (the target's own checks still apply).
  const reader = await readerOf(place, config, options);
  const { part, withheld } = workerInstructionSelection(reader ? await reader.inspect() : { status: 'blocked', reason: 'unreadable' }, place.source, place.explicit);
  // An oversized file is the same overflow refusal as a snapshot that does not fit the prompt budget; other reasons are visible warnings.
  return { parts: part ? [part] : [], oversize: withheld?.reason === 'size',
    withheld: withheld && withheld.reason !== 'size' ? { code: 'WORKER_INSTRUCTIONS_WITHHELD' as const, ...withheld, reason: withheld.reason } : null };
}
/** `deckent coding instructions status`: read-only, the configured work target's worker file and whether its current content is trusted. */
export async function inspectConfiguredWorkerInstructions(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false }), place = workerInstructionPlace(config.projectRoot, config);
  const reader = place.off ? null : await readerOf(place, config, options);
  return { schemaVersion: 1 as const, targets: [workerInstructionStatus(place, place.off ? null : reader ? await reader.inspect() : { status: 'blocked', reason: 'unreadable' })] };
}
const unavailable = (reason: string) => ErrorRegistry.createError('WORKER_INSTRUCTIONS_UNAVAILABLE', { params: { reason } });
/** `deckent coding instructions trust|revoke`: the person's terminal witness, the exact digest the card showed, a sealed decision, then the persisted record. */
export async function changeConfiguredWorkerInstructionTrust(projectRoot: string, input: { readonly scopeId: string; readonly action: 'trust' | 'revoke'; readonly digest: string;
  readonly target?: string }, options: ConfigLoadOptions = {}, witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<WorkerInstructionTrustResult> {
  await assertAuthorityWitness('workerInstructionTrust', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
  const context = await loadConfiguredScopeContext(projectRoot, input.scopeId, options, 'write'), place = workerInstructionPlace(context.config.projectRoot, context.config);
  if (input.target !== undefined && input.target !== place.target) throw unavailable('target');
  if (place.off) throw unavailable(place.off);
  const reader = await openWorkerInstructionTrust(place.root, options.env ?? process.env, getConfigKnownSecrets(context.config), place.file!).catch(() => { throw unavailable('store'); });
  const view = await reader.inspect();
  if (view.status === 'absent' || view.status === 'blocked') throw unavailable(view.status === 'absent' ? 'absent' : view.reason);
  if (view.source.digest !== input.digest) throw ErrorRegistry.createError('WORKER_INSTRUCTIONS_CHANGED');
  const result = { schemaVersion: 1 as const, action: input.action, target: place.target, path: view.source.path, digest: input.digest };
  if ((view.status === 'ready') === (input.action === 'trust')) return { ...result, trusted: view.status === 'ready', changed: false, decisionEventId: null };
  const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid'), clock = new SystemTrustedClock();
  try {
    const records = new AuthorityDecisionRecords(new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true)));
    const decisionEventId = await decideWorkerInstructionTrust({ principal: context.principal, scopeId: input.scopeId, action: input.action, commandId: randomUUID(),
      target: place.target, root: reader.root, file: place.file!, digest: input.digest }, { policy: context.document, record: (subject, atMs) => records.record(subject, atMs),
      apply: async () => { // a change between the check above and the write is refused, never trusted under the old digest
        if (input.action === 'revoke') await reader.revoke(input.digest); else if ((await reader.trust(input.digest)).status !== 'ready') throw ErrorRegistry.createError('WORKER_INSTRUCTIONS_CHANGED');
      }, now: () => clock.sample().wallMs });
    return { ...result, trusted: input.action === 'trust', changed: true, decisionEventId };
  } finally { store.close(); }
}
