import { AGENT_CATALOG_LIMITS, encodeCommandProjection, isMemoryTombstone, type MemoryEntry } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import type { CatalogSuggestion } from '#engine/core/agent-catalog/index.js';
import { catalogDraftTemplate } from './rules.js';

const bytes = (value: string) => new TextEncoder().encode(value).length;
const fill = (text: string, values: Readonly<Record<string, string | number>>) => text.replace(/\{(\w+)\}/gu, (all, name: string) => Object.hasOwn(values, name) ? String(values[name]) : all);
const line = (value: string) => value.replace(/\s+/gu, ' ').trim();
const cap = (value: string, max: number) => { let out = value.trim(); while (bytes(out) > max) out = out.slice(0, -1).trimEnd(); return out; };
export type CatalogDraft = Readonly<{ kind: 'agent'; content: Readonly<{ name: string; persona: string; workClasses: readonly string[]; skills: readonly never[]; parentAgentId: null }> }>
  | Readonly<{ kind: 'skill'; content: Readonly<{ name: string; text: string }>; lessons: number; omitted: number }>;
/**
 * S8-4 (S8-DESIGN §6 fold A): the draft of a `propose-agent` or `propose-skill` suggestion, rendered at card time — deterministic, from the versioned
 * template the suggestion names and from exactly the lesson entries passed in (the caller passes only those the deciding person may read through the
 * §7.4 filter, at the revision and content digest the suggestion cites). Never stored on the suggestion; within the catalog bounds (lessons that do not
 * fit are counted). A skill draft is derived from worker lesson claims: AI output ("AI çıktısından türetildi", N36). Null: no draft.
 */
export function renderCatalogDraft(record: CatalogSuggestion, entries: readonly MemoryEntry[]): CatalogDraft | null {
  const p = record.proposed, key = record.key;
  if (p.kind === 'agent-draft' && key.kind === 'work-class') {
    const template = catalogDraftTemplate('propose-agent', p.template);
    return template && { kind: 'agent', content: { name: cap(fill(template.name, { workClass: key.workClass }), AGENT_CATALOG_LIMITS.nameMaxBytes),
      persona: cap(fill(template.text, { workClass: key.workClass }), AGENT_CATALOG_LIMITS.personaMaxBytes), workClasses: [key.workClass], skills: [], parentAgentId: null } };
  }
  const template = p.kind === 'skill-draft' ? catalogDraftTemplate('propose-skill', p.template) : null;
  if (p.kind !== 'skill-draft' || key.kind !== 'audience' || !template?.item) return null;
  const cited = new Map(p.lessons.map(ref => [ref.entryId, ref] as const)), items: string[] = [];
  const lessons = entries.filter(entry => cited.get(entry.entryId)?.contentDigest === entry.contentDigest && cited.get(entry.entryId)?.revision === entry.revision)
    .sort((a, b) => a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0).flatMap(entry => isMemoryTombstone(entry.content) || !entry.content.lesson ? [] : [entry.content]);
  const text = (rows: readonly string[]) => fill(template.text, { count: rows.length, lessons: rows.join('\n') }).trim();
  for (const lesson of lessons) {
    const item = fill(template.item, { title: line(lesson.title), correction: line(lesson.lesson!.correction), cause: line(lesson.lesson!.cause) });
    if (bytes(text([...items, item])) <= AGENT_CATALOG_LIMITS.skillTextMaxBytes) items.push(item);
  }
  return items.length ? { kind: 'skill', content: { name: cap(fill(template.name, { audience: key.workClassFamily ?? record.scopeId }), AGENT_CATALOG_LIMITS.nameMaxBytes), text: text(items) },
    lessons: items.length, omitted: lessons.length - items.length } : null;
}
/** The digest a draft card shows and its apply re-checks (the lessons readable or the template changed in between: a new card). */
export const catalogDraftDigest = (draft: CatalogDraft) => sha256(encodeCommandProjection('catalog-draft:1', draft));
