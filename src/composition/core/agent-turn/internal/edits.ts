import { createHash } from 'node:crypto';
import { EffectError, type AgentToolOutcome, type EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, type EffectApprovalGate } from '#engine/index.js';
import { SystemTrustedClock, prepareProductDirectory } from '#platform/index.js';
import { createLocalPeerSession, isWriteApprovalFloored, openSqliteAttemptStore, planWorkspaceEdit, WORKSPACE_FILE_TARGET_KIND, WORKSPACE_FILE_WRITE_OPERATION,
  WorkspaceFileTarget, type LocalPeerIdentity, type WorkspaceEditPlan, type WorkspaceScope } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Agent file edits of one turn (T-L4 slice 2): the plan (version + diff) is computed before authority is asked and reused for the
 * write, so the owner approves exactly the diff that is written; the write is a C11 effect of the Core `workspace.file.write`
 * operation on the `workspace-file` target — session, operation policy, intent before effect, conditional atomic write on the
 * planned version, evidence-based settlement and a typed unknown outcome. The effect's approval gate admits a `require-approval`
 * decision only for a call the owner approved in this turn (C12).
 */
export function createAgentFileEdits(input: { readonly scope: WorkspaceScope; readonly peer: LocalPeerIdentity;
  readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string }) {
  const { scope, context, scopeId, turnId } = input;
  const plans = new Map<string, WorkspaceEditPlan>(), approved = new Set<string>(), approvedCommands = new Set<string>();
  const key = (tool: string, args: Record<string, unknown>) => agentToolArgumentsDigest(tool, args);
  const gate: EffectApprovalGate = {
    async admit(descriptor, decision, command) {
      if (descriptor.approval !== 'required' && decision === 'allow') return;
      if (!approvedCommands.has(command.commandId)) throw new EffectError('EFFECT_APPROVAL_REQUIRED');
    },
  };
  const plan = async (tool: string, args: Record<string, unknown>) => {
    const planned = await planWorkspaceEdit(scope, tool, args);
    if (planned.ok) plans.set(key(tool, args), planned);
    return planned;
  };
  return {
    /** True when the planned call writes a path of the approval floor (prepare plans before authorize, on the resolved path). */
    floored(tool: string, args: Record<string, unknown>): boolean {
      const planned = plans.get(key(tool, args));
      return planned?.ok === true && isWriteApprovalFloored(planned.rel);
    },
    /** The operation policy's decision for the write itself, asked before the owner so a write the policy denies is never offered. */
    async authority(): Promise<'allow' | 'deny' | 'require-approval'> {
      try { return await new OperationPolicyAuthorization(context.policy).authorize('execute', scopeId, WORKSPACE_FILE_WRITE_OPERATION.operation, context.principal); }
      catch { return 'deny'; }
    },
    plan,
    /** The approval card's preview: the line counts first (always visible on the card), then the planned diff. */
    preview(tool: string, args: Record<string, unknown>): string | undefined {
      const planned = plans.get(key(tool, args));
      return planned?.ok ? `(+${planned.added} −${planned.removed} lines)\n${planned.preview}` : undefined;
    },
    approved(tool: string, args: Record<string, unknown>) { approved.add(key(tool, args)); },
    async apply(tool: string, args: Record<string, unknown>): Promise<AgentToolOutcome> {
      const callKey = key(tool, args);
      const planned = plans.get(callKey) ?? await plan(tool, args);
      if (!planned.ok) return { status: 'error', text: `[deckent] ${tool}: error=${planned.error}` };
      const commandId = sha256(`agent-file-effect:1\0${scopeId}\0${turnId}\0${callKey}\0${planned.beforeVersion}`);
      if (approved.has(callKey)) approvedCommands.add(commandId);
      const command: EffectCommand = { schemaVersion: 1, commandId, scopeId, operation: WORKSPACE_FILE_WRITE_OPERATION.operation,
        target: { kind: WORKSPACE_FILE_TARGET_KIND, id: planned.rel }, idempotencyKey: commandId, input: { content: planned.after },
        expectedVersion: planned.beforeVersion };
      const clock = new SystemTrustedClock();
      const sessions = await createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
      const target = new WorkspaceFileTarget(scope, await prepareProductDirectory(context.layout, 'fileEffects'));
      const store = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, 'forbid');
      try {
        const effects = new EffectApplication({ async resolve(ref) {
          return ref.id === WORKSPACE_FILE_WRITE_OPERATION.operation.id && ref.version === WORKSPACE_FILE_WRITE_OPERATION.operation.version ? WORKSPACE_FILE_WRITE_OPERATION : null;
        } }, { resolve: kind => kind === WORKSPACE_FILE_TARGET_KIND ? target : null }, store, gate, sessions,
        new OperationPolicyAuthorization(context.policy), clock);
        const result = await effects.execute(command);
        return { status: 'ok', text: `[deckent] ${tool}: wrote ${planned.rel} (+${planned.added} −${planned.removed} lines, version ${String(result.version).slice(0, 12)})` };
      } catch (error) {
        const code = error instanceof EffectError ? error.code : (error as { code?: unknown })?.code;
        const why = code === 'EFFECT_PRECONDITION_CHANGED' ? 'the file changed since it was read; read it again and retry'
          : code === 'EFFECT_OUTCOME_UNKNOWN' ? 'the outcome of the write is unknown; read the file to see its state'
          : code === 'POLICY_DENIED' ? `denied by policy (operation ${WORKSPACE_FILE_WRITE_OPERATION.operation.id})`
          : code === 'EFFECT_APPROVAL_REQUIRED' ? 'the write needs an approval that was not given' : typeof code === 'string' ? code : 'failed';
        return { status: 'error', text: `[deckent] ${tool}: error=${why} (${planned.rel})` };
      } finally { store.close(); }
    },
  };
}
