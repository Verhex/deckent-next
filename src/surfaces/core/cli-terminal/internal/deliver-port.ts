import { loadConfig, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import type { WorkspacePatch } from '#engine/index.js';
import type { InventoryQueryHandler } from '#surfaces/core/monitor/index.js';
import type { DeliveryFileStat, TerminalDeliveryPort, VerificationCandidate } from '#surfaces/core/terminal-delivery/index.js';
import type { TerminalLaunchContext } from './context.js';
import PORT from './deliver-port.json' with { type: 'json' };

/** The newest recorded attempt of a Run's task (the identity `deckent task … --run --task` resolves); never guessed from a Run view. */
export async function resolveLatestAttempt(inspectInventory: InventoryQueryHandler, root: string, scopeId: string, runId: string, taskId: string,
  options: ConfigLoadOptions): Promise<AttemptIdentity> {
  let best: AttemptIdentity | undefined, after: string | null = null;
  do {
    const { page } = await inspectInventory(root, { schemaVersion: 1, scopeId, after }, options);
    for (const { identity } of page.entries) if (identity.runId === runId && identity.taskId === taskId && (!best || identity.generation > best.generation)) best = identity;
    after = page.nextAfter;
  } while (after !== null);
  if (!best) throw ErrorRegistry.createError('ATTEMPT_NOT_FOUND', { params: { run: runId, task: taskId } });
  return best;
}

/** `deckent task patch-preview --stat`: per-file added/removed lines from the same unified diff the CLI prints (no source read here). */
export function patchStat(changes: WorkspacePatch['changes'], render: (path: string, before: string | null, after: string | null) => string):
  Readonly<{ files: readonly DeliveryFileStat[]; added: number; removed: number }> {
  let added = 0, removed = 0;
  const files = changes.map(change => {
    let before = change.before?.text ?? null, after = change.after?.text ?? null;
    // A trailing newline is not a phantom empty line, unless it is the only difference.
    if ((before === null || before.endsWith('\n')) && (after === null || after.endsWith('\n'))) { before = before?.slice(0, -1) ?? null; after = after?.slice(0, -1) ?? null; }
    const body = change.before && change.after && change.before.text === change.after.text ? '' : render(change.path, before, after);
    const lines = body.split('\n').slice(2).filter(line => !line.startsWith('@@'));
    const plus = lines.filter(line => line.startsWith('+')).length, minus = lines.filter(line => line.startsWith('-')).length;
    added += plus; removed += minus;
    return Object.freeze({ path: change.path, added: plus, removed: minus });
  });
  return Object.freeze({ files: Object.freeze(files), added, removed });
}

/**
 * TESLIM-PENCERESI: the delivery window's port over the CLI's own handlers — inventory, patch preview, integration check and prepare, and
 * the trusted composition's verified-terminal delivery/adoption. Absent (no `/deliver`, no window) unless every handler is bound.
 */
export function terminalDeliveryPort(root: string, context: TerminalLaunchContext, options: ConfigLoadOptions): TerminalDeliveryPort | undefined {
  const { inspectInventory, previewWorkspacePatch, checkWorkspaceIntegration, prepareWorkspaceIntegration, renderUnifiedDiff, interactiveDelivery, inspectRun } = context;
  if (!inspectInventory || !previewWorkspacePatch || !checkWorkspaceIntegration || !prepareWorkspaceIntegration || !renderUnifiedDiff || !interactiveDelivery) return undefined;
  const queue = context.deliveryQueue && context.confirmDeliveryQueue ? {
    async prepareCurrent(target: Parameters<TerminalDeliveryPort['preview']>[0], commandId: string) {
      const identity = await resolveLatestAttempt(inspectInventory, root, target.scopeId, target.runId, target.taskId, options), config = await loadConfig(root, options);
      const ref = config.execution?.workTargets?.targets[0]?.baseRef;
      if (!ref) throw ErrorRegistry.createError('QUEUE_AUTHORITY_REQUIRED');
      return context.deliveryQueue!.enqueueTargetQueue({ schemaVersion: 1, commandId, identity, target: { kind: 'git-ref', id: ref } });
    },
    async inspect(scopeId: string, commandId: string) { return (await context.deliveryQueue!.inspectTargetQueue({ schemaVersion: 1, scopeId, commandId })).record; },
    confirm(scopeId: string, commandId: string, ask: Parameters<NonNullable<TerminalLaunchContext['confirmDeliveryQueue']>>[1]) { return context.confirmDeliveryQueue!({ schemaVersion: 1, scopeId, commandId }, ask); },
  } : undefined;
  return { ...(queue ? { queue } : {}),
    async preview(target) {
      const identity = await resolveLatestAttempt(inspectInventory, root, target.scopeId, target.runId, target.taskId, options);
      const preview = await previewWorkspacePatch(root, identity, options);
      // Read-only: the integration check observes the affected files of the current source; a changed base is its typed refusal.
      const checked = await checkWorkspaceIntegration(root, identity, options);
      const config = await loadConfig(root, options), stat = patchStat(preview.patch.changes, renderUnifiedDiff), verification = config.execution?.adoption.verification;
      return Object.freeze({ target, identity, ...stat, source: checked.observation.source, base: checked.observation.head, proposal: checked.proposal,
        outOfScope: checked.scope.status === 'out-of-scope' ? checked.scope.outOfScope : [], adoptionTargets: Object.freeze([...config.execution?.adoption.targets ?? []]),
        verification: verification ? Object.freeze({ kind: verification.kind, required: verification.required }) : null,
        ...(queue && config.execution?.workTargets?.targets[0] ? { queueTarget: config.execution.workTargets.targets[0].baseRef } : {}) });
    },
    async deliver(preview, ids, answer) {
      const handlers = interactiveDelivery(answer);
      // A session that is not a verified human terminal is refused before any candidate is prepared.
      await handlers.assertAvailable();
      await prepareWorkspaceIntegration(root, { schemaVersion: 1, commandId: ids.candidate, identity: preview.identity, proposal: preview.proposal }, options);
      const delivered = await handlers.deliver(root, { schemaVersion: 1, commandId: ids.delivery, identity: preview.identity, integrationCommandId: ids.candidate }, options);
      return Object.freeze({ ref: delivered.plan.ref, commit: delivered.plan.commit, commandId: ids.delivery });
    },
    async adopt(preview, delivery, targetRef, commandId, answer, verificationRunId) {
      // `task integration-adopt --verification-run`: the verifying kind is the installation's (config, read now); the adoption application
      // re-checks the Run, its kind, its commit and the bar against the same configuration.
      const verificationKind = verificationRunId === undefined ? undefined : (await loadConfig(root, options)).execution?.adoption.verification?.kind;
      if (verificationRunId !== undefined && verificationKind === undefined) throw ErrorRegistry.createError('ADOPTION_VERIFICATION_NOT_CONFIGURED');
      const handlers = interactiveDelivery(answer);
      await handlers.assertAvailable();
      const adopted = await handlers.adopt(root, { schemaVersion: 2, commandId, identity: preview.identity, deliveryCommandId: delivery.commandId, targetRef,
        ...(verificationRunId === undefined || verificationKind === undefined ? {} : { verificationRunId, verificationKind }) }, options);
      return Object.freeze({ targetRef: adopted.targetRef, fromCommit: adopted.fromCommit, toCommit: adopted.toCommit, commandId,
        verifiedBy: adopted.status === 'adopted' && adopted.verification.status === 'verified' ? adopted.verification.runId : null });
    },
    async verificationRuns(preview) {
      // Read-only: the scope's Runs seen in the inventory (newest attempts first as the inventory pages them), bounded by `scanRuns`; a Run
      // qualifies when it has one task of the configured kind and that task is accepted. Commit, profile and criteria are the adoption's checks.
      const kind = (await loadConfig(root, options)).execution?.adoption.verification?.kind;
      // Without a configured kind or a Run reader there is nothing to choose from: say why, never "none exists".
      if (kind === undefined) throw ErrorRegistry.createError('ADOPTION_VERIFICATION_NOT_CONFIGURED');
      if (!inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
      const runIds = new Set<string>(), found: VerificationCandidate[] = [];
      let after: string | null = null;
      do {
        const { page } = await inspectInventory(root, { schemaVersion: 1, scopeId: preview.identity.scopeId, after }, options);
        for (const { identity } of page.entries) if (identity.runId !== preview.identity.runId && runIds.size < PORT.scanRuns) runIds.add(identity.runId);
        after = runIds.size < PORT.scanRuns ? page.nextAfter : null;
      } while (after !== null);
      for (const runId of runIds) {
        const run = (await inspectRun(root, { schemaVersion: 1, scopeId: preview.identity.scopeId, runId }, options)).run;
        const task = run?.tasks.length === 1 ? run.tasks[0] : undefined;
        if (run && task && task.kind === kind && task.phase === 'accepted') found.push(Object.freeze({ runId, taskId: task.id }));
      }
      return Object.freeze(found);
    },
  };
}
