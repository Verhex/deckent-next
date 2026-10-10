import { createHash } from 'node:crypto';
import { EffectError, type AgentToolOutcome, type AgentToolSpec, type AuditEvent } from '#domain/index.js';
import { AuditApplication, recordAuditSummary, PolicyAuthorizationError, agentCallAuditEvent, approvedWriteEntryAuditEvent, agentToolArgumentsDigest, decideAgentToolCall, isAuditedDecision, type AgentToolCallCell, type AgentToolCallDecision,
  type AgentToolCallRequest, type EffectApprovalGate, isAuditedStanding, standingApprovalAuditEvent, standingCallKey, rememberSessionStanding, type SessionStanding, type ShellPermissionTier,
  trackedFilesAuditEvent, type TrackedFilesAuditList } from '#engine/index.js';
import { getConfigKnownSecrets, redactForRecord, type TrustedClock } from '#platform/index.js';
import { FETCH_URL_TOOL_SPEC, HOST_SHELL_RUN_OPERATION, type SandboxWriteCell, type SandboxWriteDecider, type ShellCallAuthority, MCP_TOOL_CALL_OPERATION, NETWORK_FETCH_OPERATION, openLocalIntegrityAuthority, openSqliteAuditStore,
  WORKSPACE_FILE_WRITE_OPERATION } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import type { createAgentFileEdits } from './edits.js';
import type { createAgentShell } from './shell.js';
import type { createAgentFetch } from './fetch.js';
import type { createAgentCallApprovals } from './call-approvals.js';
import type { createAgentMcp } from './mcp.js';
type Execution = { readonly round: number; readonly index: number };
type Context = Awaited<ReturnType<typeof loadPeerInvocationContext>>;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const SHELL_CELLS: Readonly<Record<ShellPermissionTier, AgentToolCallCell>> = { 'read-none': 'shell-read-none', 'read-low': 'shell-read-low',
  'narrow-mutating': 'shell-narrow-mutating', destructive: 'shell-destructive', 'always-ask': 'shell-always-ask', 'other-modify': 'shell-other-modify' };
export const SILENT_DECISION_COUNTERS = Object.freeze({ edit: 'agent-tool.silent.edit', shell: 'agent-tool.silent.shell' }); // Silent without any mode (owner q5): counted, not recorded.
/** Audit event identity of a mode relaxation (or, tag `full-access-call`, a full-access call): one per call position of a turn (the effect
 * gate may be asked several times). */
export const permissionModeEventId = (scopeId: string, turnId: string, execution: Execution, argsDigest: string, tag = 'permission-mode') =>
  sha256(`${tag}:1\0${scopeId}\0${turnId}\0${execution.round}\0${execution.index}\0${argsDigest}`);

type Shell = AgentToolCallRequest['shell'];
type Stored = { readonly cell: AgentToolCallCell; readonly shell: Shell; readonly decision: AgentToolCallDecision } | { readonly planError: string };
const hostOf = (args: Record<string, unknown>) => { try { return new URL(String(args['url'])).hostname || 'unknown'; } catch { return 'unknown'; } };

/** One use of the Core audit port for a turn (the integrity key is created on first use, like an approval's). */
export async function withAgentAudit<T>(context: Context, work: (audit: AuditApplication) => T): Promise<T> {
  const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
  try { return work(new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true))); }
  finally { store.close(); }
}

/** One fresh policy/cell/mode/standing decision at authorization and again at the effect.
 * Audit every relaxation before effect admission, then recheck it; owner-approved calls retain C12. */
export function createAgentCallDecisions(input: { readonly context: Context; readonly clock: TrustedClock; readonly scopeId: string; readonly turnId: string;
  readonly edits: (tool: string) => ReturnType<typeof createAgentFileEdits> | null; readonly shell: ReturnType<typeof createAgentShell> | null;
  readonly approvals: ReturnType<typeof createAgentCallApprovals>; readonly fetch: ReturnType<typeof createAgentFetch> | null;
  readonly mcp?: Awaited<ReturnType<typeof createAgentMcp>>;
  /** This conversation's "this session" memory (a service-process map). */
  readonly standing?: { readonly memory: SessionStanding; readonly session: string };
  /** MODES-3: the turn was launched in full access (admitted and audited by the turn); every decision asks the company grant again. */
  readonly fullAccess?: boolean }) {
  const { context, clock, scopeId, turnId, edits, shell, approvals, fetch } = input, mcp = input.mcp ?? null;
  const fetches = (tool: AgentToolSpec) => tool.name === FETCH_URL_TOOL_SPEC.name;
  const mcps = (tool: AgentToolSpec) => tool.toolClass === 'mcp';
  const stored = new Map<string, Stored>(), knownSecrets = getConfigKnownSecrets(context.config);
  const keyOf = (tool: AgentToolSpec, args: Record<string, unknown>) => agentToolArgumentsDigest(tool.name, args);
  // An edit tool no area serves still carries the project's write operation (never a one-sided decision).
  const operationOf = (tool: AgentToolSpec) => tool.toolClass === 'edit' ? edits(tool.name)?.operation ?? WORKSPACE_FILE_WRITE_OPERATION.operation
    : tool.toolClass === 'shell' ? HOST_SHELL_RUN_OPERATION.operation : fetches(tool) ? NETWORK_FETCH_OPERATION.operation
    : mcps(tool) ? MCP_TOOL_CALL_OPERATION.operation : null;
  // Standing approvals (G6) cover only the edit and shell cells a standing pattern names; any other cell (fetch, MCP) has none.
  const standingOf = (tool: AgentToolSpec, cell: AgentToolCallCell, args: Record<string, unknown> | undefined) => !args ? null : standingCallKey({ tool: tool.name, cell,
    path: tool.toolClass === 'edit' ? edits(tool.name)?.target(tool.name, args) ?? null : cell === 'edit-self-source' && typeof args['path'] === 'string' ? args['path'] : null, command: typeof args['command'] === 'string' ? args['command'] : null },
  input.standing && { sessions: input.standing.memory, session: input.standing.session }, knownSecrets);
  const load = async (): Promise<unknown> => { try { return await context.policy.load(); } catch { return null; } };
  /** Pure decision on one snapshot (a fresh one unless given); an unreadable or invalid policy is null, i.e. `deny` (fail closed). */
  const decide = async (tool: AgentToolSpec, cell: AgentToolCallCell, snapshot?: unknown, args?: Record<string, unknown>, shellInput?: Shell,
    operation: { readonly id: string } | null = operationOf(tool), probeSession = false): Promise<AgentToolCallDecision | null> => {
    const policy = snapshot === undefined ? await load() : snapshot;
    const standing = standingOf(tool, cell, args);
    // An MCP tool is authorized on its server (`mcp-server`); a tool the turn does not know cannot name one and fails on the `agent-tool` side.
    const server = mcps(tool) ? mcp?.server(tool.name) ?? undefined : undefined;
    try { return policy === null ? null : decideAgentToolCall(policy, { principal: context.principal, scopeId, tool, operation, cell, ...(server === undefined ? {} : { mcpServer: server }),
      standing: probeSession && standing ? { ...standing, session: true } : standing,
      ...(shellInput ? { shell: shellInput } : {}), ...(input.fullAccess ? { fullAccess: true } : {}) }); }
    catch { return null; }
  };
  const cellOf = (tool: AgentToolSpec, args: Record<string, unknown>): AgentToolCallCell | null => {
    if (tool.toolClass === 'edit') {
      const area = edits(tool.name);
      return !area || area.target(tool.name, args) === null ? null : area.authority(tool.name, args) ? 'edit-authority' : area.floored(tool.name, args) ? 'edit-floor' : !input.fullAccess && area.selfSource(tool.name, args) ? 'edit-self-source' : 'edit';
    }
    if (tool.toolClass === 'shell') { const tier = shell?.tier(tool.name, args) ?? null; return tier === null ? null : SHELL_CELLS[tier]; }
    if (fetches(tool)) return fetch?.cell(args) ?? null;
    if (mcps(tool)) return mcp?.cell(tool.name) ?? null;
    return 'read';
  };
  const withAudit = <T>(work: (audit: AuditApplication) => T) => withAgentAudit(context, work);
  const callSummary = (tool: AgentToolSpec, args: Record<string, unknown>) => recordAuditSummary(tool.toolClass === 'edit' ? { kind: 'edit' as const, path: edits(tool.name)?.target(tool.name, args) ?? '' }
    : mcps(tool) ? { kind: 'mcp' as const, tool: (mcp?.display(tool.name) ?? tool.name), argsDigest: agentToolArgumentsDigest(tool.name, args) }
    : fetches(tool) ? { kind: 'fetch' as const, host: hostOf(args), argsDigest: agentToolArgumentsDigest(tool.name, args) }
    : { kind: 'shell' as const, head: String(args['command'] ?? ''), argsDigest: agentToolArgumentsDigest(tool.name, args) }, knownSecrets);
  const standingEvent = (phase: 'remembered' | 'used', tool: AgentToolSpec, args: Record<string, unknown>, execution: Execution, callId: string, cell: Parameters<typeof standingApprovalAuditEvent>[0]['cell'],
    revision: string, standing: Parameters<typeof standingApprovalAuditEvent>[0]['standing'], approvalId: string | null, summary = callSummary(tool, args)) => standingApprovalAuditEvent({ phase, scopeId, turnId, execution, callId,
    principal: context.principal, revision, atMs: clock.sample().wallMs, standing, cell, approvalId, tool, argsDigest: agentToolArgumentsDigest(tool.name, args), summary });
  /**
   * SHELL-OVERLAY (design §6): the decider of one shell call's write set. Each entry is decided exactly like an edit of its path — the tool
   * that wrote it (`run_shell`) on the agent-tool side, `workspace.file.write` on the operation side, the edit cell of its path — on a fresh
   * snapshot. A relaxation is audited before the entry's effect (its own `permission-mode` event; no event, no write); a silent allow is
   * counted; anything that still asks (the write floor, the configuration file, `askEdits`, a company rule no mode lowers) or denies is not
   * applied. The entry's effect gate decides again and admits only the audited decision (as `execute` does for the call itself).
   */
  const writeSet = (tool: AgentToolSpec, args: Record<string, unknown>, execution: Execution, callId: string): SandboxWriteDecider => ({
    async decide(rel: string, cell: SandboxWriteCell) {
      const writeOperation = WORKSPACE_FILE_WRITE_OPERATION.operation;
      const again = () => decide(tool, cell, undefined, { path: rel }, undefined, writeOperation);
      const fresh = await again();
      if (!fresh || fresh.decision === 'deny') return { ok: false, reason: 'denied-by-policy' };
      if (fresh.decision !== 'allow') return { ok: false, reason: cell === 'edit' ? 'approval-required' : cell === 'edit-authority' ? 'configuration-file' : 'write-floor' };
      const audited = fresh.relaxation !== null || fresh.fullAccess !== undefined || fresh.standing !== undefined;
      if (audited) {
        const event = fresh.standing ? standingEvent('used', tool, { path: rel }, execution, callId, cell as Parameters<typeof standingApprovalAuditEvent>[0]['cell'],
          fresh.revision, fresh.standing, null, { kind: 'edit', path: redactForRecord(rel, knownSecrets).slice(0, 4096) }) : agentCallAuditEvent({ scopeId, principal: context.principal, atMs: clock.sample().wallMs, tool, summary: { kind: 'edit', path: redactForRecord(rel, knownSecrets).slice(0, 4096) },
          eventId: permissionModeEventId(scopeId, turnId, execution, sha256(`${agentToolArgumentsDigest(tool.name, args)}\0${rel}`), 'sandbox-write'),
          call: { turnId, round: execution.round, index: execution.index, callId } }, fresh);
        try { await withAudit(audit => audit.record(event)); } catch { return { ok: false, reason: 'audit-unavailable' }; }
      } else await withAudit(audit => audit.count(scopeId, SILENT_DECISION_COUNTERS.edit, 1, clock.sample().wallMs)).catch(() => undefined);
      return { ok: true, gate: {
        // The operation side's own require-approval is what the audited relaxation lowered (as `execute` passes `allow` to its inner gate).
        async admit(descriptor, _decision, _command, _principal, effect) {
          const terminal = effect.record && (effect.record.state === 'settled' || effect.record.state === 'refused');
          if (terminal) return;
          if (descriptor.approval === 'required') throw new EffectError('EFFECT_APPROVAL_REQUIRED');
          const now = await again();
          if (!now || now.decision === 'deny') throw new PolicyAuthorizationError('POLICY_DENIED');
          if (!(fresh.standing ? isAuditedStanding(fresh.standing, fresh.revision, now) : audited ? isAuditedDecision(fresh, now) : now.decision === 'allow' && now.relaxation === null && now.fullAccess === undefined)) throw new EffectError('EFFECT_APPROVAL_REQUIRED');
        },
      } };
    },
  });
  /** SBX-05 x company policy (lead 2026-10-09): an owner-approved destructive call's write set. Denies and the configuration file are refused, a
   * floor-named directory is never made; an entry the decision still asks for is applied as card-approved, recorded with `approvalId` first. */
  const approvedWriteSet = (tool: AgentToolSpec, args: Record<string, unknown>, execution: Execution, callId: string, approvalId: string): SandboxWriteDecider => ({
    async decide(rel: string, cell: SandboxWriteCell) {
      if (cell === 'edit-authority') return { ok: false, reason: 'configuration-file' };
      if (cell !== 'edit' && rel.endsWith('/')) return { ok: false, reason: 'write-floor' };
      const first = await writeSet(tool, args, execution, callId).decide(rel, cell);
      if (first.ok || (first.reason !== 'approval-required' && first.reason !== 'write-floor')) return first;
      const again = () => decide(tool, cell, undefined, { path: rel }, undefined, WORKSPACE_FILE_WRITE_OPERATION.operation), fresh = await again();
      if (!fresh || fresh.decision === 'deny') return { ok: false, reason: 'denied-by-policy' };
      const event = approvedWriteEntryAuditEvent({ scopeId, principal: context.principal, atMs: clock.sample().wallMs, tool, summary: { kind: 'edit', path: redactForRecord(rel, knownSecrets).slice(0, 4096) },
        eventId: permissionModeEventId(scopeId, turnId, execution, sha256(`${agentToolArgumentsDigest(tool.name, args)}\0${rel}`), 'sandbox-write-approved'),
        call: { turnId, round: execution.round, index: execution.index, callId } }, fresh.revision, approvalId, cell);
      try { await withAudit(audit => audit.record(event)); } catch { return { ok: false, reason: 'audit-unavailable' }; }
      return { ok: true, gate: { async admit(descriptor, _decision, _command, _principal, effect) {
        if (effect.record && (effect.record.state === 'settled' || effect.record.state === 'refused')) return;
        if (descriptor.approval === 'required') throw new EffectError('EFFECT_APPROVAL_REQUIRED');
        const now = await again();
        if (!now || now.decision === 'deny' || now.revision !== fresh.revision) throw new PolicyAuthorizationError('POLICY_DENIED');
      } } };
    },
  });
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
      if (tool.toolClass === 'read') { stored.set(key, { cell: 'read', shell: undefined, decision: first }); return first.decision; }
      const area = tool.toolClass === 'edit' ? edits(tool.name) : null;
      const planned = area ? await area.plan(tool.name, args).then(plan => plan.ok ? null : `[deckent] ${tool.name}: error=${plan.error}`)
        : tool.toolClass === 'shell' && shell ? await shell.plan(tool.name, args).then(plan => plan.ok ? null : plan.text)
        : fetches(tool) && fetch ? (plan => plan.ok ? null : `[deckent] ${tool.name}: error=${plan.error}`)(fetch.plan(args))
        : mcps(tool) && mcp ? mcp.plan(tool.name, args) : `[deckent] ${tool.name}: error=unknown-tool`;
      const cell = planned === null ? cellOf(tool, args) : null;
      if (planned !== null || cell === null) { stored.set(key, { planError: planned ?? `[deckent] ${tool.name}: error=failed` }); return 'require-approval'; }
      const shellInput = tool.toolClass === 'shell' ? shell?.containment(tool.name, args) : undefined, decision = await decide(tool, cell, snapshot, args, shellInput);
      if (!decision) return 'deny';
      stored.set(key, { cell, shell: shellInput, decision });
      return decision.decision;
    },
    /** B1 card facts: the permission cell this call was planned as (null: not planned, e.g. a plan error). */ cell(tool: AgentToolSpec, args: Record<string, unknown>): AgentToolCallCell | null { const kept = stored.get(keyOf(tool, args)); return kept && 'cell' in kept ? kept.cell : null; },
    /** The loop's prepare: the plan's error, or the kept decision (a call without a kept decision asks). */
    prepare(tool: AgentToolSpec, args: Record<string, unknown>): { readonly ok: true; readonly requireApproval: boolean } | { readonly ok: false; readonly text: string } {
      const kept = stored.get(keyOf(tool, args));
      if (kept && 'planError' in kept) return { ok: false, text: kept.planError };
      return { ok: true, requireApproval: kept?.decision.decision !== 'allow' };
    },
    async sessionOffer(tool: AgentToolSpec, args: Record<string, unknown>) {
      const kept = stored.get(keyOf(tool, args));
      if (!input.standing || !kept || !('cell' in kept) || kept.cell !== 'edit-self-source' || kept.decision.decision !== 'require-approval') return null;
      const probe = await decide(tool, kept.cell, undefined, args, kept.shell, operationOf(tool), true);
      return probe?.decision === 'allow' && probe.standing ? standingOf(tool, kept.cell, args) : null;
    },
    /** Producer-only answer port: guard holds the active card's validity, signal and wall/monotonic deadline. No record, no memory. */
    async remember(tool: AgentToolSpec, args: Record<string, unknown>, execution: Execution, callId: string, approvalId: string, guard: { readonly valid: () => boolean; readonly refused?: (reason: 'audit-unavailable' | 'policy-changed' | 'evicted') => void }): Promise<boolean> {
      const kept = stored.get(keyOf(tool, args)), memory = input.standing, found = kept && 'cell' in kept ? standingOf(tool, kept.cell, args) : null;
      if (!memory || !kept || !('cell' in kept) || !found) return false;
      return rememberSessionStanding({ memory: memory.memory, session: memory.session, key: found.key, cell: found.cell, decision: kept.decision, valid: guard.valid, ...(guard.refused ? { refused: guard.refused } : {}),
        revalidate: async () => {
          const snapshot = await load(), probe = await decide(tool, kept.cell, snapshot, args, kept.shell, operationOf(tool), true);
          return { decision: probe?.decision === 'allow' && probe.standing ? await decide(tool, kept.cell, snapshot, args, kept.shell) : null, cell: cellOf(tool, args), key: standingOf(tool, kept.cell, args)?.key ?? null };
        },
        audit: () => withAudit(audit => audit.record(standingEvent('remembered', tool, args, execution, callId, found.cell, kept.decision.revision,
          { source: 'session', key: found.key, grantId: null }, approvalId))) });
    },
    /**
     * Runs one edit or shell call at its effect with the right gate. `run` performs the C11 effect with the gate it is given.
     * Owner-approved calls use the C12 gate unchanged; every other call is decided again now (deny → nothing runs; still asking →
     * nothing runs), a mode relaxation is audited first, and a silent decision is counted.
     */
    async execute(tool: AgentToolSpec, args: Record<string, unknown>, execution: Execution, callId: string,
      run: (gate: EffectApprovalGate, authority: ShellCallAuthority, writes?: SandboxWriteDecider,
        track?: (change: { readonly deleted: TrackedFilesAuditList; readonly overwritten: TrackedFilesAuditList }) => Promise<boolean>) => Promise<AgentToolOutcome>): Promise<AgentToolOutcome> {
      const key = keyOf(tool, args), kept = stored.get(key);
      const { gate: inner, close, approvalId } = approvals.gate(tool, args, execution);
      try {
        if (!kept || 'planError' in kept || kept.decision.decision !== 'allow') {
          // SBX-05 x company policy (lead 2026-10-09): the card lifts only the destructive-risk gate; outside full access the call's writes are kept
          // aside and decided (`approvedWriteSet`) wherever the realm can keep them aside.
          const approved = approvalId !== null && input.fullAccess !== true && kept !== undefined && 'cell' in kept && kept.cell === 'shell-destructive';
          return await run(inner, 'owner-approved', approved ? approvedWriteSet(tool, args, execution, callId, approvalId) : undefined);
        }
        const fresh = await decide(tool, kept.cell, undefined, args, kept.shell);
        if (!fresh || fresh.decision === 'deny') return { status: 'error', text: `[deckent] ${tool.name}: error=denied-by-policy (the policy changed; nothing ran)` };
        if (fresh.decision !== 'allow') return { status: 'error', text: `[deckent] ${tool.name}: error=approval-required (the policy changed; nothing ran)` };
        const { relaxation, standing, fullAccess } = fresh;
        if (!relaxation && !standing && !fullAccess) {
          // A summary, not evidence: a counter that cannot be written does not stop a decision that needed no mode. A fetch is not counted
          // (no counter name of its own; each fetch is already its C11 record).
          if (!fetches(tool) && !mcps(tool)) await withAudit(audit => audit.count(scopeId, SILENT_DECISION_COUNTERS[tool.toolClass === 'edit' ? 'edit' : 'shell'], 1, clock.sample().wallMs)).catch(() => undefined);
          return await run(inner, 'unattended');
        }
        // A mode relaxation or a full-access call (MODES-3: every effect call of a full-access turn, lowered or not) is its own event.
        const event: AuditEvent = relaxation || fullAccess ? agentCallAuditEvent({ scopeId, principal: context.principal, atMs: clock.sample().wallMs, tool, summary: callSummary(tool, args),
          eventId: permissionModeEventId(scopeId, turnId, execution, agentToolArgumentsDigest(tool.name, args), fullAccess ? 'full-access-call' : undefined),
          call: { turnId, round: execution.round, index: execution.index, callId } }, fresh)
          : standingEvent('used', tool, args, execution, callId, standingOf(tool, kept.cell, args)!.cell, fresh.revision, standing!, null);
        // No audit, no relaxation: the event is durable before anything is written or spawned.
        try { await withAudit(audit => audit.record(event)); }
        catch { return { status: 'error', text: `[deckent] ${tool.name}: error=audit-unavailable (the permission mode's decision could not be recorded; nothing ran)` }; }
        return await run({
          async admit(descriptor, decision, command, principal, context) {
            const terminal = context.record && (context.record.state === 'settled' || context.record.state === 'refused');
            if (!terminal) {
              if (descriptor.approval === 'required') throw new EffectError('EFFECT_APPROVAL_REQUIRED');
              // The same decision again on the policy as it is now: a deny since wins; anything but the audited relaxation (a lost one,
              // another mode or revision, a plain allow) asks, and nothing runs here.
              const again = await decide(tool, kept.cell, undefined, args, kept.shell);
              if (!again || again.decision === 'deny') throw new PolicyAuthorizationError('POLICY_DENIED');
              if (!(relaxation || fullAccess ? isAuditedDecision(fresh, again) : isAuditedStanding(standing!, fresh.revision, again))) throw new EffectError('EFFECT_APPROVAL_REQUIRED');
              return inner.admit(descriptor, 'allow', command, principal, context);
            }
            return inner.admit(descriptor, decision, command, principal, context);
          },
        // MODES-3 x Astra 2170 (owner 2026-09-29): a full-access call is owner-authorized by the launched mode (its own write posture).
        // SHELL-OVERLAY: a shell call a full-auto relaxation let run may keep its writes aside; each is then decided like an edit (`writeSet`).
        }, fullAccess ? 'full-access' : relaxation?.mode === 'full-auto' && tool.toolClass === 'shell' ? 'full-auto' : 'unattended',
        relaxation?.mode === 'full-auto' && tool.toolClass === 'shell' ? writeSet(tool, args, execution, callId) : undefined,
        // FA-TRACKED-WARN: what a full-access shell call did to tracked files is sealed after its effect (false: not recorded; the call's line says so).
        fullAccess && tool.toolClass === 'shell' ? change => withAudit(audit => audit.record(trackedFilesAuditEvent({ scopeId, principal: context.principal, atMs: clock.sample().wallMs, tool,
          summary: callSummary(tool, args), eventId: permissionModeEventId(scopeId, turnId, execution, agentToolArgumentsDigest(tool.name, args), 'tracked-files-changed'),
          call: { turnId, round: execution.round, index: execution.index, callId } }, fresh.revision, { deleted: { ...change.deleted, paths: change.deleted.paths.map(path => redactForRecord(path, knownSecrets).slice(0, 4096)) },
            overwritten: { ...change.overwritten, paths: change.overwritten.paths.map(path => redactForRecord(path, knownSecrets).slice(0, 4096)) } }))).then(() => true, () => false) : undefined);
      } finally { await close(); }
    },
  };
}
