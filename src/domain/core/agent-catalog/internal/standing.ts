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
  /** Why the row holds its value: the definition (or the previous revision's promotion it inherited), a person's card, or a sealed rule suggestion. */
  basis: z.object({ kind: z.enum(['definition', 'inherited', 'person-card', 'rule']), decidedBy: actorSchema, atMs: counterSchema, commandId: identitySchema.nullable(),
    suggestionId: digest.nullable(), reasonCode: identitySchema.nullable(), fromRevision: counterSchema.positive().optional() }).strict()
    .refine(basis => (basis.kind === 'inherited') === (basis.fromRevision !== undefined) && (basis.kind !== 'rule' || basis.suggestionId !== null)).readonly(),
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
 * changed skill is the person's own local text (`importChanged` false). An AI-authored revision always starts `candidate`. Nothing is read from a
 * `redesign-required` or `retired` row; the previous revision's rows stay as they are.
 */
export function initialAgentStandings(next: AgentDefinition, previous: { readonly definition: AgentDefinition; readonly standings: readonly AgentStanding[] } | null,
  importChanged: boolean): AgentStanding[] {
  const inherits = previous !== null && !next.provenance.author.ai && (next.skillSetDigest === previous.definition.skillSetDigest || !importChanged);
  return next.content.workClasses.map(workClass => {
    const from = inherits && previous.definition.content.workClasses.includes(workClass) && previous.standings.some(row => row.workClass === workClass
      && row.revision === previous.definition.revision && row.standing === 'active') ? previous.definition.revision : undefined;
    return agentStandingSchema.parse({ schemaVersion: 1, scopeId: next.scopeId, agentId: next.agentId, revision: next.revision, workClass, standing: from ? 'active' : 'candidate',
      standingRevision: 1, basis: { kind: from ? 'inherited' : 'definition', decidedBy: next.provenance.author, atMs: next.provenance.definedAtMs,
        commandId: next.provenance.commandId, suggestionId: null, reasonCode: null, ...(from ? { fromRevision: from } : {}) } });
  });
}

type Action = 'promote' | 'demote' | 'restore' | 'retire' | 'narrow';
const FROM: Readonly<Record<Action, readonly AgentStanding['standing'][]>> = { promote: ['candidate', 'redesign-required'], demote: ['active'],
  restore: ['redesign-required'], retire: ['candidate', 'active', 'redesign-required'], narrow: ['active', 'candidate'] };
const TO: Readonly<Record<Action, AgentStanding['standing']>> = { promote: 'active', demote: 'candidate', restore: 'candidate', retire: 'retired', narrow: 'redesign-required' };
/**
 * The one standing transition table (versioned code). A person's card promotes, demotes, restores or retires; only a sealed rule suggestion
 * narrows (the aggregator, S8-3/S8-4). Every AI principal is refused until the signed path (S8-5) exists. `displaced`: the WorkClass's current
 * `active` agent, which a promotion turns into `candidate` in the same change. A stale `expectedStandingRevision` is a compare-and-set conflict.
 */
export function transitionAgentStanding(current: AgentStanding, input: { readonly action: Action; readonly expectedStandingRevision: number;
  readonly actor: z.infer<typeof actorSchema>; readonly atMs: number; readonly commandId: string | null; readonly suggestionId: string | null;
  readonly reasonCode?: string; readonly displaced?: AgentStanding | null }): AgentStanding[] {
  if (current.standingRevision !== input.expectedStandingRevision) throw new AgentCatalogError('AGENT_STANDING_CONFLICT');
  const rule = input.action === 'narrow';
  if (!FROM[input.action].includes(current.standing) || (rule ? input.suggestionId === null : input.actor.ai || input.commandId === null)
    || (input.displaced && (input.action !== 'promote' || input.displaced.standing !== 'active' || input.displaced.workClass !== current.workClass
      || input.displaced.scopeId !== current.scopeId || input.displaced.agentId === current.agentId))) throw new AgentCatalogError('AGENT_STANDING_REFUSED');
  const basis = { kind: rule ? 'rule' : 'person-card', decidedBy: input.actor, atMs: input.atMs, commandId: input.commandId, suggestionId: input.suggestionId, reasonCode: input.reasonCode ?? null };
  const move = (row: AgentStanding, standing: AgentStanding['standing']) => agentStandingSchema.parse({ ...row, standing, standingRevision: row.standingRevision + 1, basis });
  return [move(current, TO[input.action]), ...(input.displaced ? [move(input.displaced, 'candidate')] : [])];
}
