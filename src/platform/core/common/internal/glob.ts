/**
 * The one glob grammar of the workspace deny language (Astra 2164/2166): `*` and `?` are the only wildcards; `[`, `]`, `{`, `}` and
 * every other character are literal. The deny matcher's fast path, the sandbox anchor derivation and the product layout admission all
 * take this definition from here — a physical product path that holds a wildcard cannot be named literally in that language, so the
 * layout refuses it instead of protecting a shorter path.
 */
export const GLOB_WILDCARD = /[*?]/u;
/** The literal head of a pattern before its first wildcard (the whole pattern when it has none). */
export function globLiteralHead(pattern: string): string {
  const wildcard = pattern.search(GLOB_WILDCARD);
  return wildcard < 0 ? pattern : pattern.slice(0, wildcard);
}
/** Whether a physical path could not be named literally in the deny language (it holds a wildcard character). */
export function hasGlobWildcard(path: string): boolean { return GLOB_WILDCARD.test(path); }
