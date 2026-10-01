import { APPROVAL_ASSURANCE, HARD_FLOOR_CARD_CELLS, approvalFacts, approvalSubject, identitySchema, policySchema, type ApprovalFacts, type ApprovalRequest,
  type ApprovalSubject, type OperationDescriptor } from '#domain/index.js';
import { ApprovalAssuranceRegistry, DecisionCapabilityRing, type ApprovalAssuranceProducer } from '#engine/core/authentication/index.js';
import type { AgentToolCallCell } from '#engine/core/policy/index.js';

/**
 * B1 minimum assurance (owner 2026-10-01 `attested_assurance`). Core's own minimum: a tool-call card on a hard-floor cell — or whose risk was
 * not declared — needs `turn-bound`; every other approval (task, catalog operation including `irreversible`, ordinary tool-call cells)
 * `peer-session`, so the solo owner keeps deciding them in one step. Policy `approvalAssurance` rules are evaluated as a maximum over this
 * minimum: they can raise it, never lower it. Keys are the existing vocabularies (cell, effect class, authority surface) — no risk tier.
 */
export const HARD_FLOOR_APPROVAL_CELLS: ReadonlySet<AgentToolCallCell> = new Set<AgentToolCallCell>(HARD_FLOOR_CARD_CELLS);
const PEER = { level: APPROVAL_ASSURANCE.peerSession, rank: 0 } as const;
/** The turn-bound producer of a service: one per runtime service (its memory), minted by agent turns, read by every decision. */
export const createTurnDecisionCapabilities = () => new DecisionCapabilityRing(APPROVAL_ASSURANCE.turnBound, 1);
export type TurnDecisionCapabilities = ReturnType<typeof createTurnDecisionCapabilities>;
/** The decision path's registry: the peer-session baseline plus the given producers (Core's turn ring; Enterprise's own). */
export const approvalAssuranceRegistry = (producers: readonly ApprovalAssuranceProducer[] = []) => new ApprovalAssuranceRegistry(PEER, producers);
/** Core's levels, for ranking a minimum where no service registry is at hand (a producer filling a card's facts). */
const CORE_LEVELS = approvalAssuranceRegistry([createTurnDecisionCapabilities()]);

type Risk = ApprovalFacts['risk'];
const coreMinimum = (subject: ApprovalSubject['kind'], risk: Risk) => subject !== 'agent-tool-call' ? APPROVAL_ASSURANCE.peerSession
  : risk?.source === 'cell' && !HARD_FLOOR_APPROVAL_CELLS.has(risk.cell as AgentToolCallCell) ? APPROVAL_ASSURANCE.peerSession : APPROVAL_ASSURANCE.turnBound;
/** Unknown risk matches a rule's narrowing (fail closed): the rule then applies. */
function matches(rule: { readonly subject: string; readonly scopes: 'all' | readonly string[]; readonly cells?: readonly string[] | undefined;
  readonly effectClasses?: readonly string[] | undefined; readonly authority?: true | undefined }, scopeId: string, subject: ApprovalSubject['kind'], risk: Risk) {
  if (rule.subject !== subject || (rule.scopes !== 'all' && !rule.scopes.includes(scopeId))) return false;
  if (rule.cells && risk?.source === 'cell' && !rule.cells.includes(risk.cell)) return false;
  if (rule.effectClasses && risk?.source === 'effect-class' && !rule.effectClasses.includes(risk.effectClass)) return false;
  return !(rule.authority && risk?.source === 'effect-class' && !risk.authority);
}
/** The minimum assurance for one subject in one scope: Core's minimum raised by every matching policy rule (ranked by `registry`). */
export function minimumApprovalAssurance(policyInput: unknown, scopeId: string, subject: ApprovalSubject['kind'], risk: Risk,
  registry: ApprovalAssuranceRegistry = CORE_LEVELS): string {
  let minimum: string = coreMinimum(subject, risk);
  const parsed = policyInput === null || policyInput === undefined ? null : policySchema.safeParse(policyInput);
  const rules = parsed?.success && parsed.data.schemaVersion === 2 ? parsed.data.approvalAssurance ?? [] : [];
  for (const rule of rules) if (matches(rule, scopeId, subject, risk) && registry.rank(rule.minimum) > registry.rank(minimum)) minimum = rule.minimum;
  return minimum;
}
/** The authoritative minimum of a stored request at decision time (the request's own facts snapshot is information only). */
export const requiredApprovalAssurance = (policy: unknown, request: ApprovalRequest, registry?: ApprovalAssuranceRegistry) =>
  minimumApprovalAssurance(policy, request.scopeId, approvalSubject(request).kind, approvalFacts(request)?.risk ?? null, registry);

/** Facts of one agent tool-call card: its permission cell (null: the caller could not name it, e.g. an MCP trust card). */
export function agentToolApprovalFacts(policy: unknown, scopeId: string, cell: string | null): ApprovalFacts {
  const risk: Risk = cell === null ? null : { source: 'cell', cell };
  return Object.freeze({ risk, reversibility: null, onExpiry: 'nothing-runs' as const, requiredAssurance: minimumApprovalAssurance(policy, scopeId, 'agent-tool-call', risk) });
}
/** Facts of one catalog operation card, from its descriptor: effect class and authority surface, compensation or none/irreversible. */
export function operationApprovalFacts(policy: unknown, scopeId: string, descriptor: OperationDescriptor): ApprovalFacts {
  const risk: Risk = { source: 'effect-class', effectClass: descriptor.effectClass, authority: descriptor.surface === 'authority' };
  return Object.freeze({ risk, reversibility: descriptor.compensation ? { kind: 'compensation' as const, operation: { id: descriptor.compensation.id, version: descriptor.compensation.version } }
    : { kind: descriptor.effectClass === 'irreversible' ? 'irreversible' as const : 'none' as const }, onExpiry: 'nothing-runs' as const,
  requiredAssurance: minimumApprovalAssurance(policy, scopeId, 'operation', risk) });
}

const channels = new Set<string>();
/** The registered approval channel ids (APPROVAL-SURFACE §C): a client declares one, an unregistered declaration is refused, and none is ever
 * authority. Core registers its own surfaces; a gateway connector registers its id (`channel:<connector>`) without editing Core. */
export function registerApprovalChannel(id: string): void { channels.add(identitySchema.parse(id)); }
export const registeredApprovalChannels = (): ReadonlySet<string> => channels;
