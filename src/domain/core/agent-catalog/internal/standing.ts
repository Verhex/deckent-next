import { z } from 'zod';
import { counterSchema, identitySchema } from '#domain/core/primitives/index.js';
import { AgentCatalogError, catalogIdSchema, skillRefSchema, type AgentDefinition } from './contract.js';
import limits from './limits.json' with { type: 'json' };

/**
 * S8-1a (S8-DESIGN §7; owner Q-S2/Q-S3/Q-S6): one agent revision's standing for one WorkClass. Only the system's agent selection and the
 * standing-admission gate read it: `active` may run card-less on low-risk work, `candidate` only on a Run card, `redesign-required` and `retired`
 * never. It grants no authority, names no model and writes no tier (A4). Rows are kept; a change is a new `standingRevision` (compare-and-set).
 */
export const AGENT_STANDINGS = ['candidate', 'active', 'redesign-required', 'retired'] as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actorSchema = z.object({ issuer: identitySchema, subject: identitySchema, ai: z.boolean() }).strict().readonly();
export const agentStandingSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, agentId: catalogIdSchema, revision: counterSchema.positive(),
  workClass: identitySchema, standing: z.enum(AGENT_STANDINGS), standingRevision: counterSchema.positive(),
  /** Why the row holds its value: the definition (or the previous revision's promotion it inherited), a person's card, a signed AI/system command or a
   * sealed rule suggestion (S8-4: the last two carry the action key and signature digest verified at commit). */
  basis: z.object({ kind: z.enum(['definition', 'inherited', 'person-card', 'signed', 'rule']), decidedBy: actorSchema, atMs: counterSchema, commandId: identitySchema.nullable(),
    suggestionId: digest.nullable(), reasonCode: identitySchema.nullable(), fromRevision: counterSchema.positive().optional(), signed: z.object({ keyId: digest, signatureDigest: digest }).strict().optional() }).strict()
    .refine(basis => (basis.kind === 'inherited') === (basis.fromRevision !== undefined) && (basis.kind !== 'rule' || basis.suggestionId !== null)
      && (basis.signed !== undefined) === (basis.kind === 'signed' || basis.kind === 'rule')).readonly(),
}).strict().readonly();
export type AgentStanding = z.infer<typeof agentStandingSchema>;
/** The agent a Run task was admitted with (frozen task field `agent`, v1): exact revision, digests and pins, the standing it was chosen under and why. */
export const taskAgentSealSchema = z.object({ schemaVersion: z.literal(1), agentId: catalogIdSchema, revision: counterSchema.positive(), workClass: identitySchema,
  personaDigest: digest, skillSetDigest: digest, skills: z.array(skillRefSchema).max(limits.skillsPerAgentMax).readonly(),
  standing: z.enum(['active', 'candidate']), standingRevision: counterSchema.positive(),
  selection: z.object({ eligible: counterSchema.positive(), position: counterSchema, reason: z.enum(['active-agent', 'first-candidate']) }).strict().readonly() }).strict().readonly();
export type TaskAgentSeal = z.infer<typeof taskAgentSealSchema>;
export type AgentPromptPart = Readonly<{ id: string; version: number; text: string }>;
/** The prompt parts an agent revision contributes: its persona (part id = agent id, version = revision) and each pinned skill (skill id @ revision). */
export type AgentPromptParts = Readonly<{ persona: AgentPromptPart; skills: readonly AgentPromptPart[] }>;
/** One task's system selection: the seal frozen with the Run and the parts its native prompt carries. */
export type TaskAgentSelection = Readonly<{ seal: TaskAgentSeal; parts: AgentPromptParts }>;
/** The proposal-time selection a binding records (`admission.agents`). */
export type RecordedTaskAgent = Readonly<{ taskId: string; agentId: string; revision: number; standing: 'active' | 'candidate' }>;
/** S8-1b (§5, N29): a standing-admitted Run keeps standing admission only when every task's agent re-derived at admission is the same `active`
 * revision recorded at proposal time (or no agent then and now); anything else — demoted, replaced, revised, gone or new — needs the Run card. */
export function standingAgentsChanged(recorded: readonly RecordedTaskAgent[] | undefined, tasks: readonly Readonly<{ taskId: string; agent?: TaskAgentSeal | undefined }>[]): boolean {
  const before = new Map((recorded ?? []).map(row => [row.taskId, row]));
  return [...before.keys()].some(taskId => !tasks.some(task => task.taskId === taskId)) || tasks.some(({ taskId, agent }) => {
    const was = before.get(taskId);
    return agent ? agent.standing !== 'active' || !was || was.standing !== 'active' || was.agentId !== agent.agentId || was.revision !== agent.revision : was !== undefined;
  });
}

/**
 * The standings a new agent revision opens with, one per bound WorkClass: `candidate`, except that a person-authored revision inherits `active` for
 * a WorkClass the previous revision also binds and holds `active` (owner Q-S6 alternative), and only when its skill set is unchanged or every added or
 * changed skill is the person's own local text (`importChanged` false). An AI-authored local revision starts `candidate`; a Hub client may carry a verified same-key person publisher update. Nothing is read from a
 * `redesign-required` or `retired` row; the previous revision's rows stay as they are.
 */
export function initialAgentStandings(next: AgentDefinition, previous: { readonly definition: AgentDefinition; readonly standings: readonly AgentStanding[] } | null,
  importChanged: boolean, verifiedPublisherUpdate = false): AgentStanding[] {
  const inherits = previous !== null && (!next.provenance.author.ai || verifiedPublisherUpdate) && (next.skillSetDigest === previous.definition.skillSetDigest || !importChanged);
  return next.content.workClasses.map(workClass => {
    const from = inherits && previous.definition.content.workClasses.includes(workClass) && previous.standings.some(row => row.workClass === workClass
      && row.revision === previous.definition.revision && row.standing === 'active') ? previous.definition.revision : undefined;
    return agentStandingSchema.parse({ schemaVersion: 1, scopeId: next.scopeId, agentId: next.agentId, revision: next.revision, workClass, standing: from ? 'active' : 'candidate',
      standingRevision: 1, basis: { kind: from ? 'inherited' : 'definition', decidedBy: next.provenance.author, atMs: next.provenance.definedAtMs,
        commandId: next.provenance.commandId, suggestionId: null, reasonCode: null, ...(from ? { fromRevision: from } : {}) } });
  });
}

type Action = 'promote' | 'demote' | 'restore' | 'retire' | 'narrow';
type Ref = { readonly issuer: string; readonly subject: string };
const FROM: Readonly<Record<Action, readonly AgentStanding['standing'][]>> = { promote: ['candidate', 'redesign-required'], demote: ['active'],
  restore: ['redesign-required'], retire: ['candidate', 'active', 'redesign-required'], narrow: ['active', 'candidate'] };
const TO: Readonly<Record<Action, AgentStanding['standing']>> = { promote: 'active', demote: 'candidate', restore: 'candidate', retire: 'retired', narrow: 'redesign-required' };
/**
 * The one standing transition table (versioned code). A person's card (or, S8-4, an AI/system command signed by its own active key) promotes, demotes,
 * restores or retires; only the aggregator's signed rule narrows, from a sealed suggestion. Self-approval guard (core vision, kept by owner Q-S12):
 * a suggestion's producer never decides it, and an AI never promotes or restores a revision it authored (`author`) — another signed, granted AI may.
 * `displaced`: the WorkClass's current `active` agent, which a promotion turns into `candidate` in the same change. A stale revision is a CAS conflict.
 */
export function transitionAgentStanding(current: AgentStanding, input: { readonly action: Action; readonly expectedStandingRevision: number;
  readonly actor: z.infer<typeof actorSchema>; readonly atMs: number; readonly commandId: string | null; readonly suggestionId: string | null;
  readonly reasonCode?: string; readonly displaced?: AgentStanding | null; readonly signed?: { readonly keyId: string; readonly signatureDigest: string };
  readonly author?: Ref; readonly producer?: Ref | null }): AgentStanding[] {
  if (current.standingRevision !== input.expectedStandingRevision) throw new AgentCatalogError('AGENT_STANDING_CONFLICT');
  const rule = input.action === 'narrow', same = (ref?: Ref | null) => !!ref && ref.issuer === input.actor.issuer && ref.subject === input.actor.subject;
  if (!FROM[input.action].includes(current.standing) || (rule ? input.suggestionId === null || !input.signed : input.actor.ai !== (input.signed !== undefined) || input.commandId === null)
    || (!rule && same(input.producer)) || (input.actor.ai && (input.action === 'promote' || input.action === 'restore') && same(input.author))
    || (input.displaced && (input.action !== 'promote' || input.displaced.standing !== 'active' || input.displaced.workClass !== current.workClass
      || input.displaced.scopeId !== current.scopeId || input.displaced.agentId === current.agentId))) throw new AgentCatalogError('AGENT_STANDING_REFUSED');
  const basis = { kind: rule ? 'rule' : input.signed ? 'signed' : 'person-card', decidedBy: input.actor, atMs: input.atMs, commandId: input.commandId, suggestionId: input.suggestionId,
    reasonCode: input.reasonCode ?? null, ...(input.signed ? { signed: { keyId: input.signed.keyId, signatureDigest: input.signed.signatureDigest } } : {}) };
  const move = (row: AgentStanding, standing: AgentStanding['standing']) => agentStandingSchema.parse({ ...row, standing, standingRevision: row.standingRevision + 1, basis });
  return [move(current, TO[input.action]), ...(input.displaced ? [move(input.displaced, 'candidate')] : [])];
}
