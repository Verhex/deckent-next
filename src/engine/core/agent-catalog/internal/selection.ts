import { AGENT_CATALOG_LIMITS, executionRegistrySchema, resolveTaskWorkClass, taskAgentSealSchema, WorkerEffortError, type AgentDefinition, type AgentPromptParts, type ReadableSkillDefinition,
  type TaskAgentSelection, type TaskGraph, type WorkClassRegistry } from '#domain/index.js';
import { AgentCatalogStoreError, type AgentCatalogStore } from './contract.js';
import { skillContentV2Digest } from '#engine/core/hub/index.js';
import { personaDigest, skillContentDigest, skillSetDigest } from './digests.js';

type SelectionStore = Pick<AgentCatalogStore, 'eligibleAgents' | 'loadSkill' | 'upstream'>;
const corrupt = () => new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');

export const agentPromptParts = (agent: AgentDefinition, skills: readonly ReadableSkillDefinition[]): AgentPromptParts => Object.freeze({
  persona: Object.freeze({ id: agent.agentId, version: agent.revision, text: agent.content.persona }),
  skills: Object.freeze(skills.map(row => Object.freeze({ id: row.skillId, version: row.revision, text: row.content.text }))) });
/** The bytes the parts add to a native prompt composition, whose bound is measured over its JSON (define-time check, S8-DESIGN §5). */
export const agentPromptBytes = (parts: AgentPromptParts) => Buffer.byteLength(JSON.stringify(parts), 'utf8');

/** The exact pinned skill revisions of an agent revision, each re-digested from its stored content, and the persona and skill-set digests
 * recomputed: any mismatch is a corrupt catalog (N17), never a Run with other text than the one pinned. */
export async function pinnedAgentSkills(store: Pick<AgentCatalogStore, 'loadSkill'>, agent: AgentDefinition): Promise<readonly ReadableSkillDefinition[]> {
  if (personaDigest(agent.content.persona) !== agent.personaDigest || skillSetDigest(agent.content.skills) !== agent.skillSetDigest) throw corrupt();
  const skills: ReadableSkillDefinition[] = [];
  for (const ref of agent.content.skills) {
    const skill = await store.loadSkill(agent.scopeId, ref.skillId, ref.revision);
    if (!skill || skill.scopeId !== agent.scopeId || skill.skillId !== ref.skillId || skill.revision !== ref.revision || skill.contentDigest !== ref.digest
      || (skill.schemaVersion === 2 ? skillContentV2Digest(skill.content) : skillContentDigest(skill.content)) !== ref.digest) throw corrupt();
    skills.push(skill);
  }
  return skills;
}

async function choose(store: SelectionStore, scopeId: string, workClass: string): Promise<TaskAgentSelection | null> {
  const rows = await store.eligibleAgents(scopeId, workClass, AGENT_CATALOG_LIMITS.agentsPerScopeMax + 1);
  if (rows.length > AGENT_CATALOG_LIMITS.agentsPerScopeMax) throw new AgentCatalogStoreError('AGENT_CATALOG_LIMIT');
  const ordered = [...rows].sort((a, b) => a.agent.agentId < b.agent.agentId ? -1 : a.agent.agentId > b.agent.agentId ? 1 : 0);
  if (new Set(ordered.map(row => row.agent.agentId)).size !== ordered.length || ordered.some(({ agent, standing }) => agent.scopeId !== scopeId || standing.scopeId !== scopeId
    || standing.agentId !== agent.agentId || standing.revision !== agent.revision || standing.workClass !== workClass || !agent.content.workClasses.includes(workClass)
    || (standing.standing !== 'active' && standing.standing !== 'candidate'))) throw corrupt();
  // At most one promoted agent per (scope, WorkClass) among current revisions: two is a corrupt catalog, never a silent choice between them.
  const allowed = [];
  for (const row of ordered) {
    const refs = [{ kind: 'agent' as const, id: row.agent.agentId, revision: row.agent.revision },
      ...row.agent.content.skills.map(ref => ({ kind: 'skill' as const, id: ref.skillId, revision: ref.revision }))];
    const upstream = await Promise.all(refs.map(ref => store.upstream?.(scopeId, ref.kind, ref.id, ref.revision) ?? 'clear'));
    if (!upstream.some(state => state === 'withdrawn' || state === 'revoked')) allowed.push(row);
  }
  const active = allowed.filter(row => row.standing.standing === 'active');
  if (active.length > 1) throw corrupt();
  const pick = active[0] ?? allowed[0];
  if (!pick) return null;
  const { agent, standing } = pick, parts = agentPromptParts(agent, await pinnedAgentSkills(store, agent));
  const seal = taskAgentSealSchema.parse({ schemaVersion: 1, agentId: agent.agentId, revision: agent.revision, workClass, personaDigest: agent.personaDigest,
    skillSetDigest: agent.skillSetDigest, skills: agent.content.skills, standing: standing.standing, standingRevision: standing.standingRevision,
    selection: { eligible: ordered.length, position: ordered.indexOf(pick), reason: active.length ? 'active-agent' : 'first-candidate' } });
  return Object.freeze({ seal, parts });
}

/**
 * S8-1b (S8-DESIGN §5; owner Q-S1): the system — never the Brain or a model — selects at most one agent per work-input task from the scope's
 * catalog: the WorkClass's single `active` agent, else its candidates by agent id; `redesign-required` and `retired` never. The persona and pinned
 * skills are read from the exact revisions and re-digested. A task without a WorkClass, or a WorkClass with no eligible agent, gets nothing and runs
 * exactly as before. Reads only (bounded by the catalog's agent bound); no model id is read or written. The same call serves proposal and admission.
 */
export async function selectTaskAgents(graph: TaskGraph, registry: WorkClassRegistry | undefined, scopeId: string, store: SelectionStore): Promise<ReadonlyMap<string, TaskAgentSelection>> {
  const selected = new Map<string, TaskAgentSelection>(), byClass = new Map<string, TaskAgentSelection | null>();
  for (const task of graph.tasks) {
    if (!task.workInput) continue; // only a native prompt carries persona and skill parts
    let workClass: string | undefined;
    // An unresolvable WorkClass is refused, typed, by the worker assignment and effort path of the same admission; selection never decides it.
    try { workClass = resolveTaskWorkClass(task.kind, task.workClass ?? task.workInput.workClass, registry).workClass?.id; } catch (error) { if (error instanceof WorkerEffortError) continue; throw error; }
    if (!workClass) continue;
    if (!byClass.has(workClass)) byClass.set(workClass, await choose(store, scopeId, workClass));
    const chosen = byClass.get(workClass);
    if (chosen) selected.set(task.id, chosen);
  }
  return selected;
}
/** The proposal-time record of a selection (binding `admission.agents`): which agent revision under which standing, per task. */
export const agentSelectionSummary = (selection: ReadonlyMap<string, TaskAgentSelection>) =>
  new Map([...selection].map(([taskId, row]) => [taskId, { agentId: row.seal.agentId, revision: row.seal.revision, standing: row.seal.standing }] as const));
/** Opens the catalog for one selection and closes it (admission/proposal composition); no opener = no catalog = no agent. */
export async function selectTaskAgentsFrom(open: (() => Promise<SelectionStore & { close(): void }>) | undefined, graph: TaskGraph, registryInput: unknown, scopeId: string) {
  if (!open || !graph.tasks.some(task => task.workInput)) return new Map<string, TaskAgentSelection>(); // no prompt to fill: the catalog is not opened
  const store = await open();
  try { return await selectTaskAgents(graph, executionRegistrySchema.parse(registryInput).workClasses, scopeId, store); } finally { store.close(); }
}
