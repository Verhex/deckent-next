import { constants } from 'node:fs';
import { open, realpath, unlink, lstat, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { resourceSampleSchema, resourceGap, type ResourceSample, type ResourceTraceStore } from '#engine/index.js';
import { RESOURCE_OBSERVATION_SETTINGS, withConfigWriteLock, type ResourceObservationSettings } from '#platform/index.js';
import { segments, privateFile, checkpoint, checkpointContent, publishTrim, header, type Segment } from './files.js';
/** Append-only bounded segments outside the acceptance ledger. One cross-process writer;
 * readers neither create files nor acquire/reclaim a writer lock. Legacy v1 stays read-only. */
export class FileResourceTraceStore implements ResourceTraceStore {
  private synced: { path: string; at: number } | null = null;
  constructor(private readonly directory: () => Promise<string>, private readonly settings: ResourceObservationSettings, private readonly now = Date.now) { this.settings = RESOURCE_OBSERVATION_SETTINGS.parse(settings); }
  private async withPath<T>(work: (path: string, directory: FileHandle) => Promise<T>): Promise<T> {
    if (process.platform !== 'linux' || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined || !process.getuid) throw new Error('RESOURCE_TRACE_UNSUPPORTED');
    const root = await this.directory(), stat = await lstat(root);
    if (resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & (constants.S_IRWXG | constants.S_IRWXO))) throw new Error('RESOURCE_TRACE_UNSAFE');
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { const pinned = await handle.stat();
      if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) throw new Error('RESOURCE_TRACE_CHANGED');
      return await work(join(`/proc/self/fd/${handle.fd}`, this.settings.fileName), handle);
    } finally { await handle.close(); }
  }
  async read(identity: AttemptIdentity) { return (await this.readMany([identity]))[0]!; }
  /** One pass over the segments for many attempts (one monitor snapshot reads each segment once, not once per attempt); each result is
   * exactly what `read` returns for that identity. */
  async readMany(identities: readonly AttemptIdentity[]) {
    return this.withPath(async path => {
      const rows = await segments(path, this.settings), trim = await checkpoint(path, this.settings.maxStoreBytes);
      const lastTrim = trim.lastTrim ?? rows.find(row => row.legacy)?.lastTrim ?? null, key = (value: AttemptIdentity) => JSON.stringify([value.scopeId, value.runId,
        value.taskId, value.attemptId, value.layoutRevision, value.generation]), byIdentity = new Map<string, ResourceSample[]>();
      for (const sample of rows.flatMap(row => row.samples)) { const id = key(sample.identity), list = byIdentity.get(id); if (list) list.push(sample); else byIdentity.set(id, [sample]); }
      return identities.map(identity => {
        const samples = [...byIdentity.get(key(identity)) ?? []];
        for (const row of rows.filter(row => row.damaged && (!row.samples.length || row.samples.some(value => sameAttemptIdentity(value.identity, identity))))) {
          // Tail identity/time are untrusted. Explicit unknown measurement, never a zero counter.
          samples.push(resourceGap(identity, row.samples.reduce((at, sample) => Math.max(at, sample.observedAtMs), row.createdAtMs), 'invalid'));
        }
        return { samples: [...new Map(samples.map(row => [JSON.stringify(row), row])).values()].sort((a, b) => a.observedAtMs - b.observedAtMs),
          trimmedBeforeMs: lastTrim && sameAttemptIdentity(lastTrim.identity, identity) ? lastTrim.throughMs : null };
      });
    });
  }
  private async syncSegment(row: Segment) {
    const file = await privateFile(row.path, true);
    try { const stat = await file.stat();
      if (stat.dev !== row.dev || stat.ino !== row.ino || stat.size !== row.bytes) throw new Error('RESOURCE_TRACE_CHANGED');
      await file.sync();
    } finally { await file.close(); }
  }
  async append(input: ResourceSample, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); const sample = resourceSampleSchema.parse(input);
    await this.withPath((path, directory) => withConfigWriteLock(path, async () => {
      signal?.throwIfAborted();
      const rows = await segments(path, this.settings), trim = await checkpoint(path, this.settings.maxStoreBytes);
      const key = JSON.stringify(sample);
      if (rows.some(row => row.samples.some(value => JSON.stringify(value) === key))) return;
      const now = this.now(), line = key + '\n', start = header(now), lineBytes = Buffer.byteLength(line), startBytes = Buffer.byteLength(start);
      if (lineBytes + startBytes > Math.min(this.settings.maxStoreBytes, this.settings.segmentMaxBytes)) throw new Error('RESOURCE_TRACE_FULL');
      if (sample.observedAtMs < now - this.settings.retentionMs) throw new Error('RESOURCE_TRACE_FULL');
      let active = rows.at(-1);
      if (active && (active.legacy || active.damaged || active.bytes + lineBytes > this.settings.segmentMaxBytes
        || active.samples.length >= this.settings.segmentMaxEntries || now < active.createdAtMs || now - active.createdAtMs >= this.settings.segmentMaxAgeMs)) {
        if (!active.legacy) await this.syncSegment(active);
        active = undefined;
      }
      let lastTrim = trim.lastTrim ?? rows.find(row => row.legacy)?.lastTrim ?? null;
      let totalBytes = rows.reduce((sum, row) => sum + row.bytes, trim.bytes), entries = rows.reduce((sum, row) => sum + row.samples.length, 0);
      const removed: Segment[] = [];
      while (rows.length && (rows.some(row => row.samples.some(value => value.observedAtMs < now - this.settings.retentionMs))
        || entries + 1 > this.settings.maxStoreEntries || rows.length + (active ? 0 : 1) > this.settings.maxStoreEntries + 1
        || totalBytes + lineBytes + (active ? 0 : startBytes) > this.settings.maxStoreBytes)) {
        const oldest = rows.shift()!; removed.push(oldest); entries -= oldest.samples.length;
        if (oldest === active) active = undefined;
        for (const value of [...oldest.samples].sort((a, b) => a.observedAtMs - b.observedAtMs)) lastTrim = { identity: value.identity, throughMs: value.observedAtMs };
        // Checkpoint has constant bounded structure, independent of retained trace size.
        totalBytes = rows.reduce((sum, row) => sum + row.bytes, Buffer.byteLength(checkpointContent(lastTrim)));
      }
      const content = checkpointContent(lastTrim);
      if (totalBytes + lineBytes + (active ? 0 : startBytes) > this.settings.maxStoreBytes) throw new Error('RESOURCE_TRACE_FULL');
      if (removed.length) {
        signal?.throwIfAborted(); await publishTrim(path, content, directory);
        for (const row of removed) {
          signal?.throwIfAborted(); const stat = await lstat(row.path);
          if (stat.dev !== row.dev || stat.ino !== row.ino || stat.nlink !== 1 || !stat.isFile()) throw new Error('RESOURCE_TRACE_CHANGED');
          await unlink(row.path);
        }
      }
      signal?.throwIfAborted();
      const next = (BigInt(rows.at(-1)?.name.slice(`${this.settings.fileName}.segment-`.length, `${this.settings.fileName}.segment-`.length + 16) || '0') + 1n).toString().padStart(16, '0');
      if (next.length !== 16) throw new Error('RESOURCE_TRACE_FULL');
      const target = active?.path ?? `${path}.segment-${next}-${randomUUID()}.jsonl`;
      const file = active ? await privateFile(target, true) : await open(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        if (active) { const stat = await file.stat();
          if (stat.dev !== active.dev || stat.ino !== active.ino || stat.size !== active.bytes) throw new Error('RESOURCE_TRACE_CHANGED'); }
        signal?.throwIfAborted(); await file.writeFile(active ? line : start + line);
        // No timer/stop flush. A write checks elapsed time; new instances conservatively sync once.
        if (!active || this.synced?.path !== target || now - this.synced.at >= this.settings.syncIntervalMs || now < this.synced.at) {
          await file.sync(); this.synced = { path: target, at: now };
          if (!active) await directory.sync();
        }
      } finally { await file.close(); }
    }, this.settings.timeoutMs, { ...(signal ? { signal } : {}), onWarning() { /* Trace locks never print into the worker result. */ } }));
  }
}
