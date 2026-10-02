import { EffectError, type AgentToolOutcome, type EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, type EffectApprovalGate } from '#engine/index.js';
import { SystemTrustedClock, prepareProductDirectory } from '#platform/index.js';
import { agentFileEffectCommandId, createLocalPeerSession, openSqliteAttemptStore, type LocalPeerIdentity, type WorkspaceEditArea, type WorkspaceEditPlan } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

/**
 * Agent file edits of one turn in one area (T-L4 slice 2; SCR-A: the project, or the conversation's scratch area): the plan (version +
 * diff) is computed before authority is asked and reused for the write, so the owner approves exactly the diff that is written; the
 * write is a C11 effect of the area's Core operation (`workspace.file.write` / `workspace.scratch.write`) on its target — session,
 * operation policy, intent before effect, conditional atomic write on the planned version, evidence-based settlement and a typed
 * unknown outcome. The effect's approval gate is the caller's: it verifies the durable approval record of exactly this call (C12 G3);
 * nothing here admits a write by itself.
 */
export function createAgentFileEdits(input: { readonly area: WorkspaceEditArea; readonly peer: LocalPeerIdentity;
  readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string;
  /** MODES-3: the area's paths that decide authority (the installation's configuration file): a write there asks in every mode. */
  readonly authority?: (rel: string) => boolean }) {
  const { area, context, scopeId, turnId } = input, descriptor = area.operation;
  const plans = new Map<string, WorkspaceEditPlan>();
  const key = (tool: string, args: Record<string, unknown>) => agentToolArgumentsDigest(tool, args);
  const plan = async (tool: string, args: Record<string, unknown>) => {
    const planned = await area.plan(tool, args);
    if (planned.ok) plans.set(key(tool, args), planned);
    return planned;
  };
  return {
    /** The area's Core operation (one side of the call's decision). */
    operation: descriptor.operation,
    /** True when the planned call writes a path of the approval floor (prepare plans before authorize, on the resolved path). */
    floored(tool: string, args: Record<string, unknown>): boolean {
      const planned = plans.get(key(tool, args));
      return planned?.ok === true && area.floored(planned.rel);
    },
    /** True when the planned call writes an authority path (`edit-authority`: never lowered, full access included). */
    authority(tool: string, args: Record<string, unknown>): boolean { const planned = plans.get(key(tool, args)); return planned?.ok === true && input.authority?.(planned.rel) === true; },
    /** The planned call's resolved workspace-relative path (what an audit event names), or null when it was not planned. */
    target(tool: string, args: Record<string, unknown>): string | null { const planned = plans.get(key(tool, args)); return planned?.ok ? planned.rel : null; },
    plan,
    /** The approval card's preview: the line counts first (always visible on the card), then the planned diff. */
    preview(tool: string, args: Record<string, unknown>): string | undefined {
      const planned = plans.get(key(tool, args));
      return planned?.ok ? `(+${planned.added} −${planned.removed} lines)\n${planned.preview}` : undefined;
    },
    async apply(tool: string, args: Record<string, unknown>, execution: { readonly round: number; readonly index: number }, gate: EffectApprovalGate): Promise<AgentToolOutcome> {
      const callKey = key(tool, args);
      const planned = plans.get(callKey) ?? await plan(tool, args);
      if (!planned.ok) return { status: 'error', text: `[deckent] ${tool}: error=${planned.error}` };
      const commandId = agentFileEffectCommandId(scopeId, turnId, execution, callKey, planned.beforeVersion);
      const command: EffectCommand = { schemaVersion: 1, commandId, scopeId, operation: descriptor.operation,
        target: { kind: descriptor.targetKind, id: area.targetId(planned.rel) }, idempotencyKey: commandId, input: { content: planned.after },
        expectedVersion: planned.beforeVersion };
      const clock = new SystemTrustedClock();
      const sessions = await createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
      const target = area.target(await prepareProductDirectory(context.layout, 'fileEffects'));
      const store = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, { now: Date.now, timeoutMs: context.config.runRuntime.parking.timeoutMs }, 'forbid');
      try {
        const effects = new EffectApplication({ async resolve(ref) {
          return ref.id === descriptor.operation.id && ref.version === descriptor.operation.version ? descriptor : null;
        } }, { resolve: kind => kind === descriptor.targetKind ? target : null }, store, gate, sessions,
        new OperationPolicyAuthorization(context.policy), clock);
        const result = await effects.execute(command);
        return { status: 'ok', text: `[deckent] ${tool}: wrote ${area.shown(planned.rel)} (+${planned.added} −${planned.removed} lines, version ${String(result.version).slice(0, 12)})` };
      } catch (error) {
        const code = error instanceof EffectError ? error.code : (error as { code?: unknown })?.code;
        const why = code === 'EFFECT_PRECONDITION_CHANGED' ? 'the file changed since it was read; read it again and retry'
          : code === 'EFFECT_OUTCOME_UNKNOWN' ? 'the outcome of the write is unknown; read the file to see its state'
          : code === 'POLICY_DENIED' ? `denied by policy (operation ${descriptor.operation.id})`
          : code === 'EFFECT_APPROVAL_REQUIRED' ? 'the write needs an approval that was not given'
          : typeof code === 'string' && code.startsWith('APPROVAL_') ? `the approval for this call could not be verified (${code}); nothing was written`
          : typeof code === 'string' ? code : 'failed';
        return { status: 'error', text: `[deckent] ${tool}: error=${why} (${planned.rel})` };
      } finally { store.close(); }
    },
  };
}
