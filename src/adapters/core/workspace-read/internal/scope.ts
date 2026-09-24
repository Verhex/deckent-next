import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Generated/vendored directory names skipped by walks (legacy baseline), plus unambiguous directory names from the root .gitignore. */
export const BASELINE_IGNORED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.nyc_output', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '__pycache__', '.venv', 'venv']);

/**
 * Paths no read tool returns, matched against the workspace-relative path (registry data; the default is the Core floor).
 * Reading them needs an explicit, reviewed change of this list, never a model argument.
 */
export const DEFAULT_WORKSPACE_READ_DENY: readonly string[] = Object.freeze(['.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key',
  '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.credentials.json', '**/.npmrc', '**/.netrc', '.git/**', '**/.git/**',
  '.deckent/host/**', '.deckent/audit-key/**', '.deckent/approvals/**']);

/** Minimal glob: a double star followed by a slash is any run of directories, a double star anything, `*` within a segment, `?` one character; anchored on the
 * '/'-joined relative path. Translated token by token, so no produced fragment is rewritten again. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export type WorkspacePathError = 'path-invalid' | 'path-outside-workspace' | 'path-denied' | 'not-found';
export type ResolvedPath = { readonly ok: true; readonly abs: string; readonly rel: string } | { readonly ok: false; readonly error: WorkspacePathError };

export interface WorkspaceScope {
  readonly root: string;
  readonly ignoredDirs: ReadonlySet<string>;
  denied(rel: string): boolean;
  /** The real path of an existing target inside the workspace; symlinks are resolved and must stay inside. */
  resolve(requested: unknown, allowRoot?: boolean): Promise<ResolvedPath>;
}

const toPosix = (path: string) => path.split(sep).join('/');

export async function createWorkspaceScope(rootInput: string, deny: readonly string[] = DEFAULT_WORKSPACE_READ_DENY): Promise<WorkspaceScope> {
  const root = await realpath(rootInput);
  const denyRes = deny.map(globToRegExp);
  const ignoredDirs = new Set(BASELINE_IGNORED_DIRS);
  try {
    for (const raw of (await readFile(join(root, '.gitignore'), 'utf8')).split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
      const name = (line.startsWith('/') ? line.slice(1) : line).replace(/\/$/, '');
      if (name !== '' && !/[*?[\]]/.test(name) && !name.includes('/')) ignoredDirs.add(name);
    }
  } catch { /* no readable .gitignore: the baseline stands */ }
  const inside = (abs: string, allowRoot: boolean) => { const rel = relative(root, abs); return rel === '' ? allowRoot : !rel.startsWith('..') && !isAbsolute(rel); };
  const denied = (rel: string) => rel !== '' && denyRes.some(re => re.test(rel));
  return Object.freeze({
    root, ignoredDirs, denied,
    async resolve(requested: unknown, allowRoot = false): Promise<ResolvedPath> {
      if (requested !== undefined && typeof requested !== 'string') return { ok: false, error: 'path-invalid' };
      const text = requested === undefined || requested === '' || requested === '.' ? '.' : requested;
      if (text.includes('\0')) return { ok: false, error: 'path-invalid' };
      const candidate = isAbsolute(text) ? text : resolve(root, text);
      if (!inside(candidate, allowRoot)) return { ok: false, error: 'path-outside-workspace' };
      if (denied(toPosix(relative(root, candidate)))) return { ok: false, error: 'path-denied' };
      let real: string;
      try { real = await realpath(candidate); } catch { return { ok: false, error: 'not-found' }; }
      // A symlink inside the workspace may point anywhere: the resolved target must be inside and not denied either.
      if (!inside(real, allowRoot)) return { ok: false, error: 'path-outside-workspace' };
      const rel = toPosix(relative(root, real));
      if (denied(rel)) return { ok: false, error: 'path-denied' };
      return { ok: true, abs: real, rel };
    },
  });
}

/**
 * Depth-capped walk over regular files; ignored directory names and denied paths are skipped, symlinks are never followed.
 * The visitor returns false to stop. Unreadable directories are skipped, never thrown.
 */
export async function walkWorkspaceFiles(scope: WorkspaceScope, startAbs: string, visit: (abs: string, rel: string) => Promise<boolean> | boolean): Promise<void> {
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > 12) return true;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return true; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scope.ignoredDirs.has(entry.name)) continue;
      const abs = join(dir, entry.name), rel = toPosix(relative(scope.root, abs));
      if (scope.denied(rel)) continue;
      if (entry.isDirectory()) { if (!await walk(abs, depth + 1)) return false; }
      else if (entry.isFile() && !await visit(abs, rel)) return false;
    }
    return true;
  };
  await walk(startAbs, 0);
}
