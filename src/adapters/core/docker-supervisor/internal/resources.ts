import { request as httpRequest } from 'node:http';
import { open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import { resourceGap, resourceSampleSchema, sameResourceWorker, workerIncarnationSchema,
  type ResourceSample, type SandboxRequest } from '#engine/index.js';
import type { WorkerIncarnation } from '#domain/index.js';
import type { ResourceObservationSettings } from '#platform/index.js';
import { dockerEndpointSchema } from './profile.js';
const counter = z.number().int().nonnegative().safe();
const inspection = z.object({ Id: z.string(), Config: z.object({ Labels: z.record(z.string()).nullable() }),
  State: z.object({ Status: z.string(), StartedAt: z.string(), Pid: counter.optional() }) });
// Older Engine one-shot replies omit id (Moby #51302). Custody comes from the full-id request
// bracketed by matching inspections; a supplied contradictory id still refuses the sample.
const stats = z.object({ id: z.string().optional(), read: z.string(), cpu_stats: z.object({ cpu_usage: z.object({ total_usage: counter }) }),
  memory_stats: z.object({ usage: counter.optional(), limit: counter.optional(), max_usage: counter.optional() }) });
class ResourceReadError extends Error { constructor(readonly reason: ResourceSample['gap']) { super('RESOURCE_READ'); } }
/** Fixed local socket; no credentials, redirects, arbitrary paths or unbounded body. */
export function readDockerResourceJson(endpoint: string, path: string, settings: ResourceObservationSettings, signal: AbortSignal): Promise<unknown> {
  const socketPath = dockerEndpointSchema.parse(endpoint).slice('unix://'.length);
  return new Promise((resolveValue, reject) => {
    const req = httpRequest({ socketPath, path, method: 'GET', signal, agent: false }, res => {
      const chunks: Buffer[] = []; let size = 0;
      if (res.statusCode !== 200) { res.destroy(); reject(new ResourceReadError(res.statusCode === 403 || res.statusCode === 401 ? 'denied' : res.statusCode === 404 ? 'missing' : 'unsupported')); return; }
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > settings.maxReadBytes) { res.destroy(new ResourceReadError('invalid')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { resolveValue(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ResourceReadError('invalid')); } });
    });
    req.on('error', reject); req.setTimeout(settings.timeoutMs, () => req.destroy(new ResourceReadError('timeout'))); req.end();
  });
}
/** Optional local cgroup-v2 capability. The full container id must be in the pinned PID's cgroup,
 * so a Desktop VM or another namespace cannot turn a host PID into this container's peak. */
async function kernelPeak(id: string, pid: number | undefined, settings: ResourceObservationSettings): Promise<number | null> {
  if (process.platform !== 'linux' || !pid || constants.O_NOFOLLOW === undefined) return null;
  try {
    const groups = await readFile(`/proc/${pid}/cgroup`, 'utf8');
    if (Buffer.byteLength(groups) > settings.maxReadBytes) return null;
    const group = groups.split('\n').find(line => line.startsWith('0::/'))?.slice(3);
    if (!group || !group.split('/').some(part => part === id || part === `docker-${id}.scope`)) return null;
    const root = '/sys/fs/cgroup', directory = resolve(root, '.' + group);
    if (!directory.startsWith(root + sep) || await realpath(directory) !== directory) return null;
    const file = await open(resolve(directory, 'memory.peak'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const bytes = Buffer.alloc(settings.maxReadBytes); const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead === bytes.length) return null;
      const text = bytes.subarray(0, read.bytesRead).toString('utf8').trim();
      const value = /^\d+$/.test(text) ? counter.safeParse(Number(text)) : null; return value?.success ? value.data : null;
    } finally { await file.close(); }
  } catch { return null; }
}
export async function sampleDockerResources(endpoint: string, request: SandboxRequest, handle: string, digest: string,
  expected: WorkerIncarnation | null, settings: ResourceObservationSettings, signal: AbortSignal,
  read = readDockerResourceJson): Promise<ResourceSample> {
  let worker: WorkerIncarnation | null = expected;
  try {
    if (process.platform !== 'linux') return resourceGap(request.identity, Date.now(), 'unsupported', worker);
    const get = (path: string) => read(endpoint, path, settings, signal);
    if (expected?.kind === 'process') return resourceGap(request.identity, Date.now(), 'unsupported');
    const observed = inspection.parse(await get(`/containers/${expected?.id ?? handle}/json`));
    if (observed.Config.Labels?.['deckent.request'] !== digest) throw new ResourceReadError('identity');
    const pinned = workerIncarnationSchema.safeParse({ kind: 'container', id: observed.Id, startedAt: observed.State.StartedAt });
    if (!pinned.success) return resourceGap(request.identity, Date.now(), 'starting', worker);
    if (expected && !sameResourceWorker(expected, pinned.data)) throw new ResourceReadError('identity');
    worker = pinned.data;
    const data = stats.parse(await get(`/containers/${worker.id}/stats?stream=false&one-shot=true`));
    if (data.id !== undefined && data.id !== worker.id) throw new ResourceReadError('identity');
    const peak = data.memory_stats.max_usage ?? await kernelPeak(worker.id, observed.State.Pid, settings);
    const after = inspection.parse(await get(`/containers/${worker.id}/json`));
    if (after.Id !== worker.id || after.State.StartedAt !== worker.startedAt || after.Config.Labels?.['deckent.request'] !== digest) throw new ResourceReadError('identity');
    const observedAtMs = Date.parse(data.read);
    if (!Number.isFinite(observedAtMs) || observedAtMs < Date.parse(worker.startedAt)) throw new ResourceReadError('invalid');
    return resourceSampleSchema.parse({ schemaVersion: 1, identity: request.identity, worker, source: 'docker-engine', observedAtMs,
      cpuSeconds: data.cpu_stats.cpu_usage.total_usage / 1e9, cpuCores: null, memoryBytes: data.memory_stats.usage ?? null,
      memoryLimitBytes: data.memory_stats.limit ?? null, kernelPeakBytes: peak, gap: null });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return resourceGap(request.identity, Date.now(), error instanceof ResourceReadError ? error.reason! : signal.aborted ? 'timeout' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'invalid', worker);
  }
}
