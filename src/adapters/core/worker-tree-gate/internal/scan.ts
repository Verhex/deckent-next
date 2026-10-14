import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { EMPTY_KNOWN_SECRETS, REDACTION_PATTERNS, redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';
import type { WorkerTreeFinding, WorkerTreeLimit, WorkerTreeScan } from '#engine/index.js';
import { createGlobMatcher, CREDENTIAL_WORKSPACE_DENY } from '#adapters/core/workspace-read/index.js';

/** Bounds and the operator acknowledgement (`execution.secretGate`); every bound fails closed as an incomplete scan. */
export interface WorkerTreeGateOptions {
  readonly allowPatternPaths: readonly string[]; readonly acknowledgedDenyPaths: readonly string[];
  readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly timeoutMs: number;
}
/** S6: the deny paths the gate refuses are the terminal's credential floor (`CREDENTIAL_WORKSPACE_DENY`) — the same list, never a copy. */
export const WORKER_TREE_DENY: readonly string[] = CREDENTIAL_WORKSPACE_DENY;
/** The content rules are the redaction table's rows marked `gate` (versioned registry data); `source` is the table's precise expression. */
export const WORKER_TREE_PATTERN_RULES = Object.freeze(REDACTION_PATTERNS.filter(row => row.gate === true));
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** The clone's object store (history) and its index (the tree's own paths again) are the only entries not read; see the S6 report. */
const UNREAD_GIT_ENTRIES: ReadonlySet<string> = new Set(['.git/objects', '.git/index']);

/**
 * One thing the worker receives, named as the worker sees it: the checkout (`label` ''), a profile read-only bind or a mounted task/handoff
 * input (`label` its container target), or text delivered in the prompt (`text`, e.g. the dependency context). Every view is scanned.
 */
export type WorkerTreeView = Readonly<{ source: string; label: string }> | Readonly<{ text: string; label: string }>;
/** Everything `executeConfiguredTask` hands to a worker besides its own profile: the one list the gate scans (S6 sibling-path parity). */
export function workerTreeViews(workspace: string, readOnlyMounts: readonly Readonly<{ source: string; target: string }>[] | undefined, start: Readonly<{
  inputs: readonly Readonly<{ name: string; path: string }>[]; handoffInputs: readonly Readonly<{ target: string; path: string }>[];
  dependencyContext?: Readonly<{ text: string }> }>, argv: readonly string[] = []): readonly WorkerTreeView[] {
  return Object.freeze([{ source: workspace, label: '' }, ...(readOnlyMounts ?? []).map(mount => ({ source: mount.source, label: mount.target })),
    ...start.inputs.map(input => ({ source: input.path, label: `/deckent/inputs/${input.name}` })), ...start.handoffInputs.map(input => ({ source: input.path, label: input.target })),
    ...(start.dependencyContext ? [{ text: start.dependencyContext.text, label: 'prompt:dependency-context' }] : []),
    ...(argv.length ? [{ text: argv.join('\n'), label: 'argv' }] : [])]);
}

/** A path as a deny rule sees it: POSIX-normalized, no leading `/` or `./`, no trailing `/`, lower case; plus its NFKC form. */
function denyForms(path: string): readonly string[] {
  const normal = posix.normalize(path.replace(/\\/gu, '/')).replace(/^(?:\.?\/)+/u, '').replace(/\/+$/u, '').toLowerCase();
  return normal === '' || normal === '.' ? [] : [...new Set([normal, normal.normalize('NFKC'), normal.normalize('NFC'), normal.normalize('NFD')])];
}

class Incomplete extends Error { constructor(readonly limit: WorkerTreeLimit, readonly observed: number, readonly bound: number) { super(limit); } }

/**
 * The pre-dispatch scan of exactly what the worker's container receives: the whole prepared checkout (predecessor patches applied),
 * including the clone's `.git` metadata (config, refs, logs), except `.git/objects` — the history the owner deferred to a later scan — and
 * `.git/index`. Fail closed throughout:
 * - a deny-listed path — matched relative to its view's root (as the terminal floor does) and as the container path, normalized (no `./`,
 *   no trailing `/`), case-insensitive and in NFC/NFD/NFKC form; a symlink's target path too; files and directories are never read or
 *   descended — unless an exact `acknowledgedDenyPaths` entry, which is then read and scanned like any file;
 * - every regular file's full content, binary files included (UTF-8, plus UTF-16 in both byte alignments when it holds NUL bytes), and every
 *   symlink's target text: a configured secret value anywhere, or a `gate` pattern outside `allowPatternPaths`; symlinks are never followed;
 * - an entry that is neither file, directory nor symlink (FIFO, socket, device) is refused as unscannable;
 * - files, single-file bytes, total bytes and time are bounded and return `incomplete`; any I/O error rejects (no dispatch either way).
 * Shown paths have control characters escaped and pass the record redactor with the configured values, so no path carries a value.
 */
export async function scanWorkerTree(input: string | readonly WorkerTreeView[], options: WorkerTreeGateOptions, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS,
  now: () => number = Date.now): Promise<WorkerTreeScan> {
  const deny = WORKER_TREE_DENY.map(pattern => ({ pattern, match: createGlobMatcher(pattern.toLowerCase()) }));
  const allowed = options.allowPatternPaths.map(createGlobMatcher), rules = WORKER_TREE_PATTERN_RULES.map(row => ({ id: row.id, expression: new RegExp(row.source, row.flags.replace('g', '')) }));
  const findings: WorkerTreeFinding[] = [], started = now(), deadline = started + options.timeoutMs;
  let files = 0, total = 0;
  const acknowledged = new Set(options.acknowledgedDenyPaths);
  /** Anchored like the terminal floor (relative to the view's own root) and as the worker sees it (container path), plus the basename for a
   * single mounted file: a match in any form refuses. Only an exact acknowledged checkout path skips the rule. */
  const denied = (...paths: readonly string[]) => acknowledged.has(paths[0]!) ? undefined
    : deny.find(entry => paths.flatMap(denyForms).some(form => entry.match(form)))?.pattern;
  const shown = (rel: string) => redactForRecord(rel.replace(/\p{Cc}/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`), known);
  const time = () => { if (now() >= deadline) throw new Incomplete('time', now() - started, options.timeoutMs); };
  const read = async (path: string): Promise<Buffer> => {
    const handle = await open(path, FILE_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('WORKER_TREE_ENTRY_CHANGED');
      if (info.size > options.maxFileBytes) throw new Incomplete('file-bytes', info.size, options.maxFileBytes);
      if ((total += info.size) > options.maxTotalBytes) throw new Incomplete('total-bytes', total, options.maxTotalBytes);
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) { const chunk = await handle.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
      const after = await handle.stat();
      // A file that grew, shrank or changed while it was read is never passed on a partial view.
      if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('WORKER_TREE_ENTRY_CHANGED');
      return bytes;
    } finally { await handle.close(); }
  };
  const texts = (bytes: Buffer) => bytes.includes(0) ? [bytes.toString('utf8'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')] : [bytes.toString('utf8')];
  const inspect = (rel: string, candidates: readonly string[]) => {
    if (candidates.some(text => known.spans(text).length)) { findings.push({ path: shown(rel), rule: 'known-secret' }); return; }
    if (allowed.some(match => match(rel))) return;
    const rule = rules.find(row => candidates.some(text => row.expression.test(text)));
    if (rule) findings.push({ path: shown(rel), rule: `pattern:${rule.id}` });
  };
  /** `display` is the path as the worker sees it, without a leading slash (the checkout's own paths are unchanged); rules match on it. */
  const entry = async (path: string, display: string, inner: string): Promise<void> => {
    if (UNREAD_GIT_ENTRIES.has(inner)) return;
    if (++files > options.maxFiles) throw new Incomplete('files', files, options.maxFiles);
    time();
    const pattern = inner === '' && display !== '' ? denied(display, posix.basename(display)) : denied(display, inner);
    if (pattern !== undefined) { findings.push({ path: shown(display), rule: `deny-path:${pattern}` }); return; }
    const info = await lstat(path);
    if (info.isDirectory()) await visit(path, display + '/', inner === '' ? '' : inner + '/');
    else if (info.isSymbolicLink()) {
      // The link's target path is a path the worker can open: deny rules apply to it (relative to the link, and as written).
      const target = await readlink(path), hit = target.startsWith('/') ? denied(target) : denied(posix.join(posix.dirname(display), target), posix.join(posix.dirname(inner), target));
      if (hit !== undefined) findings.push({ path: shown(display), rule: `deny-path:${hit}` }); else inspect(display, [target]);
    }
    else if (info.isFile()) { inspect(display, texts(await read(path))); time(); }
    else findings.push({ path: shown(display), rule: 'unscannable:special-file' });
  };
  const visit = async (directory: string, prefix: string, innerPrefix = prefix): Promise<void> => {
    const names = (await readdir(directory)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) await entry(join(directory, name), prefix + name, innerPrefix + name);
  };
  const views: readonly WorkerTreeView[] = typeof input === 'string' ? [{ source: input, label: '' }] : input;
  try {
    for (const view of views) {
      const label = view.label === '' ? '' : posix.normalize(view.label).replace(/^(?:\.?\/)+/u, '').replace(/\/+$/u, '');
      if ('text' in view) {
        const bytes = Buffer.byteLength(view.text); time();
        if (bytes > options.maxFileBytes) throw new Incomplete('file-bytes', bytes, options.maxFileBytes);
        if ((total += bytes) > options.maxTotalBytes) throw new Incomplete('total-bytes', total, options.maxTotalBytes);
        inspect(label, [view.text]);
      }
      else if (label === '') await visit(view.source, '');
      else await entry(view.source, label, '');
    }
  }
  catch (error) { if (error instanceof Incomplete) return Object.freeze({ status: 'incomplete', limit: error.limit, observed: error.observed, bound: error.bound }); throw error; }
  return findings.length ? Object.freeze({ status: 'refused', findings: Object.freeze(findings), count: findings.length }) : Object.freeze({ status: 'clean' });
}
