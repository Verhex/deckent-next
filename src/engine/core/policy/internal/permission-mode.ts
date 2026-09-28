import { evaluatePolicy, identitySchema, modeEligibleApproval, policyResources, principalPermissionMode, type PermissionMode,
  type ShellRealmContainment, type VerifiedPrincipal } from '#domain/index.js';

/**
 * What an agent tool call is, as far as permission is concerned (T-L4 slice 4a). Classification is the caller's (the plan of the
 * call); this module only decides. `edit`: a write outside the write floor; `edit-floor`: a write the floor always asks for;
 * shell cells come from the classifier's tiers (`shell-read-none` runs silently under allow; `shell-narrow-mutating` is the
 * owner's q1 set). `read` is a read tool. A fetch (FETCH S7) is `fetch-listed` (an allowlisted host: the policy decision stands) or
 * `fetch-unlisted` (any other host: allow asks); neither is ever relaxable, so no permission mode lowers a fetch (owner 2026-09-28).
 */
export type AgentToolCallCell = 'read' | 'edit' | 'edit-floor' | 'shell-read-none' | 'shell-read-low' | 'shell-narrow-mutating' | 'shell-destructive'
  | 'shell-always-ask' | 'shell-other-modify' | 'fetch-listed' | 'fetch-unlisted';
/** Cells that ask even when every policy says allow (the floor raise). A mode never removes this raise by itself. */
const RAISING: ReadonlySet<AgentToolCallCell> = new Set(['edit-floor', 'shell-read-low', 'shell-narrow-mutating', 'shell-destructive', 'shell-always-ask', 'shell-other-modify',
  'fetch-unlisted']);
/**
 * The only cells a mode may lower, and in which modes (owner 2026-09-27): an ordinary edit in auto-edit and full-auto; the narrow
 * mutating shell set in full-auto only. Everything else — read tools, the write floor, `low`, destructive, always-ask, other
 * `modify`, and (conservatively) a read-only shell command under require-approval — asks in every mode.
 */
type Relaxable = { readonly modes: readonly PermissionMode[]; readonly audit: 'edit-non-floor' | 'shell-modify' };
const RELAXABLE: Readonly<Partial<Record<AgentToolCallCell, Relaxable>>> = {
  edit: { modes: ['auto-edit', 'full-auto'], audit: 'edit-non-floor' },
  'shell-narrow-mutating': { modes: ['full-auto'], audit: 'shell-modify' },
};
/**
 * SHELL-AUTONOMY (owner 2026-09-28): inside an enforced sandbox realm the realm is the boundary, so full-auto may also lower the shell
 * cells the classifier could not bound — read-only (any reach), other modifications and the strict scanner's refusals (compound,
 * expansion) — when the command is `contained` (no program floor, no protected name). Never the destructive table; never on the
 * host, a host fallback or a degraded sandbox. Audited under the existing `shell-modify` cell (checkpoint C2: no realm in the record).
 */
const SANDBOX_RELAXABLE: ReadonlySet<AgentToolCallCell> = new Set(['shell-read-none', 'shell-read-low', 'shell-narrow-mutating', 'shell-other-modify', 'shell-always-ask']);
const SANDBOX_RELAXATION: Relaxable = { modes: ['full-auto'], audit: 'shell-modify' };
const relaxableFor = (request: AgentToolCallRequest): Relaxable | undefined => RELAXABLE[request.cell]
  ?? (SANDBOX_RELAXABLE.has(request.cell) && request.shell?.realm === 'sandbox' && request.shell.contained ? SANDBOX_RELAXATION : undefined);

export interface AgentToolCallRequest {
  readonly principal: VerifiedPrincipal;
  readonly scopeId: string;
  readonly tool: { readonly name: string };
  /** The Core operation the call's effect is (`workspace.file.write`, `host.shell.run`, `network.fetch`), or null for a read tool. */
  readonly operation: { readonly id: string } | null;
  readonly cell: AgentToolCallCell;
  /** A shell call only: where its plan runs (the realm's containment) and whether the command is contained (`classifyShellContainment`). */
  readonly shell?: { readonly realm: ShellRealmContainment; readonly contained: boolean };
}
export interface PermissionModeRelaxation {
  readonly mode: Exclude<PermissionMode, 'ask'>;
  readonly cell: 'edit-non-floor' | 'shell-modify';
  /** The lowered company `require-approval` rule ids (sorted, `+`-joined) and the person's mode entry id. */
  readonly company: string;
  readonly person: string;
}
export interface AgentToolCallDecision {
  readonly decision: 'allow' | 'deny' | 'require-approval';
  /** Effective policy revision (`policy+bindings` for v2) the decision was made on. */
  readonly revision: string;
  /** Present only when a permission mode turned `require-approval` into `allow` for this call. */
  readonly relaxation: PermissionModeRelaxation | null;
}

/**
 * The one permission decision of an agent tool call (T-L4 slice 4a), pure over a trusted policy snapshot (policy + bindings):
 * 1. the stricter of the `agent-tool`/`invoke` and the operation/`execute` decisions (`deny` ends here);
 * 2. the floor raise: a raising cell turns `allow` into `require-approval`;
 * 3. the mode lowering, only when the policy decision itself is `require-approval`, every matching `require-approval` rule on each
 *    side that asks is company-marked `modeEligible`, the cell is relaxable in the person's mode (for the sandbox cells: in an enforced
 *    sandbox realm and contained), and the person has exactly one
 *    mode entry for the scope. Allow rules never lower anything; a raised `allow` is never lowered (no eligible rule produced it).
 * The turn's authorization and the effect gate call this same function; it throws on an invalid snapshot (callers fail closed).
 */
export function decideAgentToolCall(policy: unknown, request: AgentToolCallRequest): AgentToolCallDecision {
  const ask = (kind: string, id: string, action: string) => ({ principal: request.principal, scopeId: request.scopeId, action, resource: { kind, id } });
  const sides = [ask(policyResources.agentTool.kind, request.tool.name, 'invoke'),
    ...(request.operation ? [ask(policyResources.operation.kind, request.operation.id, 'execute')] : [])];
  const decided = sides.map(side => ({ side, decision: evaluatePolicy(policy, side) }));
  const revision = decided[0]!.decision.revision;
  const done = (decision: AgentToolCallDecision['decision'], relaxation: PermissionModeRelaxation | null = null) =>
    Object.freeze({ decision, revision, relaxation });
  if (decided.some(entry => entry.decision.decision === 'deny')) return done('deny');
  const strict = decided.every(entry => entry.decision.decision === 'allow') ? 'allow' : 'require-approval';
  if (strict === 'allow') return done(RAISING.has(request.cell) ? 'require-approval' : 'allow');
  const relaxable = relaxableFor(request);
  if (!relaxable) return done('require-approval');
  const person = principalPermissionMode(policy, request.principal, request.scopeId);
  if (!person || person.mode === 'ask' || !relaxable.modes.includes(person.mode)) return done('require-approval');
  const eligible: string[] = [];
  for (const entry of decided) {
    if (entry.decision.decision !== 'require-approval') continue;
    const ids = modeEligibleApproval(policy, entry.side);
    if (!ids) return done('require-approval');
    eligible.push(...ids);
  }
  const company = [...new Set(eligible)].sort().join('+');
  // The audit record names the lowered rules in one identity; an unrecordable name is not lowered (no audit, no relaxation).
  if (!identitySchema.safeParse(company).success) return done('require-approval');
  return done('allow', Object.freeze({ mode: person.mode, cell: relaxable.audit, company, person: person.id }));
}
