import { readdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import type { ShellPathContext, ShellPathVerdict, ShellReasonCode, ShellWord, ShellWritePathContext } from '#engine/index.js';
import type { WorkspacePathError, WorkspaceScope } from '#adapters/core/workspace-read/index.js';
import { ABSENT_FILE_VERSION, isWriteApprovalFloored, readWritableFile, resolveWritable } from '#adapters/core/workspace-write/index.js';

/** Default per-argument bound of shell glob expansion (legacy DEFAULT_MAX_GLOB_MATCHES); over it the command is not read-only. */
export const SHELL_GLOB_MAX_MATCHES = 10_000;
const GLOB_CHARS = /[*?[]/u;
/** A `..` path component: the kernel resolves it against the real path before it (after any symlink), never lexically. */
const PARENT_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/u;

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

/** sh-style expansion of one glob argument (no brace expansion; `**` is `*`), bounded; `null` over the bound. A `..` after a glob
 *  segment is unsupported: joining it lexically would name the match's lexical parent, not the one the kernel opens (Astra 2111). */
function expandGlob(base: string, pattern: string, bound: number): string[] | null | 'unsupported' {
  if (PARENT_SEGMENT.test(pattern)) return 'unsupported';
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

type Refused = Extract<ShellPathVerdict, { readonly ok: false }>;
const fromScope = (error: WorkspacePathError): ShellReasonCode =>
  error === 'path-outside-workspace' ? 'PATH_OUTSIDE_ROOT' : error === 'path-denied' ? 'PATH_PROTECTED' : 'PATH_UNRESOLVED';

/**
 * The shell classifier's path check over the workspace scope (T-L4 slice 3a): one mechanism with the read tools and edits. A path
 * argument is read-only only when it lies lexically inside the root, is not denied, exists, and its real path (every symlink
 * resolved) is inside and not denied. A path with a `..` component is checked as the kernel opens it (Astra 2111): components in
 * order, so `link/..` is the parent of the link's target, never the lexical parent; that object must exist, be inside and not
 * denied. A glob is expanded with sh rules against the real directory (dotfiles only for a leading dot, bounded), and every match
 * passes the same check; no match (sh would pass the literal) or too many is GLOB_EXPANSION, a `..` after a glob segment is
 * GLOB_UNSUPPORTED. Git pathspecs are checked lexically only (git normalizes them itself). Not covered: intermediate symlink hops
 * that leave the root and return (the final real path is what the shell reads); the verdict is taken before the command runs, so a
 * later swap is not excluded.
 */
export function createShellPathContext(project: WorkspaceScope, maxGlobMatches = SHELL_GLOB_MAX_MATCHES,
  roots: readonly WorkspaceScope[] = []): ShellPathContext & { readonly examined: readonly string[] } {
  const examined: string[] = [];
  const contexts = [project, ...roots].map(scope => shellPathCheck(scope, maxGlobMatches, examined));
  return {
    examined,
    // An absolute path inside a second root (SCR-A: the conversation's scratch area) is checked against that root's own scope.
    check: (word, readsContent, lexicalOnly = false) => contexts[secondRoot(roots, word.text) + 1]!(word, readsContent, lexicalOnly),
  };
}

/** Index of the second root that lexically holds an absolute `path` (-1: none, the project scope decides). */
export function secondRoot(roots: readonly WorkspaceScope[], path: string): number {
  return path.startsWith('/') ? roots.findIndex(root => path === root.root || path.startsWith(`${root.root}/`)) : -1;
}

function shellPathCheck(scope: WorkspaceScope, maxGlobMatches: number, examined: string[]): ShellPathContext['check'] {
  const fail = (reasonCode: ShellReasonCode, word: ShellWord): Refused => ({ ok: false, reasonCode, detail: word.text });
  const resolved = async (rel: string, word: ShellWord): Promise<ShellPathVerdict> => {
    const found = await scope.resolve(rel === '' ? '.' : rel, true);
    return found.ok ? { ok: true } : fail(fromScope(found.error), word);
  };
  /** The object the kernel opens for `path` from the root: native realpath(3) on the unnormalized text resolves `..` after each
   *  symlink as the kernel does (path.resolve, join or realpathSync would drop `link/..` lexically first). */
  const opened = async (path: string, word: ShellWord): Promise<{ readonly ok: true; readonly abs: string; readonly rel: string } | Refused> => {
    let real: string;
    try { real = await realpath(posix.isAbsolute(path) ? path : `${scope.root}/${path}`); } catch { return fail('PATH_UNRESOLVED', word); }
    const rel = posix.relative(scope.root, real);
    if (rel.startsWith('..') || posix.isAbsolute(rel)) return fail('PATH_OUTSIDE_ROOT', word);
    if (scope.denied(rel)) return fail('PATH_PROTECTED', word);
    return { ok: true, abs: real, rel };
  };
  return async (word, _readsContent, lexicalOnly = false) => {
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
    const parent = PARENT_SEGMENT.test(prefix);
    if (globAt < 0) {
      if (!parent) return resolved(rel, word);
      const target = await opened(raw, word);
      return target.ok ? resolved(target.rel, word) : target;
    }
    // With a `..` in the literal prefix, sh lists the directory the kernel opens: that one is checked and expanded.
    const dir = parent ? await opened(prefix, word) : { ok: true as const, abs, rel };
    if (!dir.ok) return dir;
    const base = await resolved(dir.rel, word);
    if (!base.ok) return base;
    const matches = expandGlob(dir.abs, raw.slice(prefix.length), maxGlobMatches);
    if (matches === 'unsupported') return fail('GLOB_UNSUPPORTED', word);
    if (matches === null || matches.length === 0) return fail('GLOB_EXPANSION', word);
    for (const match of matches) {
      const matchRel = posix.relative(scope.root, match);
      if (scope.denied(matchRel)) return fail('PATH_PROTECTED', word);
      const verdict = await resolved(matchRel, word);
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  };
}

/**
 * Write targets of the narrow mutating tier (T-L4 slice 4a), over the same workspace scope and write floor as agent edits: inside the
 * workspace, not denied, parent a real directory inside, not on the write floor (a new directory is refused when anything under it
 * would be), and the target absent (new directory), absent or a single-link regular file (file), or such an existing file (the source
 * of `mv`). Anything else makes the command not narrow — it then asks, as before. An absolute path inside a second root (SCR-A: the
 * conversation's scratch area) is checked the same way against that root's scope.
 */
export function createShellWriteContext(project: WorkspaceScope, roots: readonly WorkspaceScope[] = [], projectFloor = isWriteApprovalFloored): ShellWritePathContext {
  return {
    async checkWrite(word, kind): Promise<ShellPathVerdict> {
      const scope = roots[secondRoot(roots, word.text)] ?? project;
      const refuse = (reasonCode: 'PATH_OUTSIDE_ROOT' | 'PATH_PROTECTED' | 'PATH_UNRESOLVED'): ShellPathVerdict => ({ ok: false, reasonCode, detail: word.text });
      const target = await resolveWritable(scope, word.text);
      if (!target.ok) return refuse(target.error === 'outside-workspace' ? 'PATH_OUTSIDE_ROOT' : target.error === 'denied' ? 'PATH_PROTECTED' : 'PATH_UNRESOLVED');
      const floored = scope === project ? projectFloor : isWriteApprovalFloored;
      if (floored(target.rel) || (kind === 'new-directory' && floored(`${target.rel}/-`))) return refuse('PATH_PROTECTED');
      // An existing directory, link or multi-link file is refused here (`not-a-file`, `is-link`, `hard-linked`): `cp`/`mv` onto a
      // directory would write `target/basename(source)`, a path this check never saw (Astra 2133), so a directory target is not narrow.
      const current = await readWritableFile(scope, target).catch(() => null);
      if (!current?.ok) return refuse('PATH_UNRESOLVED');
      const absent = current.version === ABSENT_FILE_VERSION;
      return (kind === 'new-directory' && !absent) || (kind === 'existing-file' && absent) ? refuse('PATH_UNRESOLVED') : { ok: true };
    },
  };
}

/**
 * SHELL-AUTONOMY: whether a word of a command names a protected path — the write floor or the product state (its glob patterns,
 * relative to the project root) — by name only, lexically (no file system): as resolved from the project root when it lies inside,
 * and with leading `./`/`../` segments dropped (a `cd` earlier in the same command moves the base). A path or its directory form
 * (`.github` for `.github/**`) counts. A name is not a boundary: the sandbox realm keeps existing floor paths read-only itself.
 */
export function createShellProtectedNames(root: string, productState: readonly ((rel: string) => boolean)[], floored = isWriteApprovalFloored): (text: string) => boolean {
  const named = (rel: string) => rel.length > 0 && [rel, `${rel}/-`].some(path => floored(path) || productState.some(match => match(path)));
  return text => {
    const inside = posix.relative(root, posix.resolve(root, text)), stripped = posix.normalize(text).replace(/^(?:\.\.?\/)+/u, '');
    return (!inside.startsWith('..') && !posix.isAbsolute(inside) && named(inside)) || (!posix.isAbsolute(stripped) && named(stripped.replace(/\/+$/u, '')));
  };
}
