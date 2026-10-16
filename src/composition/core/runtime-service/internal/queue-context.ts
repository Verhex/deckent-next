import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { TargetQueueError } from '#domain/index.js';
import { createWorkspaceQueueAdmission, describeWorkspaceQueueCandidate, DispatchPolicyAuthorization, workTargetAttemptAuthorization } from '#engine/index.js';
import { FileArtifactStore, GitQueueTarget, openLocalIntegrityAuthority, openSqliteAttemptStore, resolveGitWorkTarget, selectWorkTarget, SqliteTargetQueue, openSqliteLedger, openSqliteLedgerReadOnly, type LocalPeerIdentity } from '#adapters/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
async function openQueueContext(root: string, scopeId: string, options: ConfigLoadOptions, peer: LocalPeerIdentity | undefined, readOnly: boolean) {
  const context = await (peer ? loadConfiguredPeerScopeContext(root, scopeId, { ...options, force: true }, peer, readOnly ? 'read' : 'write')
    : loadConfiguredScopeContext(root, scopeId, { ...options, force: true }, readOnly ? 'read' : 'write'));
  const { config, layout, principal, document, installationId } = context;
  if (!config.execution || !installationId) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
  const selected = selectWorkTarget(config.execution);
  const resolved = await resolveGitWorkTarget(resolve(root), config.execution, layout);
  if (!selected || resolved.id !== selected.id) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
  const git = { ...config.execution.git, ...resolved.git, workspaceRoot: await inspectProductDirectory(layout, 'workspaces') };
  const limits = { ...config.artifacts.patchPreview, maxBytes: config.artifacts.maxBytes };
  const target = new GitQueueTarget(git, installationId, selected.id, config.execution.adoption.targets, config.execution.adoption.protectedTargets);
  const artifacts = new FileArtifactStore({ root: await inspectProductDirectory(layout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
  const policy = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
  const authorization = workTargetAttemptAuthorization(new DispatchPolicyAuthorization(policy), policy, selected.id);
  const path = await context.path(), db = readOnly ? openSqliteLedgerReadOnly(path, config.storage.sqlite) : openSqliteLedger(path, config.storage.sqlite, 'forbid');
  const queue = new SqliteTargetQueue(db), bounds = { ...config.targetQueue, batchSize: Math.min(config.targetQueue.batchSize, config.targetQueue.chainSize) };
  try {
  const integrity = readOnly ? null : await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true);
  const writers: Awaited<ReturnType<typeof openSqliteAttemptStore>>[] = [];
  const openAttempts = async () => {
    if (readOnly) throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
    const store = await openSqliteAttemptStore(path, config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
    writers.push(store); return store;
  };
  const { app, validate, accepted } = createWorkspaceQueueAdmission(queue, authorization, principal, document.revision, bounds, integrity, { binding: ref => target.binding(ref), now: Date.now,
    async read(identity) { const store = await openAttempts(); return { run: await store.loadRun(identity.scopeId, identity.runId), outputDigest: (await store.loadBoundDispatch(identity))?.patch?.digest ?? null }; } });
  return { ...context, scopeMode: selected.scope?.mode ?? 'warn', git, limits, target: { binding: target.resolveTarget.bind(target), describe: target.describe.bind(target), fence: target.fence.bind(target) }, artifacts, authorization, queue, bounds, app, validate, accepted, openAttempts, db, integrity, describeCandidate: async (record: Parameters<typeof describeWorkspaceQueueCandidate>[0]) => describeWorkspaceQueueCandidate(record, queue, await openAttempts(), artifacts, config.artifacts.maxBytes),
    close() { for (const writer of writers) writer.close(); db.close(); } };
  } catch (error) { db.close(); throw error; }
}
export type QueueContext = Awaited<ReturnType<typeof openQueueContext>>;
export async function withQueueContext<T>(root: string, scopeId: string, options: ConfigLoadOptions, peer: LocalPeerIdentity | undefined,
  readOnly: boolean, work: (context: QueueContext) => Promise<T>): Promise<T> {
  const context = await openQueueContext(root, scopeId, options, peer, readOnly);
  try { return await work(context); } finally { context.close(); }
}
