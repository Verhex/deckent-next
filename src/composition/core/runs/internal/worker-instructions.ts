import { randomUUID } from 'node:crypto';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, openHostProjectInstructionReader, openLocalIntegrityAuthority, openSqliteAuditStore,
  openWorkerInstructionTrust, selectWorkTarget, workerInstructionFile, workerInstructionSelection, workTargetRefFileSource } from '#adapters/index.js';
import { assertAuthorityWitness, AuditApplication, AuthorityDecisionRecords, decideWorkerInstructionTrust, workerInstructionBinding, workerInstructionBindingChange,
  workerInstructionStatus, type AuthorityWitness, type WorkerInstructionBinding, type WorkerInstructionTrustResult } from '#engine/index.js';
import { ErrorRegistry, getConfigKnownSecrets, SystemTrustedClock, type ConfigLoadOptions, type ResolvedConfig } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
/** The one answer to "which file, in which folder" for admission, `coding instructions status` and the trust path (same folder = same trust key). */
function workerInstructionPlace(projectRoot: string, config: ResolvedConfig) {
  const selected = config.execution?.workerInstructions?.source, source = selected ?? 'worker-md', target = selectWorkTarget(config.execution);
  const off = !config.execution ? 'no-execution' as const : source === 'none' ? 'source-none' as const : null;
  return { target: target?.id ?? null, root: target?.path ?? projectRoot, ref: target?.baseRef ?? null, source, file: source === 'none' ? null : workerInstructionFile(source), explicit: selected !== undefined, off };
}
const committedOf = (config: ResolvedConfig) => workTargetRefFileSource(config.projectRoot, config.execution, config.productLayout); // alpha.54 R1: a target at its base ref
const readerOf = (place: ReturnType<typeof workerInstructionPlace>, config: ResolvedConfig, options: ConfigLoadOptions) =>
  openHostProjectInstructionReader(place.root, options.env ?? process.env, getConfigKnownSecrets(config), [place.file!], committedOf(config)).catch(() => null);
/** DECKENT-MD-WORKERS (owner Q3): one bounded read of the project's selected worker instruction file at the Git work target's base ref (alpha.54 R1,
 * owner Q5: never its working tree; the project root's working tree without a target), once per admission. No Git execution configured = explicit no-op; absent selection = `worker-md` when that file exists, else nothing. */
export async function readWorkerInstructions(projectRoot: string, config: ResolvedConfig, options: ConfigLoadOptions) {
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
  return { schemaVersion: 1 as const, targets: [workerInstructionStatus(place, place.off ? null : reader ? await reader.inspect() : { status: 'blocked', reason: 'unreadable' }, reader)] };
}
const unavailable = (reason: string) => ErrorRegistry.createError('WORKER_INSTRUCTIONS_UNAVAILABLE', { params: { reason } });
const changed = (why: 'place' | 'content') => ErrorRegistry.createError('WORKER_INSTRUCTIONS_CHANGED', why === 'place' ? { params: { reason: 'place' } } : {});
/** `deckent coding instructions trust|revoke`: the person's terminal witness, then the exact place the card showed (REVISE 2734 R1) read again from
 * the current configuration — for the no-op answer, just before the decision is sealed and in the adapter's read just before the record changes.
 * Any other target, real root, source, file, file identity or digest is refused typed; nothing is sealed or written for it. */
export async function changeConfiguredWorkerInstructionTrust(projectRoot: string, input: { readonly scopeId: string; readonly action: 'trust' | 'revoke';
  readonly binding: WorkerInstructionBinding }, options: ConfigLoadOptions = {}, witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }): Promise<WorkerInstructionTrustResult> {
  await assertAuthorityWitness('workerInstructionTrust', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
  const shown = input.binding, context = await loadConfiguredScopeContext(projectRoot, input.scopeId, options, 'write'), place = workerInstructionPlace(context.config.projectRoot, context.config);
  if (place.off) throw unavailable(place.off);
  if (place.target !== shown.target || place.source !== shown.source || place.file !== shown.file) throw changed('place');
  const reader = await openWorkerInstructionTrust(place.root, options.env ?? process.env, getConfigKnownSecrets(context.config), place.file!, committedOf(context.config)).catch(() => { throw unavailable('store'); });
  const verify = async () => {
    const view = await reader.inspect();
    if (view.status === 'absent' || view.status === 'blocked') throw unavailable(view.status === 'absent' ? 'absent' : view.reason);
    const change = workerInstructionBindingChange(shown, workerInstructionBinding(place, reader, view));
    if (change) throw changed(change); return view;
  };
  const view = await verify(), result = { schemaVersion: 1 as const, action: input.action, target: shown.target, path: shown.path, digest: shown.digest };
  if ((view.status === 'ready') === (input.action === 'trust')) return { ...result, trusted: view.status === 'ready', changed: false, decisionEventId: null };
  const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid'), clock = new SystemTrustedClock(), expected = { path: shown.path, dev: shown.fileDev, ino: shown.fileIno };
  try {
    const records = new AuthorityDecisionRecords(new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true)));
    await verify(); // the decision below is sealed synchronously after this read: no other place is ever decided on
    const decisionEventId = await decideWorkerInstructionTrust({ principal: context.principal, scopeId: input.scopeId, action: input.action, commandId: randomUUID(), binding: shown },
      { policy: context.document, record: (subject, atMs) => records.record(subject, atMs), now: () => clock.sample().wallMs,
        apply: async () => { // the adapter reads once more just before the write: a change after the check is refused, never trusted or revoked elsewhere
          try { if (input.action === 'revoke') await reader.revoke(shown.digest, expected); else if ((await reader.trust(shown.digest, expected)).status !== 'ready') throw changed('content'); }
          catch (error) { throw error instanceof Error && error.message === 'changed' ? changed('place') : error; }
        } });
    return { ...result, trusted: input.action === 'trust', changed: true, decisionEventId };
  } finally { store.close(); }
}
