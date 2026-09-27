import type { AgentToolSpec } from '#domain/index.js';
import { agentToolArgumentsDigest, agentToolCallApprovalGate, type AgentToolCallAdmission, type EffectApprovalGate } from '#engine/index.js';
import type { TrustedClock } from '#platform/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

type Execution = { readonly round: number; readonly index: number };
const displayTarget = (args: Record<string, unknown>) => typeof args['path'] === 'string' ? args['path'] : typeof args['pattern'] === 'string' ? args['pattern'] : null;
/** What a call's line and its approval name: the shell command (first 200 characters; the arguments digest binds the rest) or the path. */
export const describeAgentCall = (tool: AgentToolSpec, args: Record<string, unknown>) => tool.toolClass === 'shell' && typeof args['command'] === 'string'
  ? (args['command'].length > 200 ? `${args['command'].slice(0, 199)}…` : args['command']) : displayTarget(args);

/**
 * Owner approvals of one turn's edit and shell calls at their effects (C12 G3). The subject is built by one function when the owner is
 * asked and again from the executed call, so the effect gate compares the stored record with the call that actually runs. What the turn
 * keeps is a pointer (which record an allow named, by call position) and the per-turn record of which command consumed which approval;
 * neither admits anything — the engine gate reads and verifies the durable record.
 */
export function createAgentCallApprovals(input: { readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly clock: TrustedClock;
  readonly scopeId: string; readonly turnId: string }) {
  const { context, clock, scopeId, turnId } = input;
  const allowed = new Map<string, NonNullable<AgentToolCallAdmission['approval']>>(), consumed = new Map<string, string>();
  const position = (execution: Execution) => `${execution.round}\0${execution.index}`;
  const subject = (execution: Execution, tool: AgentToolSpec, target: string | null, argsDigest: string) => ({ kind: 'agent-tool-call' as const,
    turnId, round: execution.round, index: execution.index, tool: tool.name, toolVersion: tool.version, resource: target ?? '(no target)', argsDigest });
  return {
    subject,
    /** Records which stored approval the owner allowed for this call position (after policy re-evaluation and the expiry check). */
    allowed(execution: Execution, approval: NonNullable<AgentToolCallAdmission['approval']>) { allowed.set(position(execution), approval); },
    /** The effect gate of one edit or shell call. The approval ledger and the integrity key (never created here) are opened only when the
     * gate needs the record; `close` releases them after the effect. */
    gate(tool: AgentToolSpec, args: Record<string, unknown>, execution: Execution): { readonly gate: EffectApprovalGate; close(): Promise<void> } {
      type Records = { store: ReturnType<typeof openSqliteApprovalStore>['store']; integrity: Awaited<ReturnType<typeof openLocalIntegrityAuthority>>; close: () => void };
      let opened: Promise<Records> | null = null;
      const approval = allowed.get(position(execution)) ?? null;
      allowed.delete(position(execution));
      const records = () => (opened ??= (async () => {
        const journal = openSqliteApprovalStore(await context.path(), context.config.storage.sqlite);
        try { return { store: journal.store, integrity: await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, false), close: journal.close }; }
        catch (error) { journal.close(); throw error; }
      })());
      const gate = agentToolCallApprovalGate(records, clock, { scopeId,
        subject: subject(execution, tool, describeAgentCall(tool, args), agentToolArgumentsDigest(tool.name, args)), approval }, consumed);
      return { gate, async close() { if (opened) (await opened.catch(() => null))?.close(); } };
    },
  };
}
