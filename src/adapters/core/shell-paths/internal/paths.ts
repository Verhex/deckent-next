import { readdirSync } from 'node:fs';
import { posix } from 'node:path';
import type { ShellPathContext, ShellPathVerdict, ShellReasonCode, ShellWord } from '#engine/index.js';
import type { WorkspacePathError, WorkspaceScope } from '#adapters/core/workspace-read/index.js';

/** Default per-argument bound of shell glob expansion (legacy DEFAULT_MAX_GLOB_MATCHES); over it the command is not read-only. */
export const SHELL_GLOB_MAX_MATCHES = 10_000;
const GLOB_CHARS = /[*?[]/u;

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
};
const escapeRegExpChar = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/-]/gu, '\\$&');

/**
 * POSIX bracket expression at `segment[open]` → JS class source, or `null` when
 * the form is not supported EXACTLY (collating `[.x.]` / equivalence `[=x=]`),
 * which the caller classifies as GLOB_UNSUPPORTED. An unterminated `[` is a
 * literal bracket, as in sh. Returns the index just past the closing `]`.
 */
function compileBracket(segment: string, open: number): { source: string; end: number } | 'literal' | null {
  let i = open + 1;
  let negate = false;
  if (segment[i] === '!' || segment[i] === '^') { negate = true; i++; }
  let body = '';
  let first = true;
  while (i < segment.length) {
    const c = segment[i]!;
    if (c === ']' && !first) return { source: `[${negate ? '^/' : ''}${body}]`, end: i + 1 };
    first = false;
    if (c === '[' && (segment[i + 1] === '.' || segment[i + 1] === '=')) return null;
    if (c === '[' && segment[i + 1] === ':') {
      const close = segment.indexOf(':]', i + 2);
      if (close < 0) return null;
      const cls = POSIX_CLASSES[segment.slice(i + 2, close)];
      if (cls === undefined) return null;
      body += cls;
      i = close + 2;
      continue;
    }
    if (segment[i + 1] === '-' && i + 2 < segment.length && segment[i + 2] !== ']') {
      const hi = segment[i + 2]!;
      if (hi === '[') return null;
      if (c.charCodeAt(0) > hi.charCodeAt(0)) return null;
      body += `${escapeRegExpChar(c)}-${escapeRegExpChar(hi)}`;
      i += 3;
      continue;
    }
    body += escapeRegExpChar(c);
    i++;
  }
  return 'literal';
}

/** Shell-glob segment → RegExp (`*`/`?` never match a leading dot, as in sh);
 *  `null` for a bracket form that is not supported exactly (fail closed). */
function globSegmentRegExp(segment: string): RegExp | null {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const bracket = compileBracket(segment, i);
      if (bracket === null) return null;
      if (bracket === 'literal') { out += '\\['; continue; }
      out += bracket.source;
      i = bracket.end - 1;
    } else out += c.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }
  const leadingDotAllowed = segment.startsWith('.');
  return new RegExp(`^${leadingDotAllowed ? '' : '(?!\\.)'}${out}$`, 'u');
}

/** sh-style expansion of one glob argument (no brace expansion; `**` is `*`), bounded; `null` over the bound. */
function expandGlob(base: string, pattern: string, bound: number): string[] | null | 'unsupported' {
  let frontier = [base];
  for (const segment of pattern.split('/').filter(part => part.length > 0)) {
    const next: string[] = [];
    if (!GLOB_CHARS.test(segment)) { for (const dir of frontier) next.push(posix.join(dir, segment)); }
    else {
      const matcher = globSegmentRegExp(segment.replace(/\*{2,}/gu, '*'));
      if (matcher === null) return 'unsupported';
      for (const dir of frontier) {
        let names: string[];
        try { names = readdirSync(dir); } catch { continue; }
        for (const name of names.sort()) if (matcher.test(name)) next.push(posix.join(dir, name));
        if (next.length > bound) return null;
      }
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return frontier.length > bound ? null : frontier;
}

const fromScope = (error: WorkspacePathError): ShellReasonCode =>
  error === 'path-outside-workspace' ? 'PATH_OUTSIDE_ROOT' : error === 'path-denied' ? 'PATH_PROTECTED' : 'PATH_UNRESOLVED';

/**
 * The shell classifier's path check over the workspace scope (T-L4 slice 3a): one mechanism with the read tools and edits. A path
 * argument is read-only only when it lies lexically inside the root, is not denied, exists, and its real path (every symlink
 * resolved) is inside and not denied. A glob is expanded with sh rules against the real directory (dotfiles only for a leading
 * dot, bounded), and every match passes the same check; no match (sh would pass the literal) or too many is GLOB_EXPANSION. Git
 * pathspecs are checked lexically only. Not covered: intermediate symlink hops that leave the root and return (the final real path
 * is what the shell reads); the verdict is taken before the command runs, so a later swap is not excluded.
 */
export function createShellPathContext(scope: WorkspaceScope, maxGlobMatches = SHELL_GLOB_MAX_MATCHES): ShellPathContext & { readonly examined: readonly string[] } {
  const examined: string[] = [];
  const fail = (reasonCode: ShellReasonCode, word: ShellWord): ShellPathVerdict => ({ ok: false, reasonCode, detail: word.text });
  const resolved = async (rel: string, word: ShellWord): Promise<ShellPathVerdict> => {
    const found = await scope.resolve(rel === '' ? '.' : rel, true);
    return found.ok ? { ok: true } : fail(fromScope(found.error), word);
  };
  return {
    examined,
    async check(word, _readsContent, lexicalOnly = false) {
      const raw = word.text;
      if (raw === '-' || raw.length === 0) return { ok: true };
      if (word.tilde) return fail('PATH_OUTSIDE_ROOT', word);
      // Only unquoted glob characters expand: the literal prefix directory is checked first, then every match.
      const globAt = word.glob ? raw.search(GLOB_CHARS) : -1;
      let prefix = globAt >= 0 ? raw.slice(0, globAt) : raw;
      if (globAt >= 0) prefix = prefix.slice(0, prefix.lastIndexOf('/') + 1);
      const abs = posix.resolve(scope.root, prefix.length > 0 ? prefix : '.');
      const rel = posix.relative(scope.root, abs);
      if (rel.startsWith('..') || posix.isAbsolute(rel)) return fail('PATH_OUTSIDE_ROOT', word);
      examined.push(rel === '' ? '.' : rel);
      if (scope.denied(rel)) return fail('PATH_PROTECTED', word);
      if (lexicalOnly) return { ok: true };
      if (globAt < 0) return resolved(rel, word);
      const base = await resolved(rel, word);
      if (!base.ok) return base;
      const matches = expandGlob(abs, raw.slice(prefix.length), maxGlobMatches);
      if (matches === 'unsupported') return fail('GLOB_UNSUPPORTED', word);
      if (matches === null || matches.length === 0) return fail('GLOB_EXPANSION', word);
      for (const match of matches) {
        const matchRel = posix.relative(scope.root, match);
        if (scope.denied(matchRel)) return fail('PATH_PROTECTED', word);
        const verdict = await resolved(matchRel, word);
        if (!verdict.ok) return verdict;
      }
      return { ok: true };
    },
  };
}
