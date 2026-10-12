import { constants } from 'node:fs';
import { open, realpath, rename, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { resourceSampleSchema, type ResourceSample, type ResourceTraceStore } from '#engine/index.js';
import { RESOURCE_OBSERVATION_SETTINGS, withConfigWriteLock, type ResourceObservationSettings } from '#platform/index.js';
const traceSchema = z.object({ schemaVersion: z.literal(1), trimmedBeforeMs: z.number().int().nonnegative().safe().nullable(),
  lastTrim: z.object({ identity: attemptIdentitySchema, throughMs: z.number().int().nonnegative().safe() }).strict().nullable().optional(),
  samples: z.array(resourceSampleSchema) }).strict();
/** One bounded asynchronous file, independent of the Run ledger. Atomic replacement and the
 * shared path lock serialize all processes; readers never create storage or reclaim locks. */
export class FileResourceTraceStore implements ResourceTraceStore {
  constructor(private readonly directory: () => Promise<string>, private readonly settings: ResourceObservationSettings, private readonly now = Date.now) { this.settings = RESOURCE_OBSERVATION_SETTINGS.parse(settings); }
  private async withPath<T>(work: (path: string) => Promise<T>): Promise<T> {
    if (process.platform !== 'linux' || constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined || !process.getuid) throw new Error('RESOURCE_TRACE_UNSUPPORTED');
    const root = await this.directory(), stat = await lstat(root);
    if (resolve(root) !== root || await realpath(root) !== root || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & (constants.S_IRWXG | constants.S_IRWXO))) throw new Error('RESOURCE_TRACE_UNSAFE');
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { const pinned = await handle.stat();
      if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) throw new Error('RESOURCE_TRACE_CHANGED');
      return await work(join(`/proc/self/fd/${handle.fd}`, this.settings.fileName));
    } finally { await handle.close(); }
  }
  private async load(path: string) {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1 as const, samples: [] as ResourceSample[], trimmedBeforeMs: null, lastTrim: null }; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & (constants.S_IRWXG | constants.S_IRWXO)) || stat.size > this.settings.maxStoreBytes) throw new Error('RESOURCE_TRACE_UNSAFE');
      const bytes = Buffer.alloc(stat.size + 1); const read = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
      if (read.bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('RESOURCE_TRACE_CHANGED');
      const parsed = traceSchema.parse(JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')));
      if (parsed.samples.length > this.settings.maxStoreEntries) throw new Error('RESOURCE_TRACE_TOO_LARGE'); return parsed;
    } finally { await file.close(); }
  }
  async read(identity: AttemptIdentity) {
    return this.withPath(async path => { const trace = await this.load(path);
      return { samples: trace.samples.filter(row => sameAttemptIdentity(row.identity, identity)),
        trimmedBeforeMs: trace.lastTrim && sameAttemptIdentity(trace.lastTrim.identity, identity) ? trace.lastTrim.throughMs : null }; });
  }
  async append(input: ResourceSample): Promise<void> {
    const sample = resourceSampleSchema.parse(input);
    await this.withPath(path => withConfigWriteLock(path, async () => {
      const trace = await this.load(path), threshold = this.now() - this.settings.retentionMs;
      const key = JSON.stringify(sample);
      if (trace.samples.some(row => JSON.stringify(row) === key)) return;
      const samples = [...trace.samples, sample].sort((a, b) => a.observedAtMs - b.observedAtMs);
      let trimmedBeforeMs = trace.trimmedBeforeMs;
      let lastTrim = trace.lastTrim ?? null;
      const trim = () => { const removed = samples.shift()!; trimmedBeforeMs = Math.max(trimmedBeforeMs ?? 0, removed.observedAtMs);
        lastTrim = { identity: removed.identity, throughMs: removed.observedAtMs }; };
      while (samples.length && (samples[0]!.observedAtMs < threshold || samples.length > this.settings.maxStoreEntries)) trim();
      const content = () => JSON.stringify({ schemaVersion: 1, trimmedBeforeMs, lastTrim, samples });
      while (samples.length && Buffer.byteLength(content()) > this.settings.maxStoreBytes) trim();
      if (!samples.includes(sample) || Buffer.byteLength(content()) > this.settings.maxStoreBytes) throw new Error('RESOURCE_TRACE_FULL');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(content()); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    }, this.settings.timeoutMs, { onWarning() { /* Trace locks never print into the worker result. */ } }));
  }
}
