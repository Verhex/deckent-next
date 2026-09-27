import { createHash } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, AUDIT_SHELL_HEAD_MAX_CHARS, EffectError, type AgentToolOutcome, type AgentToolSpec, type AuditEvent } from '#domain/index.js';
import { AuditApplication, PolicyAuthorizationError, agentToolArgumentsDigest, decideAgentToolCall, type AgentToolCallCell, type AgentToolCallDecision,
  type EffectApprovalGate, type ShellPermissionTier } from '#engine/index.js';
import type { TrustedClock } from '#platform/index.js';
import { HOST_SHELL_RUN_OPERATION, openLocalIntegrityAuthority, openSqliteAuditStore, WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import type { createAgentFileEdits } from './edits.js';
import type { createAgentShell } from './shell.js';
import type { createAgentCallApprovals } from './call-approvals.js';

type Execution = { readonly round: number; readonly index: number };
type Context = Awaited<ReturnType<typeof loadPeerInvocationContext>>;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const SHELL_CELLS: Readonly<Record<ShellPermissionTier, AgentToolCallCell>> = { 'read-none': 'shell-read-none', 'read-low': 'shell-read-low',
  'narrow-mutating': 'shell-narrow-mutating', destructive: 'shell-destructive', 'always-ask': 'shell-always-ask', 'other-modify': 'shell-other-modify' };
/** Summary counters of decisions that were silent without any mode (owner q5): counted, not recorded. */
export const SILENT_DECISION_COUNTERS = Object.freeze({ edit: 'agent-tool.silent.edit', shell: 'agent-tool.silent.shell' });
/** Audit event identity of a mode relaxation: one per call position of a turn (the effect gate may be asked several times). */
export const permissionModeEventId = (scopeId: string, turnId: string, execution: Execution, argsDigest: string) =>
  sha256(`permission-mode:1\0${scopeId}\0${turnId}\0${execution.round}\0${execution.index}\0${argsDigest}`);

type Stored = { readonly cell: AgentToolCallCell; readonly decision: AgentToolCallDecision } | { readonly planError: string };

/**
 * The permission decision of one turn's tool calls (T-L4 slice 4a): the one pure `decideAgentToolCall` over a fresh policy + bindings
 * snapshot, asked when the loop authorizes a call and again at its effect. `authorize` answers `deny` before anything is planned; then
 * the call is planned (the plan is the cell) and the whole decision — strict policy, floor raise, mode lowering — is kept for the
 * call, so `prepare` repeats it and never re-raises a lowered call. At the effect a call the owner was not asked for is decided again:
 * a mode relaxation writes its sealed `permission-mode` audit event before the effect (no event, nothing runs) and the effect gate
 * re-decides on every admission; a decision that was silent without a mode is counted. Owner-approved calls keep the C12 gate as is.
 */
export function createAgentCallDecisions(input: { readonly context: Context; readonly clock: TrustedClock; readonly scopeId: string; readonly turnId: string;
  readonly edits: ReturnType<typeof createAgentFileEdits> | null; readonly shell: ReturnType<typeof createAgentShell> | null;
  readonly approvals: ReturnType<typeof createAgentCallApprovals> }) {
  const { context, clock, scopeId, turnId, edits, shell, approvals } = input;
  const stored = new Map<string, Stored>();
  const keyOf = (tool: AgentToolSpec, args: Record<string, unknown>) => agentToolArgumentsDigest(tool.name, args);
  const operationOf = (tool: AgentToolSpec) => tool.toolClass === 'edit' ? WORKSPACE_FILE_WRITE_OPERATION.operation
    : tool.toolClass === 'shell' ? HOST_SHELL_RUN_OPERATION.operation : null;
  const load = async (): Promise<unknown> => { try { return await context.policy.load(); } catch { return null; } };
  /** Pure decision on one snapshot (a fresh one unless given); an unreadable or invalid policy is null, i.e. `deny` (fail closed). */
  const decide = async (tool: AgentToolSpec, cell: AgentToolCallCell, snapshot?: unknown): Promise<AgentToolCallDecision | null> => {
    const policy = snapshot === undefined ? await load() : snapshot;
    try { return policy === null ? null : decideAgentToolCall(policy, { principal: context.principal, scopeId, tool, operation: operationOf(tool), cell }); }
    catch { return null; }
  };
  const cellOf = (tool: AgentToolSpec, args: Record<string, unknown>): AgentToolCallCell | null => {
    if (tool.toolClass === 'edit') return edits?.target(tool.name, args) === null || !edits ? null : edits.floored(tool.name, args) ? 'edit-floor' : 'edit';
    if (tool.toolClass === 'shell') { const tier = shell?.tier(tool.name, args) ?? null; return tier === null ? null : SHELL_CELLS[tier]; }
    return 'read';
  };
  const withAudit = async <T>(work: (audit: AuditApplication) => T): Promise<T> => {
    const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
    try { return work(new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true))); }
    finally { store.close(); }
  };
  return {
    async authorize(tool: AgentToolSpec, args: Record<string, unknown> | undefined): Promise<'allow' | 'deny' | 'require-approval'> {
      if (!args) return (await decide(tool, 'read'))?.decision === 'deny' ? 'deny' : 'require-approval';
      const key = keyOf(tool, args);
      stored.delete(key);
      // One snapshot for the whole authorization. Policy first: the cell is irrelevant to a deny, and a denied call is answered
      // before its target is planned (no content leaks).
      const snapshot = await load();
      const first = await decide(tool, 'read', snapshot);
      if (!first || first.decision === 'deny') return 'deny';
      if (tool.toolClass === 'read') { stored.set(key, { cell: 'read', decision: first }); return first.decision; }
      const planned = tool.toolClass === 'edit' && edits ? await edits.plan(tool.name, args).then(plan => plan.ok ? null : `[deckent] ${tool.name}: error=${plan.error}`)
        : tool.toolClass === 'shell' && shell ? await shell.plan(tool.name, args).then(plan => plan.ok ? null : plan.text) : `[deckent] ${tool.name}: error=unknown-tool`;
      const cell = planned === null ? cellOf(tool, args) : null;
      if (planned !== null || cell === null) { stored.set(key, { planError: planned ?? `[deckent] ${tool.name}: error=failed` }); return 'require-approval'; }
      const decision = await decide(tool, cell, snapshot);
      if (!decision) return 'deny';
      stored.set(key, { cell, decision });
      return decision.decision;
    },
    /** The loop's prepare: the plan's error, or the kept decision (a call without a kept decision asks). */
    prepare(tool: AgentToolSpec, args: Record<string, unknown>): { readonly ok: true; readonly requireApproval: boolean } | { readonly ok: false; readonly text: string } {
      const kept = stored.get(keyOf(tool, args));
      if (kept && 'planError' in kept) return { ok: false, text: kept.planError };
      return { ok: true, requireApproval: kept?.decision.decision !== 'allow' };
    },
    /**
     * Runs one edit or shell call at its effect with the right gate. `run` performs the C11 effect with the gate it is given.
     * Owner-approved calls use the C12 gate unchanged; every other call is decided again now (deny → nothing runs; still asking →
     * nothing runs), a mode relaxation is audited first, and a silent decision is counted.
     */
    async execute(tool: AgentToolSpec, args: Record<string, unknown>, execution: Execution, callId: string,
      run: (gate: EffectApprovalGate) => Promise<AgentToolOutcome>): Promise<AgentToolOutcome> {
      const key = keyOf(tool, args), kept = stored.get(key);
      const { gate: inner, close } = approvals.gate(tool, args, execution);
      try {
        if (!kept || 'planError' in kept || kept.decision.decision !== 'allow') return await run(inner);
        const fresh = await decide(tool, kept.cell);
        if (!fresh || fresh.decision === 'deny') return { status: 'error', text: `[deckent] ${tool.name}: error=denied-by-policy (the policy changed; nothing ran)` };
        if (fresh.decision !== 'allow') return { status: 'error', text: `[deckent] ${tool.name}: error=approval-required (the policy changed; nothing ran)` };
        const relaxation = fresh.relaxation;
        if (!relaxation) {
          // A summary, not evidence: a counter that cannot be written does not stop a decision that needed no mode.
          await withAudit(audit => audit.count(scopeId, SILENT_DECISION_COUNTERS[tool.toolClass === 'edit' ? 'edit' : 'shell'], 1, clock.sample().wallMs)).catch(() => undefined);
          return await run(inner);
        }
        const argsDigest = agentToolArgumentsDigest(tool.name, args), path = edits?.target(tool.name, args) ?? null, command = String(args['command'] ?? '');
        const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: permissionModeEventId(scopeId, turnId, execution, argsDigest), scopeId,
          principal: { issuer: context.principal.issuer, subject: context.principal.subject }, policyRevision: fresh.revision, atMs: clock.sample().wallMs,
          subject: { kind: 'permission-mode', mode: relaxation.mode, cell: relaxation.cell, tool: { name: tool.name, version: tool.version },
            call: { turnId, round: execution.round, index: execution.index, callId }, grants: { company: relaxation.company, person: relaxation.person },
            decision: { previous: 'require-approval', next: 'allow' },
            summary: tool.toolClass === 'edit' ? { kind: 'edit', path: path ?? '' } : { kind: 'shell', head: command.slice(0, AUDIT_SHELL_HEAD_MAX_CHARS), argsDigest } } };
        // No audit, no relaxation: the event is durable before anything is written or spawned.
        try { await withAudit(audit => audit.record(event)); }
        catch { return { status: 'error', text: `[deckent] ${tool.name}: error=audit-unavailable (the permission mode's decision could not be recorded; nothing ran)` }; }
        return await run({
          async admit(descriptor, decision, command, principal, context) {
            const terminal = context.record && (context.record.state === 'settled' || context.record.state === 'refused');
            if (!terminal) {
              if (descriptor.approval === 'required') throw new EffectError('EFFECT_APPROVAL_REQUIRED');
              // The same decision again on the policy as it is now: a deny since wins, a lost relaxation asks (nothing runs here).
              const again = await decide(tool, kept.cell);
              if (!again || again.decision === 'deny') throw new PolicyAuthorizationError('POLICY_DENIED');
              if (again.decision !== 'allow') throw new EffectError('EFFECT_APPROVAL_REQUIRED');
              return inner.admit(descriptor, 'allow', command, principal, context);
            }
            return inner.admit(descriptor, decision, command, principal, context);
          },
        });
      } finally { await close(); }
    },
  };
}
