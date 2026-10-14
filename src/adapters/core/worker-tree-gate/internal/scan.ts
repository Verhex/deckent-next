import { constants } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
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

class Incomplete extends Error { constructor(readonly limit: WorkerTreeLimit, readonly observed: number, readonly bound: number) { super(limit); } }

/**
 * The pre-dispatch scan of exactly what the worker's container receives: the whole prepared checkout (predecessor patches applied),
 * including the clone's `.git` metadata (config, refs, logs), except `.git/objects` — the history the owner deferred to a later scan — and
 * `.git/index`. Fail closed throughout:
 * - a deny-listed path (case-insensitive, so `KEY.PEM` and `.ENV` match too; files and directories, never read or descended) unless an exact
 *   `acknowledgedDenyPaths` entry, which is then read and scanned like any file;
 * - every regular file's full content, binary files included (UTF-8, plus UTF-16 in both byte alignments when it holds NUL bytes), and every
 *   symlink's target text: a configured secret value anywhere, or a `gate` pattern outside `allowPatternPaths`; symlinks are never followed;
 * - an entry that is neither file, directory nor symlink (FIFO, socket, device) is refused as unscannable;
 * - files, single-file bytes, total bytes and time are bounded and return `incomplete`; any I/O error rejects (no dispatch either way).
 * Shown paths have control characters escaped and pass the record redactor with the configured values, so no path carries a value.
 */
export async function scanWorkerTree(root: string, options: WorkerTreeGateOptions, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS,
  now: () => number = Date.now): Promise<WorkerTreeScan> {
  const deny = WORKER_TREE_DENY.map(pattern => ({ pattern, match: createGlobMatcher(pattern.toLowerCase()) }));
  const allowed = options.allowPatternPaths.map(createGlobMatcher), rules = WORKER_TREE_PATTERN_RULES.map(row => ({ id: row.id, expression: new RegExp(row.source, row.flags.replace('g', '')) }));
  const findings: WorkerTreeFinding[] = [], started = now(), deadline = started + options.timeoutMs;
  let files = 0, total = 0;
  const acknowledged = new Set(options.acknowledgedDenyPaths);
  const denied = (rel: string) => acknowledged.has(rel) ? undefined : deny.find(entry => entry.match(rel.toLowerCase()))?.pattern;
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
      if (offset !== info.size) throw new Error('WORKER_TREE_ENTRY_CHANGED');
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
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const rel = prefix + entry.name, path = join(directory, entry.name);
      if (UNREAD_GIT_ENTRIES.has(rel)) continue;
      if (++files > options.maxFiles) throw new Incomplete('files', files, options.maxFiles);
      time();
      const pattern = denied(rel);
      if (pattern !== undefined) { findings.push({ path: shown(rel), rule: `deny-path:${pattern}` }); continue; }
      // A directory entry type is a hint; an unknown type (DT_UNKNOWN) is resolved without following a link.
      const info = entry.isDirectory() || entry.isFile() || entry.isSymbolicLink() ? entry : await lstat(path);
      if (info.isDirectory()) await visit(path, rel + '/');
      else if (info.isSymbolicLink()) inspect(rel, [await readlink(path)]);
      else if (info.isFile()) { inspect(rel, texts(await read(path))); time(); }
      else findings.push({ path: shown(rel), rule: 'unscannable:special-file' });
    }
  };
  try { await visit(root, ''); }
  catch (error) { if (error instanceof Incomplete) return Object.freeze({ status: 'incomplete', limit: error.limit, observed: error.observed, bound: error.bound }); throw error; }
  return findings.length ? Object.freeze({ status: 'refused', findings: Object.freeze(findings), count: findings.length }) : Object.freeze({ status: 'clean' });
}
