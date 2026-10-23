import { z } from 'zod';
import { AGENT_CATALOG_LIMITS, STATS_MICRO, attributableFailure, encodeCommandProjection, identitySchema, wilsonIntervalMicro, type AgentStanding, type CatalogEvolutionRegistry,
  type CatalogEvolutionRule } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { catalogSuggestionIdOf, catalogSuggestionKeyDigest, catalogSuggestionSchema, type CatalogLessonRef, type CatalogSuggestion, type CatalogSuggestionKey } from '#engine/core/agent-catalog/index.js';
import templatesSeed from '../../../../../assets/catalog-evolution/templates.json' with { type: 'json' };
import { effortRatioMicro, keyStats, windowRows, type CatalogEntries } from './aggregate.js';
import type { KeyStats, ModelFacts } from './contract.js';

/**
 * S8-3 rules promote/redesign/revise/propose-agent/propose-skill (S8-DESIGN §6 P1, D1, R1, the agent proposal, S1), pure: each reads only the registry row of its kind (every seed `provisional`) and sealed statistics, never a
 * model id or maker as a branch (models are counted as distinct exact ids, N19). A rule that fires yields one candidate; the caller seals it, signs it
 * as the aggregator and lets the catalog decide what is superseded. Windows of one (key, kind) never overlap (`after`), and after a decided, dismissed
 * or restored window the same key re-opens only with `cooldownTasks` new counted Tasks. Statistics are associations ("ilişki, nedensellik değil").
 */
const DAY_MS = 86_400_000;
export const catalogDraftTemplatesSchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, templates: z.array(z.object({ id: identitySchema, version: z.number().int().positive(),
  kind: z.enum(['propose-agent', 'propose-skill']), name: z.string().min(1), text: z.string().min(1), item: z.string().min(1).optional() }).strict()).min(1) }).strict().readonly();
/** The versioned draft templates (`agent-draft@1`, `skill-draft@1`): Core seed data, never literals; the latest version of a kind is the one used. */
export const CATALOG_DRAFT_TEMPLATES = catalogDraftTemplatesSchema.parse(templatesSeed);
export const catalogDraftTemplate = (kind: 'propose-agent' | 'propose-skill', ref?: string) => {
  const rows = CATALOG_DRAFT_TEMPLATES.templates.filter(row => row.kind === kind && (ref === undefined || `${row.id}@${row.version}` === ref));
  return rows.sort((a, b) => b.version - a.version)[0] ?? null;
};
type AgentKind = 'promote-agent' | 'redesign-agent' | 'revise-agent';
export type RuleCandidate = Omit<CatalogSuggestion, 'schemaVersion' | 'scopeId' | 'suggestionId' | 'mode' | 'keyDigest' | 'registry' | 'producer' | 'asOfMs' | 'expiresAtMs'>;
const ruleOf = <K extends CatalogEvolutionRule['kind']>(registry: CatalogEvolutionRegistry, kind: K) => registry.rules.find(row => row.kind === kind) as Extract<CatalogEvolutionRule, { kind: K }> | undefined;
const rate = (row: KeyStats) => row.n ? Math.floor((row.successes * STATS_MICRO) / row.n) : null;
const enough = (registry: CatalogEvolutionRegistry, n: number, min: number, closed: number | undefined) => n >= (closed === undefined ? min : Math.max(min, registry.suggestions.cooldownTasks));
const ruleRef = (rule: CatalogEvolutionRule) => ({ id: rule.id, version: rule.version, status: rule.status });
const windowOf = (stats: KeyStats, after: number) => ({ after, firstPosition: stats.window.firstPosition, lastPosition: stats.window.lastPosition, tasks: stats.window.tasks, n: stats.n,
  inputDigest: stats.window.inputDigest });
const json = (stats: KeyStats) => JSON.parse(JSON.stringify(stats)) as Record<string, unknown>;

export interface AgentRuleInput {
  readonly registry: CatalogEvolutionRegistry; readonly asOfMs: number; readonly facts?: ModelFacts | undefined;
  readonly key: Extract<CatalogSuggestionKey, { kind: 'agent' }>; readonly standing: AgentStanding | null;
  /** The key's own window entries, the WorkClass's (baseline: the same window without this agent's Tasks) and, when another agent is `active` there, its own. */
  readonly own: CatalogEntries; readonly workClass: CatalogEntries; readonly active: Readonly<{ agentId: string; revision: number; entries: CatalogEntries }> | null;
  /** Per kind: the last position of the previous decided, dismissed or restored window (absent: none). */
  readonly closed: Readonly<Partial<Record<AgentKind, number>>>;
}
/** P1 promote, D1 redesign (narrowing candidate) and R1 revise for one agent revision × WorkClass. */
export function agentRuleCandidates(input: AgentRuleInput): RuleCandidate[] {
  const { registry, asOfMs, key, standing, facts } = input, out: RuleCandidate[] = [], all = () => true;
  if (!standing || (standing.standing !== 'active' && standing.standing !== 'candidate')) return out;
  const baseline = keyStats(input.workClass, registry, asOfMs, row => row.agent?.agentId !== key.agentId, facts);
  const active = input.active ? keyStats(input.active.entries, registry, asOfMs, all, facts) : null;
  const statsOf = (kind: AgentKind) => keyStats(input.own, registry, asOfMs, all, facts, input.closed[kind] ?? 0);
  const push = (kind: AgentKind, rule: CatalogEvolutionRule, stats: KeyStats, proposed: RuleCandidate['proposed']) => out.push({ kind, key, rule: ruleRef(rule),
    window: windowOf(stats, input.closed[kind] ?? 0), stats: json(stats), baseline: json(baseline), active: input.active && active ? { agentId: input.active.agentId, revision: input.active.revision,
      stats: json(active) } : null, effortRatioMicro: effortRatioMicro(stats, baseline), proposed });
  const promote = ruleOf(registry, 'promote-agent'), redesign = ruleOf(registry, 'redesign-agent'), revise = ruleOf(registry, 'revise-agent');
  if (promote && standing.standing === 'candidate') {
    const s = statsOf('promote-agent'), p = promote.params, lower = s.wilson?.lowerMicro, base = rate(baseline), other = active ? rate(active) : undefined;
    // Above the WorkClass baseline and the current active agent (a comparison needs their data: none is never "above"), on ≥ minModels exact models or
    // ≥ minPeriods periods (a weak filter, labelled on the card), with non-attributable failures at most maxNonAttributableShare of the window (N33, N37).
    if (lower !== undefined && enough(registry, s.n, p.minSamples, input.closed['promote-agent']) && lower >= p.lowerBoundMicro && base !== null && lower > base
      && (other === undefined || (other !== null && lower > other)) && (s.models >= p.minModels || s.periods >= p.minPeriods)
      && s.nonAttributableShareMicro !== null && s.nonAttributableShareMicro <= p.maxNonAttributableShareMicro) push('promote-agent', promote, s, { kind: 'standing', to: 'active' });
  }
  if (redesign) {
    // D1 on the revision's own outcomes; an inherited promotion is re-checked on `inherit.recheckMinSamples` of them (Q-S6 guard).
    const s = statsOf('redesign-agent'), min = standing.basis.kind === 'inherited' ? registry.inherit.recheckMinSamples : redesign.params.minSamples;
    if (s.wilson && enough(registry, s.n, min, input.closed['redesign-agent']) && s.wilson.upperMicro < redesign.params.upperBoundMicro)
      push('redesign-agent', redesign, s, { kind: 'standing', to: 'redesign-required' });
  }
  if (revise) {
    const s = statsOf('revise-agent'), p = revise.params, ratio = effortRatioMicro(s, baseline);
    if (enough(registry, s.n, p.minSamples, input.closed['revise-agent']) && ((ratio !== null && ratio >= p.effortRatioMicro)
      || middling(input, registry, asOfMs, p.windows, p.minSamples, redesign?.params.upperBoundMicro, promote?.params.lowerBoundMicro)))
      push('revise-agent', revise, s, { kind: 'revise' });
  }
  return out;
}
/** R1's band rule: the window's counted Tasks split into `windows` consecutive, equal, non-overlapping parts of ≥ `minSamples`, every part's Wilson lower bound
 * in [D1 upper bound, P1 lower bound) — persistently between "redesign" and "promote". */
function middling(input: AgentRuleInput, registry: CatalogEvolutionRegistry, asOfMs: number, windows: number, minSamples: number, low: number | undefined, high: number | undefined) {
  if (low === undefined || high === undefined) return false;
  const counted = windowRows(input.own, registry, asOfMs, () => true, input.closed['revise-agent'] ?? 0).filter(row => row.status === 'accepted' || attributableFailure(row.cause))
    .sort((a, b) => a.position - b.position), size = Math.floor(counted.length / windows);
  if (size < minSamples) return false;
  const rows = counted.slice(counted.length - size * windows);
  return Array.from({ length: windows }, (_, index) => rows.slice(index * size, (index + 1) * size)).every(part => {
    const wilson = wilsonIntervalMicro(part.filter(row => row.status === 'accepted').length, part.length, registry.stats.zMicro);
    return wilson !== null && wilson.lowerMicro >= low && wilson.lowerMicro < high;
  });
}
/** The agent proposal: a WorkClass with enough counted Tasks in the window and no `active` or `candidate` agent (ORG: "uygun ajan yoksa oluşturma önerisi"). */
export function workClassRuleCandidates(input: { readonly registry: CatalogEvolutionRegistry; readonly asOfMs: number; readonly workClass: string; readonly entries: CatalogEntries;
  readonly eligibleAgents: number; readonly closed?: number | undefined; readonly facts?: ModelFacts | undefined }): RuleCandidate[] {
  const rule = ruleOf(input.registry, 'propose-agent'), template = catalogDraftTemplate('propose-agent');
  if (!rule || !template || input.eligibleAgents > 0) return [];
  const stats = keyStats(input.entries, input.registry, input.asOfMs, () => true, input.facts, input.closed ?? 0);
  if (!enough(input.registry, stats.n, rule.params.minTasks, input.closed)) return [];
  return [{ kind: 'propose-agent', key: { kind: 'work-class', workClass: input.workClass }, rule: ruleRef(rule), window: windowOf(stats, input.closed ?? 0), stats: json(stats), baseline: null,
    active: null, effortRatioMicro: null, proposed: { kind: 'agent-draft', template: `${template.id}@${template.version}` } }];
}
export type CatalogLessonSource = CatalogLessonRef & Readonly<{ audience: Readonly<{ workClassFamily: string; workTargetId: string | null }> | null }>;
/** The digest of a lesson set: its refs ordered by entry id (a skill defined from it carries this in `provenance.origin`). */
export const lessonSetDigest = (refs: readonly CatalogLessonRef[]) => sha256(encodeCommandProjection('catalog-lesson-set:1', [...refs]
  .sort((a, b) => a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0).map(ref => ({ entryId: ref.entryId, revision: ref.revision, contentDigest: ref.contentDigest }))));
/** S1: ≥ `minLessons` verified lessons of one audience whose set no skill was already defined from (`covered`: the lesson-set digests in skill origins). */
export function lessonRuleCandidates(input: { readonly registry: CatalogEvolutionRegistry; readonly lessons: readonly CatalogLessonSource[]; readonly covered: ReadonlySet<string> }): RuleCandidate[] {
  const rule = ruleOf(input.registry, 'propose-skill'), template = catalogDraftTemplate('propose-skill');
  if (!rule || !template) return [];
  const groups = new Map<string, CatalogLessonSource[]>();
  for (const row of input.lessons) { const id = JSON.stringify([row.audience?.workClassFamily ?? null, row.audience?.workTargetId ?? null]); groups.set(id, [...groups.get(id) ?? [], row]); }
  const out: RuleCandidate[] = [];
  for (const [id, rows] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const refs = rows.map(row => ({ entryId: row.entryId, revision: row.revision, contentDigest: row.contentDigest })).sort((a, b) => a.entryId < b.entryId ? -1 : 1).slice(0, AGENT_CATALOG_LIMITS.pageMax);
    const digest = lessonSetDigest(refs), [workClassFamily, workTargetId] = JSON.parse(id) as [string | null, string | null];
    if (refs.length < rule.params.minLessons || input.covered.has(digest)) continue;
    out.push({ kind: 'propose-skill', key: { kind: 'audience', workClassFamily, workTargetId }, rule: ruleRef(rule),
      window: { after: 0, firstPosition: null, lastPosition: null, tasks: refs.length, n: refs.length, inputDigest: digest }, stats: null, baseline: null, active: null, effortRatioMicro: null,
      proposed: { kind: 'skill-draft', template: `${template.id}@${template.version}`, lessons: refs, lessonSetDigest: digest } });
  }
  return out;
}
/** A sealed `catalog-suggestion v1` from a candidate: its id is the digest of the whole content (N10), its expiry `suggestionTtlDays` after `asOfMs`. */
export function catalogSuggestionRecord(candidate: RuleCandidate, context: { readonly scopeId: string; readonly mode: 'shadow' | 'on'; readonly producer: { readonly issuer: string; readonly subject: string };
  readonly asOfMs: number; readonly registry: CatalogEvolutionRegistry; readonly registryRef: { readonly revision: string; readonly digest: string } }): CatalogSuggestion {
  const content = { schemaVersion: 1 as const, scopeId: context.scopeId, ...candidate, mode: context.mode, keyDigest: catalogSuggestionKeyDigest(candidate.key),
    registry: { revision: context.registryRef.revision, digest: context.registryRef.digest }, producer: { issuer: context.producer.issuer, subject: context.producer.subject },
    asOfMs: context.asOfMs, expiresAtMs: context.asOfMs + context.registry.suggestions.suggestionTtlDays * DAY_MS };
  return catalogSuggestionSchema.parse({ ...content, suggestionId: catalogSuggestionIdOf(content) });
}
