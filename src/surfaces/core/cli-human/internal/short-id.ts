import { ErrorRegistry, terminalSafeText, type ConfigLoadOptions } from '#platform/index.js';
import registry from './human.json' with { type: 'json' };

/** What a typed identifier prefix matched among the known ids (git-like: an exact id always wins). */
export type IdMatch = Readonly<{ kind: 'unique'; id: string }> | Readonly<{ kind: 'ambiguous'; candidates: readonly string[] }>
  | Readonly<{ kind: 'none' }> | Readonly<{ kind: 'short'; min: number }>;

export function matchIdPrefix(prefix: string, ids: readonly string[], minPrefix: number = registry.shortId.minPrefix): IdMatch {
  const known = [...new Set(ids)];
  if (known.includes(prefix)) return { kind: 'unique', id: prefix };
  if (prefix.length < minPrefix) return { kind: 'short', min: minPrefix };
  const candidates = known.filter(id => id.startsWith(prefix)).sort();
  return candidates.length === 1 ? { kind: 'unique', id: candidates[0]! } : candidates.length === 0 ? { kind: 'none' } : { kind: 'ambiguous', candidates };
}

/**
 * The full id for a typed prefix, or a typed refusal that names the cause: too short (usage), several candidates listed (usage, bounded list
 * from the registry), none (error). Echoed text is terminal-safe; the caller's application still checks the id it receives.
 */
export function requireIdPrefix(prefix: string, ids: readonly string[]): string {
  const match = matchIdPrefix(prefix, ids), shown = terminalSafeText(prefix);
  if (match.kind === 'unique') return match.id;
  if (match.kind === 'short') throw ErrorRegistry.createError('CLI_ID_TOO_SHORT', { params: { prefix: shown, min: match.min } });
  if (match.kind === 'none') throw ErrorRegistry.createError('CLI_ID_UNKNOWN', { params: { prefix: shown } });
  const limit = registry.shortId.candidatesShown, listed = match.candidates.slice(0, limit).map(id => terminalSafeText(displayId(id, match.candidates)));
  throw ErrorRegistry.createError('CLI_ID_AMBIGUOUS', { params: { prefix: shown, count: match.candidates.length, candidates: listed.join(', '),
    more: Math.max(0, match.candidates.length - limit) } });
}

/** The id as a person sees it: the registry's display length, longer only when that is needed to tell it apart from the others. */
export function displayId(id: string, ids: readonly string[], length: number = registry.shortId.display): string {
  let size = Math.min(id.length, length);
  while (size < id.length && ids.some(other => other !== id && other.startsWith(id.slice(0, size)))) size++;
  return id.slice(0, size);
}

type RunIdSources = Readonly<{
  inspectSurfaceRunIds?: (root: string, scopeId: string, options: ConfigLoadOptions) => Promise<readonly string[]>;
  inspectInventory?: (root: string, input: { schemaVersion: 1; scopeId: string; after: string | null; limit: number }, options: ConfigLoadOptions)
    => Promise<{ readonly page: { readonly entries: readonly { readonly identity: { readonly runId: string } }[] } }>;
}>;

/**
 * The run ids the terminal's `/runs` window lists, from the same application queries in the same order (`terminal-ledger` listRunIds):
 * the authorized surface run ids, else the first inventory page. No second inventory; an absent port lists nothing.
 */
export async function listRunIds(context: RunIdSources, root: string, scopeId: string, options: ConfigLoadOptions, pageLimit = registry.shortId.inventoryPage): Promise<readonly string[]> {
  if (context.inspectSurfaceRunIds) return context.inspectSurfaceRunIds(root, scopeId, options);
  if (!context.inspectInventory) return [];
  const page = await context.inspectInventory(root, { schemaVersion: 1, scopeId, after: null, limit: pageLimit }, options);
  return Object.freeze([...new Set(page.page.entries.map(entry => entry.identity.runId))]);
}
