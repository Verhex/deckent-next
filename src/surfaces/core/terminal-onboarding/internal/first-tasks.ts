import { ErrorRegistry } from '#platform/index.js';
import data from './first-tasks.json' with { type: 'json' };
import type { FirstTaskIntent, FolderFacts } from './contract.js';
/** A folder fact is registry data: true when a visible top-level name matches its pattern (`content`: any name at all). */
export type FolderFact = keyof typeof data.facts;
const FACTS = new Map(Object.entries(data.facts).map(([fact, pattern]) => [fact, new RegExp(pattern, 'iu')]));
export type FirstTaskSuggestion = Readonly<{ id: string; order: number; kinds: readonly FolderFacts['kind'][]; requires: readonly FolderFact[]; absent?: readonly FolderFact[];
  labelKey: string; intentKey: string; effectKey: string }>;
/** Register-before-seal, portable to Desktop. Registry entries are data, never hooks/argv/operation grants. */
export class FirstTaskRegistry {
  private entries: FirstTaskSuggestion[] = [];
  private sealed = false;
  constructor() { this.register(data.entries as FirstTaskSuggestion[]); }
  register(entries: readonly FirstTaskSuggestion[]): void {
    if (this.sealed || this.entries.length + entries.length > 256) throw ErrorRegistry.createError('SETUP_STAGE_INVALID');
    const ids = new Set(this.entries.map(row => row.id));
    for (const row of entries) {
      if (ids.has(row.id) || !/^[a-z][a-z0-9-]{0,95}$/u.test(row.id) || !Number.isSafeInteger(row.order)
        || !row.kinds.length || row.kinds.some(kind => !['coding', 'documents', 'empty', 'unknown'].includes(kind))
        || [...row.requires, ...row.absent ?? []].some(value => !FACTS.has(value))
        || [row.labelKey, row.intentKey, row.effectKey].some(key => !/^[a-z][a-zA-Z0-9_.-]{0,159}$/u.test(key))) throw ErrorRegistry.createError('SETUP_STAGE_INVALID');
      ids.add(row.id);
    }
    this.entries.push(...entries.map(row => Object.freeze({ ...row, kinds: Object.freeze([...row.kinds]), requires: Object.freeze([...row.requires]), absent: Object.freeze([...row.absent ?? []]) })));
  }
  select(facts: FolderFacts): readonly FirstTaskSuggestion[] {
    this.sealed = true;
    const has = (fact: FolderFact) => facts.entries.some(name => FACTS.get(fact)!.test(name));
    const rows = [...this.entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, 'en'))
      .filter(row => row.kinds.includes(facts.kind) && row.requires.every(has) && !(row.absent ?? []).some(has)).slice(0, data.count);
    if (rows.length !== data.count) throw ErrorRegistry.createError('SETUP_STAGE_INVALID');
    return Object.freeze(rows);
  }
}
/** A highlight produces no submission. The caller supplies one command id at explicit submit, preserved across the handoff. */
export function firstTaskIntent(input: Readonly<{ action: 'highlight' | 'later' | 'submit'; text: string; scopeId: string; folder: string; commandId: string }>): FirstTaskIntent | null {
  if (input.action !== 'submit' || !input.text.trim()) return null;
  return Object.freeze({ commandId: input.commandId, scopeId: input.scopeId, folder: input.folder, intent: input.text.trim() });
}
