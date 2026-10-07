import { existsSync } from 'node:fs';
import { constants, open, readdir, readFile, readlink, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createGlobMatcher, globLiteralHead } from '#platform/index.js';

/** Generated/vendored directory names skipped by walks (legacy baseline), plus unambiguous directory names from the root .gitignore. */
export const BASELINE_IGNORED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.nyc_output', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '__pycache__', '.venv', 'venv']);

/**
 * Paths no read tool returns, matched against the workspace-relative real path (registry data; the default is the Core floor).
 * Reading them needs an explicit, reviewed change of this list, never a model argument.
 */
export const DEFAULT_WORKSPACE_READ_DENY: readonly string[] = Object.freeze(['.env', '.env.*', '**/.env', '**/.env.*', '**/*.pem', '**/*.key',
  '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.credentials.json', '**/.npmrc', '**/.netrc', '.git/**', '**/.git/**',
  '.deckent/host/**', '.deckent/audit-key/**', '.deckent/approvals/**',
  // Credential carriers the legacy shell classifier protected (T-L4 slice 3a): one protected set for read tools, shell and edits.
  '**/*.pfx', '**/*.keystore', '**/*.jks', '**/.pypirc', '**/credentials', '**/credentials.json', '**/secrets.json', '.brain/memory.db*',
  // The repository directory itself, not only its content: listing `.git` is refused too.
  '.git', '**/.git']);
/** The repository internals of the default deny (MODES-3): the only entries a full-access turn opens (commit, branch, push); credentials stay. */
export const REPOSITORY_INTERNALS_DENY: readonly string[] = Object.freeze(['.git/**', '**/.git/**', '.git', '**/.git']);

// The glob grammar (wildcards, literal head) is the platform's one definition (`#platform/core/common`): the matcher, the anchor derivation
// and the product layout admission share it (Astra 2164/2166) — a bracketed path such as `.cache/deckent[1]/state/ledger.db*` keeps its brackets.
export { createGlobMatcher, globLiteralHead } from '#platform/index.js';

export type WorkspacePathError = 'path-invalid' | 'path-outside-workspace' | 'path-denied' | 'not-found' | 'path-changed' | 'not-a-file'
  | 'not-a-directory' | 'hardlink-refused' | 'platform-unsupported';
/** B4 diagnosis (owner terminal test 2026-10-07): the step a `not-found` / `path-changed` came from and its system error code — never a path. */
export interface WorkspacePathDiagnostic { readonly step: string; readonly errno?: string }
type Refused = { readonly ok: false; readonly error: WorkspacePathError; readonly diagnostic?: WorkspacePathDiagnostic };
export type ResolvedPath = { readonly ok: true; readonly rel: string } | Refused;
export type OpenedPath = { readonly ok: true; readonly handle: FileHandle; readonly rel: string } | Refused;
/** Why a walk did not cover everything: never reported as "not there" (Astra 2072 R4). */
export interface WalkIncomplete { depthLimited: number; unreadable: number; changed: number; special: number }

export interface WorkspaceScope {
  readonly root: string;
  readonly ignoredDirs: ReadonlySet<string>;
  /** The literal, nested heads of the deny patterns (`.deckent/live-data/state/ledger.db` from `…/ledger.db*`, `.deckent/host` from
   * `.deckent/host/**`; a pattern starting with a glob has none): paths whose ancestors a shell sandbox must never grant whole, even
   * under an ignored tree (Astra 2162). Derived from the deny list, so a `.gitignore` change cannot lift them. */
  readonly protectedAnchors: ReadonlySet<string>;
  denied(rel: string): boolean;
  /** The real, workspace-relative path of an existing target; symlinks are resolved and must stay inside and not denied. */
  resolve(requested: unknown, allowRoot?: boolean): Promise<ResolvedPath>;
  /** Opens a resolved path descriptor-relative from the workspace root, never following a symlink in any component. */
  open(rel: string, kind: 'file' | 'dir'): Promise<OpenedPath>;
  /** True while the descriptor still is the workspace path `rel` (its kernel path is re-read). */
  verify(handle: FileHandle, rel: string): Promise<boolean>;
}

const toPosix = (path: string) => path.split(sep).join('/');
/** A system error code as raised (`ENOENT`, `EACCES`, …); anything else is left out. */
const errnoOf = (error: unknown): string | undefined => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9]{1,15}$/u.test(code) ? code : undefined;
};
const diagnosed = (step: string, error?: unknown): WorkspacePathDiagnostic => {
  const errno = errnoOf(error);
  return errno === undefined ? { step } : { step, errno };
};
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Non-blocking so a FIFO or device never stalls the service at open; the type is checked on the descriptor before reading.
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const MAX_WALK_DEPTH = 32;

/**
 * The workspace boundary for read tools (T-L1, Astra 2072 R1). A path check followed by opening the same pathname again is a
 * race: a parent directory can be swapped for a symlink in between. So every open walks the real path's components from a
 * root descriptor (`/proc/self/fd/<fd>/<name>`, openat semantics on Linux) with no-follow on each component, and the opened
 * descriptor's own path is checked again. Files with more than one link are refused, because a hard link can alias a protected
 * file under an innocent name. Platforms without per-descriptor paths fail closed.
 */
export async function createWorkspaceScope(rootInput: string, deny: readonly string[] = DEFAULT_WORKSPACE_READ_DENY): Promise<WorkspaceScope> {
  const supported = process.platform === 'linux' && existsSync('/proc/self/fd');
  const root = await realpath(rootInput);
  const denyMatchers = deny.map(createGlobMatcher);
  const ignoredDirs = new Set(BASELINE_IGNORED_DIRS);
  try {
    for (const raw of (await readFile(join(root, '.gitignore'), 'utf8')).split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
      const name = (line.startsWith('/') ? line.slice(1) : line).replace(/\/$/, '');
      if (name !== '' && !/[*?[\]]/.test(name) && !name.includes('/')) ignoredDirs.add(name);
    }
  } catch { /* no readable .gitignore: the baseline stands */ }
  const protectedAnchors = new Set(deny.flatMap(pattern => {
    const head = globLiteralHead(pattern).replace(/\/$/u, '');
    return head.includes('/') ? [head] : [];
  }));
  const inside = (abs: string, allowRoot: boolean) => { const rel = relative(root, abs); return rel === '' ? allowRoot : !rel.startsWith('..') && !isAbsolute(rel); };
  const denied = (rel: string) => rel !== '' && denyMatchers.some(match => match(rel));
  const close = async (handle: FileHandle | undefined) => { await handle?.close().catch(() => undefined); };
  /** The descriptor must still be the workspace path it was opened as: its kernel path is re-read and compared. */
  const verify = async (handle: FileHandle, rel: string) => {
    try { return await readlink(fdPath(handle)) === (rel === '' ? root : join(root, rel)); } catch { return false; }
  };
  return Object.freeze({
    root, ignoredDirs, protectedAnchors, denied, verify,
    async resolve(requested: unknown, allowRoot = false): Promise<ResolvedPath> {
      if (!supported) return { ok: false, error: 'platform-unsupported' };
      if (requested !== undefined && typeof requested !== 'string') return { ok: false, error: 'path-invalid' };
      const text = requested === undefined || requested === '' || requested === '.' ? '.' : requested;
      if (text.includes('\0')) return { ok: false, error: 'path-invalid' };
      const candidate = isAbsolute(text) ? text : resolve(root, text);
      if (!inside(candidate, allowRoot)) return { ok: false, error: 'path-outside-workspace' };
      if (denied(toPosix(relative(root, candidate)))) return { ok: false, error: 'path-denied' };
      let real: string;
      // Every realpath failure still reads `not-found` (unchanged); the diagnostic keeps which errno it was (B4).
      try { real = await realpath(candidate); } catch (error) { return { ok: false, error: 'not-found', diagnostic: diagnosed('realpath', error) }; }
      if (!inside(real, allowRoot)) return { ok: false, error: 'path-outside-workspace' };
      const rel = toPosix(relative(root, real));
      if (denied(rel)) return { ok: false, error: 'path-denied' };
      return { ok: true, rel };
    },
    async open(rel: string, kind: 'file' | 'dir'): Promise<OpenedPath> {
      if (!supported) return { ok: false, error: 'platform-unsupported' };
      if (denied(rel)) return { ok: false, error: 'path-denied' };
      let current: FileHandle | undefined, step = 'open:0';
      try {
        current = await open(root, DIR_FLAGS);
        if (!await verify(current, '')) { await close(current); return { ok: false, error: 'path-changed', diagnostic: { step: 'verify:0' } }; }
        const segments = rel === '' ? [] : rel.split('/');
        for (let i = 0; i < segments.length; i++) {
          const last = i === segments.length - 1;
          step = `open:${i + 1}`;
          const next = await open(`${fdPath(current)}/${segments[i]}`, last && kind === 'file' ? FILE_FLAGS : DIR_FLAGS);
          await close(current); current = next;
        }
        if (!await verify(current, rel)) { await close(current); return { ok: false, error: 'path-changed', diagnostic: { step: `verify:${segments.length}` } }; }
        step = 'stat';
        const info = await current.stat();
        if (kind === 'dir' ? !info.isDirectory() : !info.isFile()) { await close(current); return { ok: false, error: kind === 'dir' ? 'not-a-directory' : 'not-a-file' }; }
        if (kind === 'file' && info.nlink > 1) { await close(current); return { ok: false, error: 'hardlink-refused' }; }
        return { ok: true, handle: current, rel };
      } catch (error) {
        await close(current);
        return { ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'path-changed', diagnostic: diagnosed(step, error) };
      }
    },
  });
}

/**
 * Descriptor-relative walk over regular files: each directory is opened from its parent descriptor with no-follow, entries are
 * listed through the descriptor, symlinks are never followed, ignored names and denied paths are skipped. What could not be
 * covered (depth, unreadable or changed directories) is counted, never silently treated as absent.
 */
export async function walkWorkspaceFiles(scope: WorkspaceScope, startRel: string, visit: (rel: string, parent: FileHandle, name: string) => Promise<boolean> | boolean,
  signal?: AbortSignal): Promise<WalkIncomplete> {
  const incomplete: WalkIncomplete = { depthLimited: 0, unreadable: 0, changed: 0, special: 0 };
  const walk = async (dir: FileHandle, dirRel: string, depth: number): Promise<boolean> => {
    let entries;
    try { entries = await readdir(fdPath(dir), { withFileTypes: true }); } catch { incomplete.unreadable++; return true; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal?.aborted) return false;
      if (scope.ignoredDirs.has(entry.name)) continue;
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
      if (scope.denied(rel)) continue;
      if (entry.isDirectory()) {
        if (depth + 1 > MAX_WALK_DEPTH) { incomplete.depthLimited++; continue; }
        let child: FileHandle;
        try { child = await open(`${fdPath(dir)}/${entry.name}`, DIR_FLAGS); } catch { incomplete.changed++; continue; }
        // The parent may have moved since its entries were read: the child must still be the workspace path (Astra 2078 R1).
        if (!await scope.verify(child, rel)) { await child.close().catch(() => undefined); incomplete.changed++; continue; }
        try { if (!await walk(child, rel, depth + 1)) return false; } finally { await child.close().catch(() => undefined); }
      } else if (entry.isFile()) { if (!await visit(rel, dir, entry.name)) return false; }
      // FIFOs, sockets and devices are never opened for content; they are counted, not hidden.
      else if (!entry.isSymbolicLink()) incomplete.special++;
    }
    return true;
  };
  const start = await scope.open(startRel, 'dir');
  if (!start.ok) { incomplete.unreadable++; return incomplete; }
  try { await walk(start.handle, startRel, 0); } finally { await start.handle.close().catch(() => undefined); }
  return incomplete;
}

/** Opens a walked file from its parent directory descriptor: no-follow, non-blocking, still at its workspace path, regular single-link files only. */
export async function openWalkedFile(scope: WorkspaceScope, parent: FileHandle, name: string, rel: string): Promise<{ ok: true; handle: FileHandle } | { ok: false; reason: string }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(`${fdPath(parent)}/${name}`, FILE_FLAGS);
    if (!await scope.verify(handle, rel)) { await handle.close(); return { ok: false, reason: 'changed during the walk' }; }
    const info = await handle.stat();
    if (!info.isFile()) { await handle.close(); return { ok: false, reason: 'not a regular file' }; }
    if (info.nlink > 1) { await handle.close(); return { ok: false, reason: 'hard link refused' }; }
    return { ok: true, handle };
  } catch { await handle?.close().catch(() => undefined); return { ok: false, reason: 'changed during the walk' }; }
}

export function describeIncomplete(incomplete: WalkIncomplete): string | null {
  const parts = [...(incomplete.depthLimited ? [`${incomplete.depthLimited} director${incomplete.depthLimited === 1 ? 'y' : 'ies'} beyond depth ${MAX_WALK_DEPTH} (search a subdirectory)`] : []),
    ...(incomplete.unreadable ? [`${incomplete.unreadable} unreadable director${incomplete.unreadable === 1 ? 'y' : 'ies'}`] : []),
    ...(incomplete.changed ? [`${incomplete.changed} director${incomplete.changed === 1 ? 'y' : 'ies'} changed or symlinked during the walk`] : []),
    ...(incomplete.special ? [`${incomplete.special} special file(s) (FIFO, socket or device) not read`] : [])];
  return parts.length ? `not fully scanned: ${parts.join('; ')}` : null;
}
