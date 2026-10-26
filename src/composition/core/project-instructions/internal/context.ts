import { randomUUID } from 'node:crypto';
import { prepareProductDirectory, getConfigKnownSecrets, redactForRecord, type ConfigLoadOptions } from '#platform/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { applyConfirmedEffects } from '#composition/core/approvals/index.js';
import { openHostProjectInstructionReader, previewProjectInstructions, instructionDigest, PROJECT_INSTRUCTION_REGISTRY } from '#adapters/index.js';
import { createWorkspaceScope } from '#adapters/index.js';
import { WorkspaceFileTarget, WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/index.js';
import type { ProjectInstructionPort, InstructionInitPreview } from '#engine/index.js';
import type { EffectCommand } from '#domain/index.js';

/** Same local OS principal, scoped policy, broker, file target and C11 settlement as other human/AI writes. */
async function initialize(root: string, preview: InstructionInitPreview, scopeId: string, options: ConfigLoadOptions) {
  // Reject forged previews as well as any content/path change between preview and confirmation.
  if (preview.schemaVersion !== 1 || instructionDigest(JSON.stringify(preview.changes)) !== preview.digest) throw new Error('unsafe');
  const allowed = new Set([PROJECT_INSTRUCTION_REGISTRY.files[0], ...PROJECT_INSTRUCTION_REGISTRY.bridges.map(row => row.path)]);
  if (new Set(preview.changes.map(change => change.path)).size !== preview.changes.length || preview.changes.some(change => !allowed.has(change.path))) throw new Error('unsafe');
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'write'), { layout } = context;
  const scope = await createWorkspaceScope(root);
  const target = new WorkspaceFileTarget(scope, await prepareProductDirectory(layout, 'fileEffects'));
  const descriptor = { ...WORKSPACE_FILE_WRITE_OPERATION, approval: 'required' as const };
  const commands: EffectCommand[] = preview.changes.map(change => ({ schemaVersion: 1, commandId: randomUUID(), scopeId,
    operation: descriptor.operation, target: { kind: target.kind, id: change.path }, idempotencyKey: randomUUID(), expectedVersion: change.beforeDigest, input: { content: change.after } }));
  for (const command of commands) if ((await target.observe(command.target)).version !== command.expectedVersion) throw new Error('unsafe');
  const outcomes = await applyConfirmedEffects(root, context, descriptor, target, commands, preview.digest, options);
  return commands.map((command, index) => ({ path: command.target.id, status: outcomes[index]!.status }));
}

export async function configuredProjectInstructions(root: string, options: ConfigLoadOptions = {}): Promise<ProjectInstructionPort> {
  const config = await loadComposedConfig(root, { ...options, heal: false });
  const reader = await openHostProjectInstructionReader(root, options.env ?? process.env, getConfigKnownSecrets(config));
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
