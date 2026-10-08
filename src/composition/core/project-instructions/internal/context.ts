import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { prepareProductDirectory, resolveGlobalScopePaths, normalizeGlobalScopePlatform, resolveProductLayout, getConfigKnownSecrets, redactForRecord, SystemTrustedClock,
  type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { openProjectInstructionReader, previewProjectInstructions, instructionDigest, PROJECT_INSTRUCTION_REGISTRY } from '#adapters/index.js';
import { createWorkspaceScope } from '#adapters/index.js';
import { WorkspaceFileTarget, WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/index.js';
import { LocalOsSessionAuthority, openLocalIntegrityAuthority, openSqliteAttemptStore, openSqliteApprovalStore } from '#adapters/index.js';
import { EffectApplication, OperationApprovalBroker, OperationPolicyAuthorization, type ProjectInstructionPort, type InstructionInitPreview } from '#engine/index.js';
import type { EffectCommand } from '#domain/index.js';

/** Same local OS principal, scoped policy, broker, file target and C11 settlement as other human/AI writes. */
async function initialize(root: string, preview: InstructionInitPreview, scopeId: string, options: ConfigLoadOptions) {
  // Reject forged previews as well as any content/path change between preview and confirmation.
  if (preview.schemaVersion !== 1 || instructionDigest(JSON.stringify(preview.changes)) !== preview.digest) throw new Error('unsafe');
  const allowed = new Set([PROJECT_INSTRUCTION_REGISTRY.files[0], ...PROJECT_INSTRUCTION_REGISTRY.bridges.map(row => row.path)]);
  if (new Set(preview.changes.map(change => change.path)).size !== preview.changes.length || preview.changes.some(change => !allowed.has(change.path))) throw new Error('unsafe');
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'write'), { config, layout, principal } = context;
  const scope = await createWorkspaceScope(root);
  const target = new WorkspaceFileTarget(scope, await prepareProductDirectory(layout, 'fileEffects'));
  const descriptor = { ...WORKSPACE_FILE_WRITE_OPERATION, approval: 'required' as const };
  const commands: EffectCommand[] = preview.changes.map(change => ({ schemaVersion: 1, commandId: randomUUID(), scopeId,
    operation: descriptor.operation, target: { kind: target.kind, id: change.path }, idempotencyKey: randomUUID(), expectedVersion: change.beforeDigest, input: { content: change.after } }));
  for (const command of commands) if ((await target.observe(command.target)).version !== command.expectedVersion) throw new Error('unsafe');
  const clock = new SystemTrustedClock(), policy = createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes);
  const sessions = await LocalOsSessionAuthority.create(principal.scopeIds, config.approvals.sessionTtlMs, clock);
  const integrity = await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true), path = await context.path();
  const store = await openSqliteAttemptStore(path, config.storage.sqlite, { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
  const approvals = openSqliteApprovalStore(path, config.storage.sqlite);
  try {
    const broker = new OperationApprovalBroker(approvals.store, integrity, policy, clock,
      { requestTtlMs: config.approvals.requestTtlMs, defaultAdmitWithinMs: config.approvals.requestTtlMs });
    const app = new EffectApplication({ resolve: async ref => ref.id === descriptor.operation.id && ref.version === descriptor.operation.version ? descriptor : null },
      { resolve: kind => kind === target.kind ? target : null }, store, broker, sessions, new OperationPolicyAuthorization(policy), clock);
    const result = [];
    for (const command of commands) {
      let outcome = await app.submit('execute', command);
      if (outcome.status === 'approval-pending') {
        // The init window just confirmed this complete preview; its decision remains subject to normal approval authority.
        await configuredApproval(root, 'decide', { schemaVersion: 1, commandId: randomUUID(), scopeId, approvalId: outcome.approval.approvalId,
          expectedRevision: outcome.approval.revision, decision: 'allow', reason: preview.digest, channel: 'local-terminal-card' }, options);
        outcome = await app.submit('execute', command);
      }
      result.push({ path: command.target.id, status: outcome.status });
    }
    return result;
  } finally { approvals.close(); store.close(); }
}

export async function configuredProjectInstructions(root: string, options: ConfigLoadOptions = {}): Promise<ProjectInstructionPort> {
  const config = await loadComposedConfig(root, { ...options, heal: false }), env = options.env ?? process.env;
  const global = resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, env), env, { ignoreProjectOverride: true });
  const layout = resolveProductLayout({ projectRoot: global.stateDir, root: global.stateDir });
  // Unsupported platforms keep consent in this session; they never read an unverified trust cache.
  const directory = await prepareProductDirectory(layout, 'instructionTrust').catch(() => null);
  const reader = await openProjectInstructionReader(root, directory, getConfigKnownSecrets(config))
    .catch(() => openProjectInstructionReader(root, null, getConfigKnownSecrets(config)));
  const issued = new WeakMap<InstructionInitPreview, string>();
  return { inspect: reader.inspect, trust: reader.trust,
    async preview(bridges, skeleton) { const known = getConfigKnownSecrets(config);
      const view = await previewProjectInstructions(reader.root, bridges, (name, commands) => redactForRecord(skeleton(redactForRecord(name, known), commands), known)); issued.set(view, JSON.stringify(view)); return view; },
    async initialize(preview) {
      if (issued.get(preview) !== JSON.stringify(preview)) throw new Error('unsafe');
      issued.delete(preview);
      const scope = (config as unknown as { terminal?: { scopeId?: string } }).terminal?.scopeId;
      if (!scope) throw new Error('TERMINAL_SCOPE_REQUIRED');
      return initialize(reader.root, preview, scope, options);
    } };
}
