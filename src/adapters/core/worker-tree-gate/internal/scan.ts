import GATE from './gate.json' with { type: 'json' };
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
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
/** Git's own heuristic: a NUL byte in the first 8000 bytes marks a binary file, whose content is not pattern-scanned (its path still is). */
const BINARY_PROBE_BYTES = GATE.binaryProbeBytes;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

class Incomplete extends Error { constructor(readonly limit: WorkerTreeLimit, readonly observed: number, readonly bound: number) { super(limit); } }
/** A path as the person and the audit see it: control characters escaped, and a credential-shaped name redacted like any record text. */
const shownPath = (rel: string) => redactForRecord(rel.replace(/\p{Cc}/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));

/**
 * The pre-dispatch scan of the exact tree a worker would receive (the prepared checkout, predecessor patches applied), excluding only the
 * clone's top-level `.git` (history is out of scope, see the S6 report). Refused: a deny-listed path (files and directories, never read;
 * an exact `acknowledgedDenyPaths` entry is read and scanned like any file),
 * a configured secret value anywhere in a text file, or a `gate` pattern outside `allowPatternPaths`. Symlinks are path-checked, never
 * followed. Files, single-file bytes, total bytes and time are bounded; an exhausted bound returns `incomplete`, never a partial `clean`.
 */
export async function scanWorkerTree(root: string, options: WorkerTreeGateOptions, known: KnownSecretSnapshot = EMPTY_KNOWN_SECRETS,
  now: () => number = Date.now): Promise<WorkerTreeScan> {
  const deny = WORKER_TREE_DENY.map(pattern => ({ pattern, match: createGlobMatcher(pattern) }));
  const allowed = options.allowPatternPaths.map(createGlobMatcher), rules = WORKER_TREE_PATTERN_RULES.map(row => ({ id: row.id, expression: new RegExp(row.source, row.flags.replace('g', '')) }));
  const findings: WorkerTreeFinding[] = [], started = now(), deadline = started + options.timeoutMs;
  let files = 0, total = 0;
  const acknowledged = new Set(options.acknowledgedDenyPaths), denied = (rel: string) => acknowledged.has(rel) ? undefined : deny.find(entry => entry.match(rel))?.pattern;
  const content = async (path: string): Promise<string | null> => {
    const handle = await open(path, FILE_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, info.size)), head = await handle.read(probe, 0, probe.length, 0);
      if (probe.subarray(0, head.bytesRead).includes(0)) return null;
      if (info.size > options.maxFileBytes) throw new Incomplete('file-bytes', info.size, options.maxFileBytes);
      if ((total += info.size) > options.maxTotalBytes) throw new Incomplete('total-bytes', total, options.maxTotalBytes);
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      return bytes.subarray(0, offset).toString('utf8');
    } finally { await handle.close(); }
  };
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const rel = prefix + entry.name;
      if (rel === '.git') continue;
      if (++files > options.maxFiles) throw new Incomplete('files', files, options.maxFiles);
      if (now() >= deadline) throw new Incomplete('time', now() - started, options.timeoutMs);
      const pattern = denied(rel);
      if (pattern !== undefined) { findings.push({ path: shownPath(rel), rule: `deny-path:${pattern}` }); continue; }
      if (entry.isDirectory()) { await visit(join(directory, entry.name), rel + '/'); continue; }
      if (!entry.isFile()) continue;
      const text = await content(join(directory, entry.name));
      if (text === null) continue;
      if (known.spans(text).length) { findings.push({ path: shownPath(rel), rule: 'known-secret' }); continue; }
      if (allowed.some(match => match(rel))) continue;
      const rule = rules.find(row => row.expression.test(text));
      if (rule) findings.push({ path: shownPath(rel), rule: `pattern:${rule.id}` });
    }
  };
  try { await visit(root, ''); }
  catch (error) { if (error instanceof Incomplete) return Object.freeze({ status: 'incomplete', limit: error.limit, observed: error.observed, bound: error.bound }); throw error; }
  return findings.length ? Object.freeze({ status: 'refused', findings: Object.freeze(findings), count: findings.length }) : Object.freeze({ status: 'clean' });
}
