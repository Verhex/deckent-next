import { t, type Locale } from '#platform/index.js';
import type { AgentContent, AgentDefinition, AgentStanding, ReadableSkillDefinition } from '#domain/index.js';
import { cliTableStyle, formatAgo, renderCliTable, safeCell } from '#surfaces/core/cli-human/index.js';
import type { AgentsCommandContext } from './context.js';

const who = (author: { issuer: string; subject: string; ai: boolean }, locale: Locale) =>
  `${safeCell(`${author.issuer}:${author.subject}`)} (${author.ai ? t('agents.view.author.ai', {}, locale) : t('agents.view.author.person', {}, locale)})`;
export const skillRefs = (content: AgentContent) => content.skills.map(ref => safeCell(`${ref.skillId}@${ref.revision} ${ref.digest.slice(0, 12)}`)).join(', ');
const source = (skill: ReadableSkillDefinition, locale: Locale) => skill.source.kind === 'local' ? t('agents.skill.source.local', {}, locale)
  : t('agents.skill.source.import', { ref: safeCell(skill.source.ref), key: safeCell(skill.signature.status === 'verified' ? skill.signature.keyId : '-') }, locale);
/** The requirement lines of one agent definition, shared by the card and the inspect view. */
export function agentLines(agentId: string, content: AgentContent, locale: Locale): string[] {
  return [`${safeCell(agentId)} · ${safeCell(content.name)}`, safeCell(content.persona),
    t('agents.view.workClasses', { classes: content.workClasses.map(id => safeCell(id)).join(', ') }, locale),
    content.skills.length ? t('agents.view.skills', { skills: skillRefs(content) }, locale) : t('agents.view.skills.none', {}, locale),
    content.parentAgentId ? t('agents.view.parent', { id: safeCell(content.parentAgentId) }, locale) : t('agents.view.parent.none', {}, locale)];
}
/** BeUser E-09: the org tree as `ps --forest` shows processes — each agent under its manager, siblings in the listed order (newest change first);
 * an agent whose manager is not listed starts its own tree. Cycle-safe: an agent is shown once. */
function forest(items: readonly AgentDefinition[]): readonly (readonly [AgentDefinition, number])[] {
  const ids = new Set(items.map(item => item.agentId)), shown = new Set<string>(), out: [AgentDefinition, number][] = [];
  const visit = (item: AgentDefinition, depth: number) => {
    if (shown.has(item.agentId)) return; shown.add(item.agentId); out.push([item, depth]);
    for (const child of items) if (child.content.parentAgentId === item.agentId) visit(child, depth + 1);
  };
  for (const item of items) if (!item.content.parentAgentId || !ids.has(item.content.parentAgentId)) visit(item, 0);
  for (const item of items) visit(item, 0);
  return out;
}
export function agentTable(items: readonly AgentDefinition[], locale: Locale, context: AgentsCommandContext): string {
  const now = Date.now();
  return renderCliTable([{ header: t('agents.column.id', {}, locale) }, { header: t('agents.column.name', {}, locale), shrink: true }, { header: t('agents.column.revision', {}, locale) },
    { header: t('agents.column.parent', {}, locale) }, { header: t('agents.column.workClasses', {}, locale) }, { header: t('agents.column.skills', {}, locale) },
    { header: t('agents.column.changed', {}, locale) }],
  forest(items).map(([item, depth]) => [`${'  '.repeat(Math.max(0, depth - 1))}${depth ? '└ ' : ''}${item.agentId}`, item.content.name, item.revision, item.content.parentAgentId ?? '-',
    item.content.workClasses.join(', '), item.content.skills.length, formatAgo(item.provenance.definedAtMs, now, locale)]), cliTableStyle(context));
}
export function skillTable(items: readonly ReadableSkillDefinition[], locale: Locale, context: AgentsCommandContext): string {
  const now = Date.now();
  return renderCliTable([{ header: t('agents.column.id', {}, locale) }, { header: t('agents.column.name', {}, locale), shrink: true }, { header: t('agents.column.revision', {}, locale) },
    { header: t('agents.column.source', {}, locale) }, { header: t('agents.column.digest', {}, locale) }, { header: t('agents.column.changed', {}, locale) }],
  items.map(item => [item.skillId, item.content.name, item.revision, source(item, locale), item.contentDigest.slice(0, 12), formatAgo(item.provenance.definedAtMs, now, locale)]), cliTableStyle(context));
}
/** S8-5 (owner Q-S13): an AI/system revision names its signing key; one signed by a key revoked since then is marked "signer revoked". */
type Signers = Readonly<Record<string, 'active' | 'revoked'>>;
const signedMark = (row: AgentDefinition | ReadableSkillDefinition, signers: Signers, locale: Locale) => !row.provenance.signed ? '' : ` · ${t('agentsign.view.signed', { keyId: row.provenance.signed.keyId.slice(0, 12) }, locale)}${
  signers[row.provenance.signed.keyId] === 'active' ? '' : ` · ${t('agentsign.view.signerRevoked', {}, locale)}`}`;
const revisions = (history: readonly (AgentDefinition | ReadableSkillDefinition)[], locale: Locale, signers: Signers) => [t('agents.view.history', {}, locale),
  ...history.map(row => t('agents.view.revision', { revision: row.revision, by: who(row.provenance.author, locale), at: formatAgo(row.provenance.definedAtMs, Date.now(), locale) }, locale)
    + signedMark(row, signers, locale))];
/** S8-1a: what the system may select the agent for — its standing per bound WorkClass (one fixed label per standing, EN/TR). */
const standingLabel = (standing: AgentStanding['standing'], locale: Locale) => standing === 'active' ? t('agent.standing.active', {}, locale)
  : standing === 'candidate' ? t('agent.standing.candidate', {}, locale) : standing === 'retired' ? t('agent.standing.retired', {}, locale) : t('agent.standing.redesign-required', {}, locale);
/** S8-4: why a standing holds — carried from the previous revision, set by a signed AI ("yazan AI: X, terfi eden AI: Y"), or narrowed by a rule. */
const basisNote = (row: AgentStanding, author: AgentDefinition['provenance']['author'], locale: Locale) => row.basis.kind === 'inherited'
  ? ` (${t('agentsevo.view.inherited', { from: row.basis.fromRevision ?? '-' }, locale)})`
  : row.basis.kind === 'signed' ? ` (${t('agentsevo.view.signedBy', { by: safeCell(`${row.basis.decidedBy.issuer}:${row.basis.decidedBy.subject}`), author: who(author, locale) }, locale)})`
    : row.basis.kind === 'rule' ? ` (${t('agentsevo.view.narrowed', { id: (row.basis.suggestionId ?? '').slice(0, 12) }, locale)})` : '';
const standingLine = (standings: readonly AgentStanding[], author: AgentDefinition['provenance']['author'], locale: Locale) => standings.length ? t('agents.inspect.standings', { standings: standings
  .map(row => `${safeCell(row.workClass)} ${standingLabel(row.standing, locale)}${basisNote(row, author, locale)}`).join(', ') }, locale) : t('agents.inspect.standingNone', {}, locale);
export function agentView(item: AgentDefinition, history: readonly AgentDefinition[], locale: Locale, standings: readonly AgentStanding[] = [], signers: Signers = {}): string {
  // Q-S6 guard: an AI-authored revision never carries a promotion over; say so where it could have.
  const noCarry = item.provenance.author.ai && item.revision > 1 && standings.some(row => row.basis.kind === 'definition') ? [t('agentsevo.view.aiNoCarry', {}, locale)] : [];
  return [...agentLines(item.agentId, item.content, locale), t('agents.view.identity', { revision: item.revision, skillSet: item.skillSetDigest.slice(0, 12) }, locale),
    t('agents.view.tier', {}, locale), standingLine(standings, item.provenance.author, locale), ...noCarry, ...revisions(history, locale, signers)].join('\n');
}
export function skillView(item: ReadableSkillDefinition, history: readonly ReadableSkillDefinition[], locale: Locale, signers: Signers = {}): string {
  return [`${safeCell(item.skillId)} · ${safeCell(item.content.name)}`, safeCell(item.content.text), t('agents.skill.view.pin', { revision: item.revision, digest: item.contentDigest }, locale),
    source(item, locale), ...revisions(history, locale, signers)].join('\n');
}
