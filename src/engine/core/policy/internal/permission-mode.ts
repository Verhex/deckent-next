import { AUDIT_EVENT_SCHEMA_VERSION, AUDIT_TRACKED_PATHS_MAX, evaluatePolicy, fullAccessGrant, identitySchema, isStandingGrantId, modeEligibleApproval, policyResources, policySchema, principalPermissionMode,
  standingCell, STANDING_GRANT_ACTION, STANDING_GRANT_KIND, type AuditEvent, type PermissionMode, type ShellRealmContainment, type VerifiedPrincipal } from '#domain/index.js';

/**
 * What an agent tool call is, as far as permission is concerned (T-L4 slice 4a). Classification is the caller's (the plan of the
 * call); this module only decides. `edit`: a write outside the write floor; `edit-floor`: a write the floor always asks for;
 * shell cells come from the classifier's tiers (`shell-read-none` runs silently under allow; `shell-narrow-mutating` is the
 * owner's q1 set). `read` is a read tool. A fetch (FETCH S7) is `fetch-listed` (an allowlisted host: the policy decision stands) or
 * `fetch-unlisted` (any other host: allow asks); neither is ever relaxable, so no permission mode lowers a fetch (owner 2026-09-28). An MCP
 * tool call (MCP-CLIENT, owner 2026-09-28 S6 a) asks by default even under allow: `mcp-call` may be lowered in full-auto only ("full access
 * does not ask again"), `mcp-floor` (the owner's `alwaysAsk` pin or a pinned `destructiveHint`) never.
 */
export type AgentToolCallCell = 'read' | 'edit' | 'edit-floor' | 'edit-authority' | 'shell-read-none' | 'shell-read-low' | 'shell-narrow-mutating' | 'shell-destructive'
  | 'shell-always-ask' | 'shell-other-modify' | 'fetch-listed' | 'fetch-unlisted' | 'mcp-call' | 'mcp-floor';
/** Cells that ask even when every policy says allow (the floor raise). Only a launched full-access turn removes this raise (MODES-3).
 * `edit-authority` (MODES-3): a write of the installation's configuration file inside the project — it decides where policy, bindings and
 * approvals live, the shell realm and the network — asks in every mode, full access included. */
const RAISING: ReadonlySet<AgentToolCallCell> = new Set(['edit-floor', 'edit-authority', 'shell-read-low', 'shell-narrow-mutating', 'shell-destructive', 'shell-always-ask',
  'shell-other-modify', 'fetch-unlisted', 'mcp-call', 'mcp-floor']);
/** What full access never lowers: the owner's explicit ask pin on an MCP tool (Claude's "ask rule" analog) and the configuration write. */
const FULL_ACCESS_KEEPS: ReadonlySet<AgentToolCallCell> = new Set(['mcp-floor', 'edit-authority']);
/**
 * The cells standart and full-auto may lower (owner 2026-09-27, MODES-3 2026-09-29): an ordinary edit in both (unless the person's
 * `askEdits`); the narrow mutating shell set and an MCP call in full-auto only. Everything else — read tools, the write floor, `low`,
 * destructive, always-ask, other `modify`, and (conservatively) a read-only shell command under require-approval — asks in those modes.
 */
type Relaxable = { readonly modes: readonly PermissionMode[]; readonly audit: PermissionModeRelaxation['cell'] };
const RELAXABLE: Readonly<Partial<Record<AgentToolCallCell, Relaxable>>> = {
  edit: { modes: ['standart', 'full-auto'], audit: 'edit-non-floor' },
  'shell-narrow-mutating': { modes: ['full-auto'], audit: 'shell-modify' },
  'mcp-call': { modes: ['full-auto'], audit: 'mcp-call' },
};
/**
 * SHELL-AUTONOMY (owner 2026-09-28): inside an enforced sandbox realm the realm is the boundary, so full-auto may also lower the shell
 * cells the classifier could not bound — read-only (any reach), other modifications and the strict scanner's refusals (compound,
 * expansion) — when the command is `contained` (no program floor, no protected name). Never the destructive table; never on the
 * host, a host fallback or a degraded sandbox. Audited under the existing `shell-modify` cell (checkpoint C2: no realm in the record).
 */
const SANDBOX_RELAXABLE: ReadonlySet<AgentToolCallCell> = new Set(['shell-read-none', 'shell-read-low', 'shell-narrow-mutating', 'shell-other-modify', 'shell-always-ask']);
const SANDBOX_RELAXATION: Relaxable = { modes: ['full-auto'], audit: 'shell-modify' };
const relaxableFor = (request: AgentToolCallRequest, askEdits: boolean): Relaxable | undefined => request.cell === 'edit' && askEdits ? undefined : RELAXABLE[request.cell]
  ?? (SANDBOX_RELAXABLE.has(request.cell) && request.shell?.realm === 'sandbox' && request.shell.contained ? SANDBOX_RELAXATION : undefined);

export interface AgentToolCallRequest {
  readonly principal: VerifiedPrincipal;
  readonly scopeId: string;
  readonly tool: { readonly name: string };
  /** The Core operation the call's effect is (`workspace.file.write`, `host.shell.run`, `network.fetch`, `mcp.tool.call`), or null for a read tool. */
  readonly operation: { readonly id: string } | null;
  readonly cell: AgentToolCallCell;
  /** A shell call only: where its plan runs (the realm's containment) and whether the command is contained (`classifyShellContainment`). */
  readonly shell?: { readonly realm: ShellRealmContainment; readonly contained: boolean };
  /** The call's standing-approval key (`standingPattern`) and whether this session already stands for it; absent = nothing can stand. */
  readonly standing?: { readonly key: string; readonly session: boolean } | null;
  /** MODES-3: the turn was launched in full access (`chatTurn.fullAccess`). It counts only while a company grant allows full access. */
  readonly fullAccess?: boolean;
}
/** A person's standing approval that lowered a call (PERSISTENT-APPROVALS G6): this session's memory, or their own persisted grant. */
export interface StandingApproval { readonly source: 'session' | 'grant'; readonly key: string; readonly grantId: string | null }
export interface PermissionModeRelaxation {
  readonly mode: Exclude<PermissionMode, 'full-access'>;
  readonly cell: 'edit-non-floor' | 'shell-modify' | 'mcp-call';
  /** The lowered company `require-approval` rule ids (sorted, `+`-joined) and the person's mode entry id (null: the default standart). */
  readonly company: string;
  readonly person: string | null;
}
/** A call decided in a full-access turn (MODES-3): what the policy said before the floor raise, whether the floor raised it, the lowered
 * company rule ids (null: none) and the grant rule that allows full access. Every such allowed call is audited before its effect. */
export interface FullAccessDecision {
  readonly cell: Exclude<AgentToolCallCell, 'read' | 'mcp-floor' | 'edit-authority'>;
  readonly policy: 'allow' | 'require-approval';
  readonly raised: boolean;
  readonly company: string | null;
  readonly grant: string;
}
export interface AgentToolCallDecision {
  readonly decision: 'allow' | 'deny' | 'require-approval';
  /** Effective policy revision (`policy+bindings` for v2) the decision was made on. */
  readonly revision: string;
  /** Present only when a permission mode turned `require-approval` into `allow` for this call. */
  readonly relaxation: PermissionModeRelaxation | null;
  /** Present only when a standing approval turned `require-approval` into `allow` (never together with a relaxation). */
  readonly standing?: StandingApproval;
  /** Present only when a full-access turn allowed the call (never together with a relaxation or a standing approval). */
  readonly fullAccess?: FullAccessDecision;
}

/**
 * The one permission decision of an agent tool call (T-L4 slice 4a), pure over a trusted policy snapshot (policy + bindings):
 * 1. the stricter of the `agent-tool`/`invoke` and the operation/`execute` decisions (`deny` ends here);
 * 2. the floor raise: a raising cell turns `allow` into `require-approval`;
 * 3. the mode lowering, only when the policy decision itself is `require-approval`, every matching `require-approval` rule on each
 *    side that asks is company-marked `modeEligible`, the cell is relaxable in the person's mode (for the sandbox cells: in an enforced
 *    sandbox realm and contained), and the person has exactly one mode entry for the scope. Allow rules never lower anything; a raised
 *    `allow` is never lowered by a mode (no eligible rule produced it).
 * 4. a standing approval (owner 2026-09-28: this session's memory or the person's own persisted grant, only on a `standingCell`) lowers
 *    the floor raise of such a cell, or an eligible require-approval that no mode lowered — the mode first, the standing approval last
 *    (SHELL-AUTONOMY merge, lead). A deny is never lowered; the write floor, destructive shell, always-ask, other-modify and fetch cells
 *    are not standing cells.
 * The turn's authorization and the effect gate call this same function; it throws on an invalid snapshot (callers fail closed).
 */
export function decideAgentToolCall(policy: unknown, request: AgentToolCallRequest): AgentToolCallDecision {
  const ask = (kind: string, id: string, action: string) => ({ principal: request.principal, scopeId: request.scopeId, action, resource: { kind, id } });
  const sides = [ask(policyResources.agentTool.kind, request.tool.name, 'invoke'),
    ...(request.operation ? [ask(policyResources.operation.kind, request.operation.id, 'execute')] : [])];
  const decided = sides.map(side => ({ side, decision: evaluatePolicy(policy, side) }));
  const revision = decided[0]!.decision.revision;
  const done = (decision: AgentToolCallDecision['decision'], relaxation: PermissionModeRelaxation | null = null, standing?: StandingApproval, fullAccess?: FullAccessDecision) =>
    Object.freeze({ decision, revision, relaxation, ...(standing ? { standing } : {}), ...(fullAccess ? { fullAccess: Object.freeze(fullAccess) } : {}) });
  // A deny is never lowered, in any mode (full access included).
  if (decided.some(entry => entry.decision.decision === 'deny')) return done('deny');
  const strict = decided.every(entry => entry.decision.decision === 'allow') ? 'allow' : 'require-approval';
  // Full access counts only while the company grant allows it on this very snapshot: a grant revoked mid-turn reads as standart here, so
  // the effect gate's second decision no longer matches the audited one and nothing runs.
  const grant = request.fullAccess === true ? fullAccessGrant(policy, request.principal, request.scopeId) : null;
  const access = grant?.decision === 'allow' && grant.ruleId !== undefined ? grant.ruleId : null;
  const person = access ? null : principalPermissionMode(policy, request.principal, request.scopeId);
  // A stored full-access start mode without a launched turn is standart (MODES-3: an explicit parameter, never implied by bindings).
  const mode = person === null ? null : person.mode === 'full-access' ? { mode: 'standart' as const, askEdits: person.askEdits, id: person.id } : person;
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
  // Full access lowers the floor raise and an eligible require-approval on every cell but the ones it keeps; a read tool is not an effect
  // (nothing to audit per call), every other allowed call carries the decision its audit event records.
  const full = (company: string | null): AgentToolCallDecision => FULL_ACCESS_KEEPS.has(request.cell) ? done('require-approval') : request.cell === 'read' ? done('allow')
    : done('allow', null, undefined, { cell: request.cell as FullAccessDecision['cell'], policy: strict, raised: strict === 'allow' && RAISING.has(request.cell), company, grant: access! });
  if (strict === 'allow') {
    if (access && !FULL_ACCESS_KEEPS.has(request.cell)) return full(null);
    return RAISING.has(request.cell) ? (standing ? done('allow', null, standing) : done('require-approval')) : done('allow');
  }
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
  const company = [...new Set(eligible)].sort().join('+');
  // The audit record names the lowered rules in one identity; an unrecordable name is not lowered (no audit, no relaxation).
  if (!identitySchema.safeParse(company).success) return standing ? done('allow', null, standing) : done('require-approval');
  if (access) return full(company);
  const relaxable = mode ? relaxableFor(request, mode.askEdits) : undefined;
  if (relaxable && mode && mode.mode !== 'full-access' && relaxable.modes.includes(mode.mode)) {
    return done('allow', Object.freeze({ mode: mode.mode, cell: relaxable.audit, company, person: mode.id }));
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

type AuditSummary = Extract<AuditEvent['subject'], { kind: 'full-access-call' }>['summary'];
/** One call's audit identity and what it touched (the shared part of the permission-mode and full-access call events). */
export interface AgentCallAuditInput {
  readonly eventId: string; readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly atMs: number;
  readonly tool: { readonly name: string; readonly version: number };
  readonly call: { readonly turnId: string; readonly round: number; readonly index: number; readonly callId: string };
  readonly summary: AuditSummary;
}
/**
 * The sealed audit event of a call a mode or a full-access turn let run without a card, recorded before its effect (no event, nothing runs):
 * `permission-mode` for a standart/full-auto relaxation, `full-access-call` for every effect call a full-access turn allowed.
 */
export function agentCallAuditEvent(input: AgentCallAuditInput, decision: AgentToolCallDecision): AuditEvent {
  const base = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION as typeof AUDIT_EVENT_SCHEMA_VERSION, eventId: input.eventId, scopeId: input.scopeId, principal: { issuer: input.principal.issuer, subject: input.principal.subject },
    policyRevision: decision.revision, atMs: input.atMs };
  const tool = { name: input.tool.name, version: input.tool.version }, call = { ...input.call };
  if (decision.fullAccess) {
    const { cell, policy, raised, company, grant } = decision.fullAccess;
    return { ...base, subject: { kind: 'full-access-call', cell, policy, raised, company, grant, tool, call, summary: input.summary } };
  }
  const relaxation = decision.relaxation!;
  return { ...base, subject: { kind: 'permission-mode', mode: relaxation.mode, cell: relaxation.cell, tool, call, grants: { company: relaxation.company, person: relaxation.person },
    decision: { previous: 'require-approval', next: 'allow' }, summary: input.summary } };
}
/** One list of a `tracked-files-changed` event: the full count and the first project-relative paths. */
export interface TrackedFilesAuditList { readonly count: number; readonly paths: readonly string[] }
/**
 * FA-TRACKED-WARN (owner 2026-09-30): the sealed record of what a full-access shell call measurably did to git-tracked files, written after
 * its effect under the same call reference and policy revision as its `full-access-call` event. Paths beyond `AUDIT_TRACKED_PATHS_MAX` are
 * counted, not named.
 */
export function trackedFilesAuditEvent(input: AgentCallAuditInput, revision: string,
  change: { readonly deleted: TrackedFilesAuditList; readonly overwritten: TrackedFilesAuditList }): AuditEvent {
  const list = (item: TrackedFilesAuditList) => ({ count: item.count, paths: item.paths.slice(0, AUDIT_TRACKED_PATHS_MAX) });
  return { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: input.eventId, scopeId: input.scopeId, principal: { issuer: input.principal.issuer, subject: input.principal.subject },
    policyRevision: revision, atMs: input.atMs, subject: { kind: 'tracked-files-changed', tool: { name: input.tool.name, version: input.tool.version }, call: { ...input.call },
      summary: input.summary, deleted: list(change.deleted), overwritten: list(change.overwritten) } };
}
/**
 * Whether a decision taken at an effect admission is the one the audit event recorded (Astra 2133, MODES-3): allow, on the same effective
 * policy revision, by the same relaxation (mode, cell, company rules, person entry) or the same full-access decision (cell, policy, raise,
 * lowered rules, grant rule). Anything else — another mode, a revoked grant, a revision changed by any edit, a plain allow — is not what was
 * audited, so the effect is not admitted (nothing is re-audited).
 */
export function isAuditedDecision(audited: AgentToolCallDecision, again: AgentToolCallDecision): boolean {
  if (again.decision !== 'allow' || again.revision !== audited.revision) return false;
  const same = (left: object | null | undefined, right: object | null | undefined) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  return (audited.relaxation !== null || audited.fullAccess !== undefined) && same(audited.relaxation, again.relaxation) && same(audited.fullAccess, again.fullAccess);
}
/**
 * The admission of a turn launched in full access (MODES-3): the company grant's decision now, and the sealed `full-access-turn` event that
 * records it. The caller records an allowed turn before its first round (no record, no turn) and a refusal when it can.
 */
export function admitFullAccessTurn(policy: unknown, input: { readonly principal: VerifiedPrincipal; readonly scopeId: string; readonly turnId: string;
  readonly sessionId: string | null; readonly eventId: string; readonly atMs: number }): { readonly allowed: boolean; readonly event: AuditEvent } {
  const grant = fullAccessGrant(policy, input.principal, input.scopeId);
  const allowed = grant.decision === 'allow' && grant.ruleId !== undefined;
  const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: input.eventId, scopeId: input.scopeId,
    principal: { issuer: input.principal.issuer, subject: input.principal.subject }, policyRevision: grant.revision, atMs: input.atMs,
    subject: { kind: 'full-access-turn', turnId: input.turnId, sessionId: input.sessionId, decision: { effect: grant.decision, ruleId: grant.ruleId ?? null } } };
  return Object.freeze({ allowed, event });
}
