import { t, type Locale } from '#platform/index.js';
import type { AgentContent, AgentDefinition, AgentStanding, SkillDefinition } from '#domain/index.js';
import { cliTableStyle, formatAgo, renderCliTable, safeCell } from '#surfaces/core/cli-human/index.js';
import type { AgentsCommandContext } from './context.js';

const who = (author: { issuer: string; subject: string; ai: boolean }, locale: Locale) =>
  `${safeCell(`${author.issuer}:${author.subject}`)} (${author.ai ? t('agents.view.author.ai', {}, locale) : t('agents.view.author.person', {}, locale)})`;
export const skillRefs = (content: AgentContent) => content.skills.map(ref => safeCell(`${ref.skillId}@${ref.revision} ${ref.digest.slice(0, 12)}`)).join(', ');
const source = (skill: SkillDefinition, locale: Locale) => skill.source.kind === 'local' ? t('agents.skill.source.local', {}, locale)
  : t('agents.skill.source.import', { ref: safeCell(skill.source.ref), key: safeCell(skill.signature.status === 'verified' ? skill.signature.keyId : '-') }, locale);
/** The requirement lines of one agent definition, shared by the card and the inspect view. */
export function agentLines(agentId: string, content: AgentContent, locale: Locale): string[] {
  return [`${safeCell(agentId)} · ${safeCell(content.name)}`, safeCell(content.persona),
    t('agents.view.workClasses', { classes: content.workClasses.map(id => safeCell(id)).join(', ') }, locale),
    content.skills.length ? t('agents.view.skills', { skills: skillRefs(content) }, locale) : t('agents.view.skills.none', {}, locale),
    content.parentAgentId ? t('agents.view.parent', { id: safeCell(content.parentAgentId) }, locale) : t('agents.view.parent.none', {}, locale)];
}
export function agentTable(items: readonly AgentDefinition[], locale: Locale, context: AgentsCommandContext): string {
  const now = Date.now();
  return renderCliTable([{ header: t('agents.column.id', {}, locale) }, { header: t('agents.column.name', {}, locale), shrink: true }, { header: t('agents.column.revision', {}, locale) },
    { header: t('agents.column.parent', {}, locale) }, { header: t('agents.column.workClasses', {}, locale) }, { header: t('agents.column.skills', {}, locale) },
    { header: t('agents.column.changed', {}, locale) }],
  items.map(item => [item.agentId, item.content.name, item.revision, item.content.parentAgentId ?? '-', item.content.workClasses.join(', '), item.content.skills.length,
    formatAgo(item.provenance.definedAtMs, now, locale)]), cliTableStyle(context));
}
export function skillTable(items: readonly SkillDefinition[], locale: Locale, context: AgentsCommandContext): string {
  const now = Date.now();
  return renderCliTable([{ header: t('agents.column.id', {}, locale) }, { header: t('agents.column.name', {}, locale), shrink: true }, { header: t('agents.column.revision', {}, locale) },
    { header: t('agents.column.source', {}, locale) }, { header: t('agents.column.digest', {}, locale) }, { header: t('agents.column.changed', {}, locale) }],
  items.map(item => [item.skillId, item.content.name, item.revision, source(item, locale), item.contentDigest.slice(0, 12), formatAgo(item.provenance.definedAtMs, now, locale)]), cliTableStyle(context));
}
const revisions = (history: readonly (AgentDefinition | SkillDefinition)[], locale: Locale) => [t('agents.view.history', {}, locale),
  ...history.map(row => t('agents.view.revision', { revision: row.revision, by: who(row.provenance.author, locale), at: formatAgo(row.provenance.definedAtMs, Date.now(), locale) }, locale))];
/** S8-1a: what the system may select the agent for — its standing per bound WorkClass (one fixed label per standing, EN/TR). */
const standingLabel = (standing: AgentStanding['standing'], locale: Locale) => standing === 'active' ? t('agent.standing.active', {}, locale)
  : standing === 'candidate' ? t('agent.standing.candidate', {}, locale) : standing === 'retired' ? t('agent.standing.retired', {}, locale) : t('agent.standing.redesign-required', {}, locale);
const standingLine = (standings: readonly AgentStanding[], locale: Locale) => standings.length ? t('agents.inspect.standings', { standings: standings
  .map(row => `${safeCell(row.workClass)} ${standingLabel(row.standing, locale)}`).join(', ') }, locale) : t('agents.inspect.standingNone', {}, locale);
export function agentView(item: AgentDefinition, history: readonly AgentDefinition[], locale: Locale, standings: readonly AgentStanding[] = []): string {
  return [...agentLines(item.agentId, item.content, locale), t('agents.view.identity', { revision: item.revision, skillSet: item.skillSetDigest.slice(0, 12) }, locale),
    t('agents.view.tier', {}, locale), standingLine(standings, locale), ...revisions(history, locale)].join('\n');
}
export function skillView(item: SkillDefinition, history: readonly SkillDefinition[], locale: Locale): string {
  return [`${safeCell(item.skillId)} · ${safeCell(item.content.name)}`, safeCell(item.content.text), t('agents.skill.view.pin', { revision: item.revision, digest: item.contentDigest }, locale),
    source(item, locale), ...revisions(history, locale)].join('\n');
}
