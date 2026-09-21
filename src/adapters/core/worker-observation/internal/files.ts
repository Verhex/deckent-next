import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { WorkerObservationError, type ObservationLimits, type WorkerSidecars } from '#engine/index.js';
import catalog from './catalog.json' with { type: 'json' };
export async function observationDirectory(path: string) {
  const stat = await lstat(path);
  if (!isAbsolute(path) || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o022) || await realpath(path) !== path) throw new WorkerObservationError('WORKER_OBSERVATION_UNAVAILABLE');
}
export async function readObservationFile(path: string, maxBytes: number, tail = false) {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('unsafe');
      if (!tail && stat.size > maxBytes) return { state: 'too-large', bytes: Buffer.alloc(0), size: stat.size, mtime: stat.mtimeMs, truncated: true };
      const bytes = Buffer.alloc(Math.min(stat.size, maxBytes));
      const read = await handle.read(bytes, 0, bytes.length, tail ? stat.size - bytes.length : 0);
      const after = await handle.stat();
      if (read.bytesRead !== bytes.length || (!tail && (stat.mtimeMs !== after.mtimeMs || stat.size !== after.size))) throw new Error('changed');
      return { state: 'available', bytes, size: stat.size, mtime: stat.mtimeMs, truncated: stat.size > bytes.length };
    } finally { await handle.close(); }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return { state: code === 'ENOENT' ? 'missing' : 'unavailable', bytes: Buffer.alloc(0), size: 0, mtime: null, truncated: false };
  }
}
function object(bytes: Buffer): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(bytes.toString('utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
export async function readWorkerSidecars(directory: string, stem: string, limits: ObservationLimits, now = Date.now(), identity?: AttemptIdentity): Promise<WorkerSidecars> {
  await observationDirectory(directory);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(stem) || stem === '.' || stem === '..') throw new WorkerObservationError('WORKER_OBSERVATION_INVALID');
  const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let captured;
  try {
    const pinned = `/proc/self/fd/${root.fd}`;
    captured = await Promise.all([readObservationFile(join(pinned, stem + '.hb'), limits.maxFileBytes),
      readObservationFile(join(pinned, stem + '.log'), limits.maxFileBytes, true), readObservationFile(join(pinned, stem + '.result'), limits.maxFileBytes)]);
  } finally { await root.close(); }
  const [hb, log, result] = captured;
  let heartbeat = object(hb.bytes); let outcome = object(result.bytes);
  const bound = (value: Record<string, unknown> | null) => {
    const parsed = attemptIdentitySchema.safeParse(value?.identity);
    return !identity || (parsed.success && sameAttemptIdentity(identity, parsed.data));
  };
  if (heartbeat && !bound(heartbeat)) { heartbeat = null; hb.state = 'identity-mismatch'; }
  if (outcome && !bound(outcome)) { outcome = null; result.state = 'identity-mismatch'; }
  const phase = heartbeat?.process ?? heartbeat?.status;
  const terminal = outcome?.terminal && typeof outcome.terminal === 'object' ? outcome.terminal as Record<string, unknown> : outcome;
  const ageMs = hb.mtime === null ? null : now - hb.mtime;
  const text = log.bytes.toString('utf8');
  const events = text.split('\n').flatMap(line => {
    const value = object(Buffer.from(line));
    if (!value || !Number.isSafeInteger(value.sequence) || typeof value.sequence !== 'number' || typeof value.observedAt !== 'number'
      || !Number.isSafeInteger(value.observedAt) || typeof value.process !== 'string' || !catalog.phases.includes(value.process)) return [];
    const terminal = value.terminal && typeof value.terminal === 'object' ? value.terminal as Record<string, unknown> : null;
    return [{ sequence: value.sequence, observedAt: value.observedAt, process: value.process,
      exitCode: typeof terminal?.exitCode === 'number' && Number.isSafeInteger(terminal.exitCode) ? terminal.exitCode : null }];
  });
  return { provider: typeof heartbeat?.provider === 'string' && ['codex', 'claude', 'cursor', 'docker'].includes(heartbeat.provider) ? heartbeat.provider : 'unknown', heartbeat: { state: hb.state === 'available' && !heartbeat ? 'malformed' : hb.state, ageMs,
    freshness: ageMs === null ? 'unknown' : ageMs < 0 ? 'future' : ageMs > limits.staleMs ? 'stale' : 'fresh',
    phase: typeof phase === 'string' && catalog.phases.includes(phase) ? phase : 'unknown' },
  log: { state: log.state, byteLength: log.size, truncated: log.truncated, sampledLines: text ? text.split('\n').filter(Boolean).length : 0,
    events, diagnostics: Object.entries(catalog.diagnostics).filter(([, pattern]) => new RegExp(pattern, 'i').test(text)).map(([key]) => key) },
  result: { state: result.state === 'available' && !outcome ? 'malformed' : result.state,
    exitCode: typeof terminal?.exitCode === 'number' && Number.isSafeInteger(terminal.exitCode) ? terminal.exitCode : null,
    reportedAssessment: typeof outcome?.selfAssessment === 'string' && catalog.assessments.includes(outcome.selfAssessment) ? outcome.selfAssessment : null },
  pid: typeof heartbeat?.pid === 'number' && Number.isSafeInteger(heartbeat.pid) && heartbeat.pid > 0 ? heartbeat.pid : null };
}
