import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { CodedError, DECKENT_VERSION, digestText, EMPTY_KNOWN_SECRETS, pathsShareTree, readJsonFile, redactForRecord, REDACTION_CONFIG_SECRET, writeTextAtomic } from '#platform/index.js';
import { classifyDependencyBinary, dependencyNativeRefusal, DependencyTreePatternCache, type DependencyHit, workerTreeDenyForms, type DependencyTreeStatistics, type WorkerTreeExclusion, type WorkerTreeFinding, type WorkerTreeLimit, type WorkerTreeScan, type PackageKnownSecrets } from '#engine/index.js';
import { archiveKind, configSecretHit, contentRule, decodedTexts, matchingContentRules, withoutNul, WORKER_TREE_PATTERN_RULES } from './content.js';
import { createHash } from 'node:crypto';
import { createGlobMatcher, createRegexRunner, CREDENTIAL_WORKSPACE_DENY, RegexCancelled } from '#adapters/core/workspace-read/index.js';

/** Bounds and the operator acknowledgement (`execution.secretGate`); every bound fails closed as an incomplete scan. `cacheDirectory`: product data keeping declared dependency trees' pattern results; `checkoutRoot`: the work-target checkout (a bind sharing its tree, or the workspace's, never takes the dependency class). */
export interface WorkerTreeGateOptions {
  readonly allowPatternPaths: readonly string[]; readonly acknowledgedDenyPaths: readonly string[];
  readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly timeoutMs: number; readonly cacheDirectory?: string; readonly checkoutRoot?: string;
}
export type WorkerTreeKnownSecrets = PackageKnownSecrets;
/** S6: the deny paths the gate refuses are the terminal's credential floor (`CREDENTIAL_WORKSPACE_DENY`) — the same list, never a copy. */
export const WORKER_TREE_DENY: readonly string[] = CREDENTIAL_WORKSPACE_DENY;
export { WORKER_TREE_PATTERN_RULES } from './content.js';
/** Owner 2026-11-05 (R9n): the deny rule (`deny-path:<glob>`) a repository-relative path meets in any normalized form, or null. */
export function workerTreeDenied(path: string): string | null {
  const forms = workerTreeDenyForms(path), hit = DENIED.find(entry => forms.some(form => entry.match(form)));
  return hit === undefined ? null : `deny-path:${hit.pattern}`;
}
const DENIED = WORKER_TREE_DENY.map(pattern => ({ pattern, match: createGlobMatcher(pattern.toLowerCase()) }));
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** The clone's object store (history) and its index (the tree's own paths again) are the only entries not read; see the S6 report. */
const UNREAD_GIT_ENTRIES: ReadonlySet<string> = new Set(['.git/objects', '.git/index']);

/**
 * One thing the worker receives, named as the worker sees it: the checkout (`label` ''), a profile read-only bind or a mounted task/handoff
 * input (`label` its container target), or text delivered in the prompt (`text`, e.g. the dependency context). Every view is scanned.
 */
type SealedEntry = Readonly<{ path: string; kind: 'directory' | 'file' | 'link'; digest: string | null; rules?: readonly string[] }>;
type SealedPatterns = Readonly<{ entries: readonly SealedEntry[]; collect?: (path: string, rules: readonly string[]) => void; selectedSource?: boolean }>;
export type WorkerTreeView = Readonly<{ source: string; label: string; dependencyTree?: Readonly<{ lockfile: string }>; sealedPaths?: readonly string[]; sealedPatterns?: SealedPatterns }> | Readonly<{ text: string; label: string }>;
/** Everything `executeConfiguredTask` hands to a worker besides its own profile: the one list the gate scans (S6 sibling-path parity). Only a profile bind declared `dependencyTree` is the dependency class. */
export function workerTreeViews(workspace: string, readOnlyMounts: readonly Readonly<{ source: string; target: string; dependencyTree?: Readonly<{ lockfile: string }> }>[] | undefined, start: Readonly<{
  inputs: readonly Readonly<{ name: string; path: string }>[]; handoffInputs: readonly Readonly<{ target: string; path: string }>[];
  dependencyContext?: Readonly<{ text: string }> }>, argv: readonly string[] = []): readonly WorkerTreeView[] {
  return Object.freeze([{ source: workspace, label: '' }, ...(readOnlyMounts ?? []).map(mount => ({ source: mount.source, label: mount.target, ...(mount.dependencyTree ? { dependencyTree: mount.dependencyTree } : {}) })),
    ...start.inputs.map(input => ({ source: input.path, label: `/deckent/inputs/${input.name}` })), ...start.handoffInputs.map(input => ({ source: input.path, label: input.target })),
    ...(start.dependencyContext ? [{ text: start.dependencyContext.text, label: 'prompt:dependency-context' }] : []),
    ...(argv.length ? [{ text: argv.join('\n'), label: 'argv' }] : [])]);
}

class Incomplete extends CodedError { constructor(readonly limit: WorkerTreeLimit, readonly observed: number, readonly bound: number) { super('WORKER_TREE_SCAN_INCOMPLETE', { message: limit }); } }

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
 * - files, single-file bytes, total bytes and time are bounded and return `incomplete`, never a partial `clean`; a bind declared `dependencyTree`: see `DependencyTreePatternCache`.
 * Shown paths have control characters escaped and pass the record redactor with the configured values, so no path carries a value.
 */
export async function scanWorkerTree(input: string | readonly WorkerTreeView[], options: WorkerTreeGateOptions, known: WorkerTreeKnownSecrets = EMPTY_KNOWN_SECRETS,
  now: () => number = Date.now): Promise<WorkerTreeScan> {
  const deny = WORKER_TREE_DENY.map(pattern => ({ pattern, match: createGlobMatcher(pattern.toLowerCase()) }));
  const allowed = options.allowPatternPaths.map(glob => ({ by: `allowPatternPaths:${glob}`, match: createGlobMatcher(glob) })), acknowledged = new Set(options.acknowledgedDenyPaths);
  const findings: WorkerTreeFinding[] = [], excluded: WorkerTreeExclusion[] = [], started = now(), deadline = started + options.timeoutMs;
  let files = 0, total = 0, tree: DependencyTreePatternCache | undefined, sealed: Set<string> | undefined; const trees: DependencyTreeStatistics[] = [];
  let patterns: SealedPatterns | undefined, approved = new Map<string, SealedEntry>();
  const changed = () => new CodedError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
  const denyHit = (...paths: readonly string[]) => { const forms = paths.flatMap(workerTreeDenyForms); return deny.find(entry => forms.some(form => entry.match(form)))?.pattern; };
  const shown = (rel: string) => redactForRecord(rel.replace(/\p{Cc}/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`), known);
  const time = () => { if (now() >= deadline) throw new Incomplete('time', now() - started, options.timeoutMs); };
  const knownHit = (texts: readonly string[], bytes?: Buffer) =>
    (sealed && known.matchesPackageValue?.(texts, bytes, time)) || texts.some(text => known.spans(text).length);
  /** `checks`: the gate's own readers for a dependency-tree file (engine `DependencyTextChecks`). `read`: bounds before work (size, total on the open file); above `maxFileBytes` (dependency class only) never allocated whole: classified in bounded windows (hits, null = unscannable). */
  const checks = (rel: string) => ({ decode: decodedTexts, dropped: withoutNul, archive: archiveKind, known, rows: WORKER_TREE_PATTERN_RULES, match: (source: string, flags: string, texts: readonly string[]) => runner.match(source, flags, texts), first: (texts: readonly string[]) => contentRule(runner, rel, texts) });
  const read = async (path: string): Promise<Buffer | readonly DependencyHit[] | null> => {
    const handle = await open(path, FILE_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('WORKER_TREE_ENTRY_CHANGED');
      if (info.size > options.maxFileBytes && !tree) throw new Incomplete('file-bytes', info.size, options.maxFileBytes);
      if ((total += info.size) > options.maxTotalBytes) throw new Incomplete('total-bytes', total, options.maxTotalBytes);
      const bytes = info.size > options.maxFileBytes ? null : Buffer.alloc(info.size); let offset = 0;
      while (bytes && offset < bytes.length) { const chunk = await handle.read(bytes, offset, bytes.length - offset, offset); if (!chunk.bytesRead) break; offset += chunk.bytesRead; }
      const classified = bytes ? null : await classifyDependencyBinary({ size: info.size, read: async (at, length) => { const chunk = await handle.read(Buffer.alloc(length), 0, length, at); return chunk.buffer.subarray(0, chunk.bytesRead); } }, checks(path), time);
      const after = await handle.stat();
      // A file that grew, shrank or changed while it was read is never passed on a partial view.
      if ((bytes && offset !== info.size) || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('WORKER_TREE_ENTRY_CHANGED');
      return bytes ?? classified;
    } finally { await handle.close(); }
  };
  /** A liftable hit: refused, or an audited exclusion in a declared dependency tree (`lifting`; text patterns and classified binaries only) or under an operator glob. */
  const liftable = (rel: string, rule: string, lifting: string | null | undefined = tree?.by) => {
    const by = sealed ? undefined : lifting ?? allowed.find(entry => entry.match(rel))?.by;
    if (by) excluded.push({ path: shown(rel), rule, by }); else findings.push({ path: shown(rel), rule });
  };
  // Pattern rows run in a terminable worker bound to the scan deadline: a backtracking expression ends the scan as `incomplete` (time).
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - now())), runner = createRegexRunner(deadlineSignal);
  // The regex worker is unref'd; a one-shot process (CLI execute) must not exit while the gate waits for it, so the scan holds a ref'd timer.
  const keepAlive = setInterval(() => undefined, options.timeoutMs);
  const inspect = async (rel: string, texts: readonly string[], bytes?: Buffer, row?: SealedEntry) => {
    if (knownHit(texts, bytes)) { findings.push({ path: shown(rel), rule: 'known-secret' }); return; }
    const refused = tree && bytes ? await dependencyNativeRefusal(bytes, texts, checks(rel)) : null; if (refused !== null) { findings.push({ path: shown(rel), rule: refused }); return; }
    // An archive is a finding only an operator glob lifts, decided before (never by) a pattern result or the dependency cache (Astra 2626 F1).
    const archive = bytes ? archiveKind(bytes) : null; if (archive !== null) { liftable(rel, `unscannable:archive-${archive}`, null); return; }
    if (row && patterns) {
      const rules = (await matchingContentRules(runner, rel, texts)).map(rule => `pattern:${rule}`);
      if (patterns.collect) patterns.collect(row.path, rules);
      else if (JSON.stringify(rules) !== JSON.stringify(row.rules)) {
        for (const rule of new Set([...rules, ...(row.rules ?? [])])) findings.push({ path: shown(rel), rule });
        if (!rules.length && !row.rules?.length) throw changed();
      }
      return;
    }
    const rule = tree && bytes ? await tree.rule(rel, bytes, () => contentRule(runner, rel, texts)) : await contentRule(runner, rel, texts); if (rule !== null) liftable(rel, `pattern:${rule}`);
  };
  const checkBytes = (row: SealedEntry | undefined, kind: SealedEntry['kind'], bytes: Buffer | null) => {
    if (row && (row.kind !== kind || row.digest !== (bytes && createHash('sha256').update(bytes).digest('hex')))) throw changed();
  };
  /** `display` is the path as the worker sees it, without a leading slash (the checkout's own paths are unchanged); rules match on it. */
  const entry = async (path: string, display: string, inner: string): Promise<void> => {
    if (sealed) {
      if (inner !== '' && patterns?.collect && patterns.selectedSource && !sealed.has(inner)) return;
      if (inner !== '' && !sealed.delete(inner)) throw new CodedError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
    } else if (UNREAD_GIT_ENTRIES.has(inner)) return;
    if (++files > options.maxFiles) throw new Incomplete('files', files, options.maxFiles);
    time();
    if (sealed) {
      const texts = decodedTexts(Buffer.from(display));
      const rule = knownHit(texts) ? 'known-secret' : await contentRule(runner, display, texts, false);
      if (rule !== null || texts.some(configSecretHit) || shown(display) !== display || /[\p{Cc}\p{Cf}]/u.test(display)) { findings.push({ path: `sha256:${digestText(display)}`, rule: rule === 'known-secret' ? rule : rule ? `pattern:${rule}` : 'unsafe-path' }); return; }
    }
    const pattern = inner === '' && display !== '' ? denyHit(display, posix.basename(display)) : denyHit(display, inner);
    if (pattern !== undefined) {
      if (sealed || !acknowledged.has(display)) { findings.push({ path: shown(display), rule: `deny-path:${pattern}` }); return; }
      excluded.push({ path: shown(display), rule: `deny-path:${pattern}`, by: `acknowledgedDenyPaths:${display}` });
    }
    const info = await lstat(path), row = approved.get(inner);
    if (info.isDirectory()) { checkBytes(row, 'directory', null); await visit(path, display + '/', inner === '' ? '' : inner + '/'); }
    else if (info.isSymbolicLink()) {
      // The link's target path is a path the worker can open: deny rules also apply after resolution relative to the link.
      const target = await readlink(path), hit = target.startsWith('/') ? denyHit(target) : denyHit(posix.join(posix.dirname(display), target), posix.join(posix.dirname(inner), target));
      const bytes = Buffer.from(target);
      if (sealed) { if (bytes.length > options.maxFileBytes) throw new Incomplete('file-bytes', bytes.length, options.maxFileBytes);
        if ((total += bytes.length) > options.maxTotalBytes) throw new Incomplete('total-bytes', total, options.maxTotalBytes); }
      const texts = decodedTexts(bytes);
      checkBytes(row, 'link', bytes);
      if (hit !== undefined) findings.push({ path: shown(display), rule: `deny-path:${hit}` });
      else if (sealed && known.matchesPackageValue?.(texts, bytes, time)) findings.push({ path: shown(display), rule: 'known-secret' });
      else await inspect(display, texts, undefined, row);
    }
    else if (info.isFile()) { const bytes = await read(path); if (bytes === null) throw new Incomplete('file-bytes', info.size, options.maxFileBytes);
      if (Buffer.isBuffer(bytes)) { checkBytes(row, 'file', bytes); await inspect(display, decodedTexts(bytes), bytes, row); }
      else for (const hit of bytes) if (hit.refuse) findings.push({ path: shown(display), rule: hit.rule }); else liftable(display, hit.rule); time(); }
    else findings.push({ path: shown(display), rule: 'unscannable:special-file' });
  };
  const visit = async (directory: string, prefix: string, innerPrefix = prefix): Promise<void> => {
    const names = (await readdir(directory)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    for (const name of names) await entry(join(directory, name), prefix + name, innerPrefix + name);
  };
  const views: readonly WorkerTreeView[] = typeof input === 'string' ? [{ source: input, label: '' }] : input;
  try {
    const roots = [...views.flatMap(view => 'source' in view && view.label === '' ? [view.source] : []), ...(options.checkoutRoot ? [options.checkoutRoot] : [])];
    for (const view of views) {
      const label = view.label === '' ? '' : posix.normalize(view.label).replace(/^(?:\.?\/)+/u, '').replace(/\/+$/u, '');
      patterns = 'source' in view ? view.sealedPatterns : undefined;
      approved = new Map(patterns?.entries.map(row => [row.path, row]));
      const expected = patterns?.entries.map(row => row.path) ?? ('source' in view ? view.sealedPaths : undefined);
      sealed = expected ? new Set(expected) : undefined;
      if (sealed?.size !== expected?.length) throw new CodedError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
      const file = 'source' in view && options.cacheDirectory !== undefined ? join(options.cacheDirectory, DependencyTreePatternCache.fileName(view.source, view.label)) : null;
      tree = !sealed && 'source' in view && view.dependencyTree && label !== '' && !(await Promise.all(roots.map(root => pathsShareTree(root, view.source)))).includes(true) ? await DependencyTreePatternCache.open({ label: view.label, rules: [DECKENT_VERSION, WORKER_TREE_PATTERN_RULES, REDACTION_CONFIG_SECRET],
        lockfile: await read(join(view.source, view.dependencyTree.lockfile)).then(lock => Buffer.isBuffer(lock) ? lock : null, () => null), store: file === null ? null : { read: () => readJsonFile(file), write: text => writeTextAtomic(file, text) } }) : undefined;
      if ('text' in view) {
        const bytes = Buffer.byteLength(view.text); time();
        if (bytes > options.maxFileBytes) throw new Incomplete('file-bytes', bytes, options.maxFileBytes);
        if ((total += bytes) > options.maxTotalBytes) throw new Incomplete('total-bytes', total, options.maxTotalBytes);
        await inspect(label, decodedTexts(Buffer.from(view.text)));
      }
      else if (label === '') await visit(view.source, '');
      else await entry(view.source, label, '');
      if (sealed?.size && !findings.length) throw new CodedError('NATIVE_WORKER_DEPENDENCIES_REFUSED');
      if (tree) trees.push(await tree.save());
    }
  }
  catch (error) {
    if (error instanceof RegexCancelled && deadlineSignal.aborted) return Object.freeze({ status: 'incomplete', limit: 'time', observed: now() - started, bound: options.timeoutMs });
    if (error instanceof Incomplete) return Object.freeze({ status: 'incomplete', limit: error.limit, observed: error.observed, bound: error.bound });
    throw error;
  } finally { clearInterval(keepAlive); await runner.close(); }
  const lifted = { ...(excluded.length ? { excluded: Object.freeze(excluded) } : {}), ...(trees.length ? { dependencyTrees: Object.freeze(trees) } : {}) };
  return findings.length ? Object.freeze({ status: 'refused', findings: Object.freeze(findings), count: findings.length, ...lifted }) : Object.freeze({ status: 'clean', ...lifted });
}
