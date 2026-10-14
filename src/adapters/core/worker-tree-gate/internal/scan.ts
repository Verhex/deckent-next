import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { EMPTY_KNOWN_SECRETS, redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';
import type { WorkerTreeExclusion, WorkerTreeFinding, WorkerTreeLimit, WorkerTreeScan } from '#engine/index.js';
import { archiveKind, contentRule, decodedTexts } from './content.js';
import { createGlobMatcher, CREDENTIAL_WORKSPACE_DENY } from '#adapters/core/workspace-read/index.js';

/** Bounds and the operator acknowledgement (`execution.secretGate`); every bound fails closed as an incomplete scan. */
export interface WorkerTreeGateOptions {
  readonly allowPatternPaths: readonly string[]; readonly acknowledgedDenyPaths: readonly string[];
  readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly timeoutMs: number;
}
/** S6: the deny paths the gate refuses are the terminal's credential floor (`CREDENTIAL_WORKSPACE_DENY`) — the same list, never a copy. */
export const WORKER_TREE_DENY: readonly string[] = CREDENTIAL_WORKSPACE_DENY;
export { WORKER_TREE_PATTERN_RULES } from './content.js';
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

/**
 * A path as a deny rule sees it: POSIX-normalized (no `..`, no leading `/` or `./`, no trailing `/`), lower case, in NFC/NFD/NFKC form, and
 * with trailing dots/spaces of each segment removed (a Windows-backed bind opens `.env.` or `.env ` as `.env`).
 */
function denyForms(path: string): readonly string[] {
  const normal = posix.normalize(path.replace(/\\/gu, '/')).replace(/^(?:\.?\/)+/u, '').replace(/\/+$/u, '').toLowerCase();
  if (normal === '' || normal === '.') return [];
  const forms = [normal, normal.normalize('NFKC'), normal.normalize('NFC'), normal.normalize('NFD')];
  return [...new Set([...forms, ...forms.map(form => form.split('/').map(part => /^\.+$/u.test(part) ? part : part.replace(/[. ]+$/u, '')).join('/'))])];
}

class Incomplete extends Error { constructor(readonly limit: WorkerTreeLimit, readonly observed: number, readonly bound: number) { super(limit); } }

/**
 * The pre-dispatch scan of exactly what the worker receives (every `WorkerTreeView`): the prepared checkout with its `.git` metadata (config,
 * refs, logs) except `.git/objects` — history, a later card by owner decision — and `.git/index`. Fail closed throughout:
 * - a deny-listed path, matched relative to its view's root (as the terminal floor does), as the container path and, for a single mounted
 *   file, by basename, in every normalized form; a symlink's target path too. Never read or descended, unless an exact `acknowledgedDenyPaths`
 *   entry lifts it (audited as an exclusion), after which it is read and scanned like any file;
 * - every regular file read whole, in every reading a worker's tools can take of the bytes (`decodedTexts`): a configured secret value (never
 *   liftable), a gated table row, or `config-secret` in a config-like file; a compressed or archived file the gate cannot read the way the
 *   worker can is `unscannable:archive-<kind>`; content and archive hits under an `allowPatternPaths` glob are lifted and returned as exclusions;
 * - an entry that is neither file, directory nor symlink is `unscannable:special-file`; a file that changes while read, or any I/O error, rejects;
 * - files, single-file bytes, total bytes and time are bounded and return `incomplete`, never a partial `clean`.
 * Shown paths have control characters escaped and pass the record redactor with the configured values, so no path carries a value.
 */
export async function scanWorkerTree(input: string | readonly WorkerTreeView[], options: WorkerTreeGateOptions, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS,
  now: () => number = Date.now): Promise<WorkerTreeScan> {
  const deny = WORKER_TREE_DENY.map(pattern => ({ pattern, match: createGlobMatcher(pattern.toLowerCase()) }));
  const allowed = options.allowPatternPaths.map(glob => ({ glob, match: createGlobMatcher(glob) })), acknowledged = new Set(options.acknowledgedDenyPaths);
  const findings: WorkerTreeFinding[] = [], excluded: WorkerTreeExclusion[] = [], started = now(), deadline = started + options.timeoutMs;
  let files = 0, total = 0;
  const denyHit = (...paths: readonly string[]) => deny.find(entry => paths.flatMap(denyForms).some(form => entry.match(form)))?.pattern;
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
  /** A liftable hit: refused, or an audited exclusion when the exact path lies under an operator glob. Configured values are never liftable. */
  const liftable = (rel: string, rule: string) => {
    const by = allowed.find(entry => entry.match(rel));
    if (by) excluded.push({ path: shown(rel), rule, by: `allowPatternPaths:${by.glob}` }); else findings.push({ path: shown(rel), rule });
  };
  const inspect = (rel: string, texts: readonly string[], bytes?: Buffer) => {
    if (texts.some(text => known.spans(text).length)) { findings.push({ path: shown(rel), rule: 'known-secret' }); return; }
    const rule = contentRule(rel, texts), archive = bytes ? archiveKind(bytes) : null;
    if (rule !== null) liftable(rel, `pattern:${rule}`); else if (archive !== null) liftable(rel, `unscannable:archive-${archive}`);
  };
  /** `display` is the path as the worker sees it, without a leading slash (the checkout's own paths are unchanged); rules match on it. */
  const entry = async (path: string, display: string, inner: string): Promise<void> => {
    if (UNREAD_GIT_ENTRIES.has(inner)) return;
    if (++files > options.maxFiles) throw new Incomplete('files', files, options.maxFiles);
    time();
    const pattern = inner === '' && display !== '' ? denyHit(display, posix.basename(display)) : denyHit(display, inner);
    if (pattern !== undefined) {
      if (!acknowledged.has(display)) { findings.push({ path: shown(display), rule: `deny-path:${pattern}` }); return; }
      excluded.push({ path: shown(display), rule: `deny-path:${pattern}`, by: `acknowledgedDenyPaths:${display}` });
    }
    const info = await lstat(path);
    if (info.isDirectory()) await visit(path, display + '/', inner === '' ? '' : inner + '/');
    else if (info.isSymbolicLink()) {
      // The link's target path is a path the worker can open: deny rules apply to it (relative to the link, and as written), never lifted.
      const target = await readlink(path), hit = target.startsWith('/') ? denyHit(target) : denyHit(posix.join(posix.dirname(display), target), posix.join(posix.dirname(inner), target));
      if (hit !== undefined) findings.push({ path: shown(display), rule: `deny-path:${hit}` }); else inspect(display, decodedTexts(Buffer.from(target)));
    }
    else if (info.isFile()) { const bytes = await read(path); inspect(display, decodedTexts(bytes), bytes); time(); }
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
        inspect(label, decodedTexts(Buffer.from(view.text)));
      }
      else if (label === '') await visit(view.source, '');
      else await entry(view.source, label, '');
    }
  }
  catch (error) { if (error instanceof Incomplete) return Object.freeze({ status: 'incomplete', limit: error.limit, observed: error.observed, bound: error.bound }); throw error; }
  const lifted = excluded.length ? { excluded: Object.freeze(excluded) } : {};
  return findings.length ? Object.freeze({ status: 'refused', findings: Object.freeze(findings), count: findings.length, ...lifted }) : Object.freeze({ status: 'clean', ...lifted });
}
