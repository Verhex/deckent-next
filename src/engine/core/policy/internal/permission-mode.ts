import { evaluatePolicy, identitySchema, isStandingGrantId, modeEligibleApproval, policyResources, policySchema, principalPermissionMode, standingCell, STANDING_GRANT_ACTION, STANDING_GRANT_KIND,
  type PermissionMode, type VerifiedPrincipal } from '#domain/index.js';

/**
 * What an agent tool call is, as far as permission is concerned (T-L4 slice 4a). Classification is the caller's (the plan of the
 * call); this module only decides. `edit`: a write outside the write floor; `edit-floor`: a write the floor always asks for;
 * shell cells come from the classifier's tiers (`shell-read-none` runs silently under allow; `shell-narrow-mutating` is the
 * owner's q1 set). `read` is a read tool. A fetch (FETCH S7) is `fetch-listed` (an allowlisted host: the policy decision stands) or
 * `fetch-unlisted` (any other host: allow asks); neither is ever relaxable, so no permission mode lowers a fetch (owner 2026-09-28). An MCP
 * tool call (MCP-CLIENT, owner 2026-09-28 S6 a) asks by default even under allow: `mcp-call` may be lowered in full-auto only ("full access
 * does not ask again"), `mcp-floor` (the owner's `alwaysAsk` pin or a pinned `destructiveHint`) never.
 */
export type AgentToolCallCell = 'read' | 'edit' | 'edit-floor' | 'shell-read-none' | 'shell-read-low' | 'shell-narrow-mutating' | 'shell-destructive'
  | 'shell-always-ask' | 'shell-other-modify' | 'fetch-listed' | 'fetch-unlisted' | 'mcp-call' | 'mcp-floor';
/** Cells that ask even when every policy says allow (the floor raise). A mode never removes this raise by itself. */
const RAISING: ReadonlySet<AgentToolCallCell> = new Set(['edit-floor', 'shell-read-low', 'shell-narrow-mutating', 'shell-destructive', 'shell-always-ask', 'shell-other-modify',
  'fetch-unlisted', 'mcp-call', 'mcp-floor']);
/**
 * The only cells a mode may lower, and in which modes (owner 2026-09-27): an ordinary edit in auto-edit and full-auto; the narrow
 * mutating shell set in full-auto only. Everything else — read tools, the write floor, `low`, destructive, always-ask, other
 * `modify`, and (conservatively) a read-only shell command under require-approval — asks in every mode.
 */
const RELAXABLE: Readonly<Partial<Record<AgentToolCallCell, { readonly modes: readonly PermissionMode[]; readonly audit: PermissionModeRelaxation['cell'] }>>> = {
  edit: { modes: ['auto-edit', 'full-auto'], audit: 'edit-non-floor' },
  'shell-narrow-mutating': { modes: ['full-auto'], audit: 'shell-modify' },
  'mcp-call': { modes: ['full-auto'], audit: 'mcp-call' },
};

export interface AgentToolCallRequest {
  readonly principal: VerifiedPrincipal;
  readonly scopeId: string;
  readonly tool: { readonly name: string };
  /** The Core operation the call's effect is (`workspace.file.write`, `host.shell.run`, `network.fetch`, `mcp.tool.call`), or null for a read tool. */
  readonly operation: { readonly id: string } | null;
  readonly cell: AgentToolCallCell;
  /** The call's standing-approval key (`standingPattern`) and whether this session already stands for it; absent = nothing can stand. */
  readonly standing?: { readonly key: string; readonly session: boolean } | null;
}
/** A person's standing approval that lowered a call (PERSISTENT-APPROVALS G6): this session's memory, or their own persisted grant. */
export interface StandingApproval { readonly source: 'session' | 'grant'; readonly key: string; readonly grantId: string | null }
export interface PermissionModeRelaxation {
  readonly mode: Exclude<PermissionMode, 'ask'>;
  readonly cell: 'edit-non-floor' | 'shell-modify' | 'mcp-call';
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
  /** Present only when a standing approval turned `require-approval` into `allow` (never together with a relaxation). */
  readonly standing?: StandingApproval;
}

/**
 * The one permission decision of an agent tool call (T-L4 slice 4a), pure over a trusted policy snapshot (policy + bindings):
 * 1. the stricter of the `agent-tool`/`invoke` and the operation/`execute` decisions (`deny` ends here);
 * 2. the floor raise: a raising cell turns `allow` into `require-approval`;
 * 3. the mode lowering, only when the policy decision itself is `require-approval`, every matching `require-approval` rule on each
 *    side that asks is company-marked `modeEligible`, the cell is relaxable in the person's mode, and the person has exactly one
 *    mode entry for the scope. Allow rules never lower anything; a raised `allow` is never lowered by a mode (no eligible rule produced it).
 * 4. a standing approval (owner 2026-09-28: this session's memory or the person's own persisted grant, only on a `standingCell`) lowers
 *    the floor raise of such a cell, or an eligible require-approval that no mode lowered. A deny is never lowered; the write floor,
 *    destructive shell, always-ask, other-modify and fetch cells are not standing cells.
 * The turn's authorization and the effect gate call this same function; it throws on an invalid snapshot (callers fail closed).
 */
export function decideAgentToolCall(policy: unknown, request: AgentToolCallRequest): AgentToolCallDecision {
  const ask = (kind: string, id: string, action: string) => ({ principal: request.principal, scopeId: request.scopeId, action, resource: { kind, id } });
  const sides = [ask(policyResources.agentTool.kind, request.tool.name, 'invoke'),
    ...(request.operation ? [ask(policyResources.operation.kind, request.operation.id, 'execute')] : [])];
  const decided = sides.map(side => ({ side, decision: evaluatePolicy(policy, side) }));
  const revision = decided[0]!.decision.revision;
  const done = (decision: AgentToolCallDecision['decision'], relaxation: PermissionModeRelaxation | null = null, standing?: StandingApproval) =>
    Object.freeze({ decision, revision, relaxation, ...(standing ? { standing } : {}) });
  if (decided.some(entry => entry.decision.decision === 'deny')) return done('deny');
  const strict = decided.every(entry => entry.decision.decision === 'allow') ? 'allow' : 'require-approval';
  // A standing approval names a persistable cell's pattern. It is asked like any other rule (a company deny or require-approval on the
  // same key beats it), but only the person's EXPLICIT standing grant stands: a role's all-ids authority over the kind (the owner root)
  // is authority to delegate, never an approval. Without any rule on the key, this session's memory may stand.
  const standing = ((): StandingApproval | null => {
    const key = request.standing?.key;
    if (key === undefined || !standingCell(request.cell)) return null;
    const grant = evaluatePolicy(policy, ask(STANDING_GRANT_KIND, key, STANDING_GRANT_ACTION));
    const { principal, scopeId } = request;
    const explicit = grant.decision === 'allow' ? policySchema.parse(policy).grants.find(rule => rule.effect === 'allow' && isStandingGrantId(rule.id)
      && rule.resource.kind === STANDING_GRANT_KIND && rule.resource.ids !== 'all' && rule.resource.ids.includes(key) && (rule.actions === 'all' || rule.actions.includes(STANDING_GRANT_ACTION))
      && (rule.scopes === 'all' || rule.scopes.includes(scopeId)) && rule.principals !== 'all' && rule.principals.some(item => item.issuer === principal.issuer && item.subject === principal.subject)) : undefined;
    if (explicit) return Object.freeze({ source: 'grant' as const, key, grantId: explicit.id });
    return (grant.decision === 'allow' || grant.reason === 'NO_GRANT') && request.standing?.session ? Object.freeze({ source: 'session' as const, key, grantId: null }) : null;
  })();
  if (strict === 'allow') return RAISING.has(request.cell) ? (standing ? done('allow', null, standing) : done('require-approval')) : done('allow');
  // Every matching require-approval rule on each side that asks must be company-marked `modeEligible` (a mode or a standing approval
  // lowers exactly such a rule; a company rule that is not marked is never lowered by a person).
  const eligible: string[] = [];
  let lowerable = true;
  for (const entry of decided) {
    if (entry.decision.decision !== 'require-approval') continue;
    const ids = modeEligibleApproval(policy, entry.side);
    if (!ids) { lowerable = false; break; }
    eligible.push(...ids);
  }
  if (!lowerable) return done('require-approval');
  const relaxable = RELAXABLE[request.cell];
  const person = relaxable ? principalPermissionMode(policy, request.principal, request.scopeId) : null;
  const company = [...new Set(eligible)].sort().join('+');
  // The audit record names the lowered rules in one identity; an unrecordable name is not lowered (no audit, no relaxation).
  if (relaxable && person && person.mode !== 'ask' && relaxable.modes.includes(person.mode) && identitySchema.safeParse(company).success) {
    return done('allow', Object.freeze({ mode: person.mode, cell: relaxable.audit, company, person: person.id }));
  }
  return standing ? done('allow', null, standing) : done('require-approval');
}

/**
 * Whether a standing answer to this call's card would actually lower it: the same decision with a hypothetical session memory (a persisted
 * grant lowers exactly where a session memory does). The card offers a scope only when this holds — a company `require-approval` that is not
 * `modeEligible` would otherwise "save" an answer that never lowers anything.
 */
export function standingWouldLower(policy: unknown, request: AgentToolCallRequest): boolean {
  const key = request.standing?.key;
  if (key === undefined) return false;
  const decision = decideAgentToolCall(policy, { ...request, standing: { key, session: true } });
  return decision.decision === 'allow' && decision.standing !== undefined;
}
