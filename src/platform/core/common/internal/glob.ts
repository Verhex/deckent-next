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

type GlobToken = { kind: 'literal'; char: string } | { kind: 'one' } | { kind: 'star' } | { kind: 'globstar' } | { kind: 'dirs' };
/**
 * Glob matcher without backtracking (Astra 2078 R2): `**` followed by a slash is any run of whole directories, `**` anything,
 * `*` any run within a segment, `?` one non-slash character. Matching is a dynamic program over (pattern token, path position),
 * so its cost is bounded by pattern length × path length for any pattern — a hostile pattern cannot stall the service.
 * Lives here (moved unchanged from adapters/workspace-read, K6) so the engine classifies patch paths against task scope with this one grammar.
 */
export function createGlobMatcher(pattern: string): (path: string) => boolean {
  // Shapes the deny list is made of match without the dynamic program (every shell call asks thousands of paths against every pattern):
  // `**/<segment glob>` matches the path's last segment (its `**/` is any run of whole directories, so the rest is exactly the final
  // segment); a literal is an equality; a literal head with one trailing `*` (`.brain/memory.db*`) or `**` (`.git/**`) is a prefix
  // test, `*` also requiring no slash after it. Equivalence with the general matcher is the oracle test's subject.
  if (pattern.startsWith('**/') && !/[/]|\*\*/u.test(pattern.slice(3))) {
    const last = createGlobMatcher(pattern.slice(3));
    return (path: string) => last(path.slice(path.lastIndexOf('/') + 1));
  }
  if (!GLOB_WILDCARD.test(pattern)) return (path: string) => path === pattern;
  const tail = /^([^*?]*)(\*\*|\*)$/u.exec(pattern);
  if (tail) {
    const [, literal = '', kind] = tail;
    return kind === '**' ? (path: string) => path.startsWith(literal) : (path: string) => path.startsWith(literal) && !path.includes('/', literal.length);
  }
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { tokens.push({ kind: 'dirs' }); i += 2; } else { tokens.push({ kind: 'globstar' }); i += 1; }
    } else if (char === '*') tokens.push({ kind: 'star' });
    else if (char === '?') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'literal', char });
  }
  // The literal head before the first wildcard must start the path: a cheap exact test first, so a long deny list (TERM-FEEDBACK-1:
  // every product resource of the layout) costs a string compare per pattern for most paths.
  const head = globLiteralHead(pattern);
  return (path: string) => {
    if (!path.startsWith(head)) return false;
    let current = new Uint8Array(path.length + 1);
    current[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(path.length + 1);
      if (token.kind === 'literal' || token.kind === 'one') {
        for (let j = 0; j < path.length; j++) {
          if (current[j] && (token.kind === 'one' ? path[j] !== '/' : path[j] === token.char)) next[j + 1] = 1;
        }
      } else if (token.kind === 'star') {
        for (let j = 0; j <= path.length; j++) next[j] = current[j] || (j > 0 && next[j - 1] && path[j - 1] !== '/') ? 1 : 0;
      } else if (token.kind === 'globstar') {
        for (let j = 0; j <= path.length; j++) next[j] = current[j] || (j > 0 && next[j - 1]) ? 1 : 0;
      } else {
        let seen = 0;
        for (let j = 0; j <= path.length; j++) {
          next[j] = current[j] || (j > 0 && path[j - 1] === '/' && seen) ? 1 : 0;
          if (current[j]) seen = 1;
        }
      }
      current = next;
    }
    return current[path.length] === 1;
  };
}
