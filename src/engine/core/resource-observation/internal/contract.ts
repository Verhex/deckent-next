import { persistedInteger, identitySchema, attemptIdentitySchema, sameAttemptIdentity, type AttemptIdentity, type WorkerIncarnation } from '#domain/index.js';
import { z } from 'zod';
import { workerIncarnationSchema, type SandboxRequest, type ExecutionSupervisor } from '#engine/core/supervisor/index.js';
import type { ResourceObservationSettings } from '#platform/index.js';
const measured = z.number().finite().nonnegative();
const incarnation = z.union([workerIncarnationSchema, z.strictObject({ kind: z.literal('process'), pid: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  startedAt: z.string().min(1).max(128) }).readonly()]);
export const resourceGapSchema = z.enum(['starting', 'unsupported', 'denied', 'timeout', 'identity', 'invalid', 'overload', 'store-unavailable', 'queue-full', 'disabled', 'missing', 'counter-reset']);
export type ResourceGap = z.infer<typeof resourceGapSchema>;
export const resourceSampleSchema = z.strictObject({ schemaVersion: z.literal(1), identity: attemptIdentitySchema,
  worker: incarnation.nullable(), observedAtMs: persistedInteger().nonnegative().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  cpuSeconds: measured.nullable(), cpuCores: measured.nullable(), memoryBytes: measured.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  memoryLimitBytes: measured.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(), kernelPeakBytes: measured.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  gap: resourceGapSchema.nullable(), source: identitySchema,
}).readonly();
export type ResourceSample = z.infer<typeof resourceSampleSchema>;
export interface ResourceTrace { readonly samples: readonly ResourceSample[]; readonly trimmedBeforeMs: number | null }
export interface ResourceTraceStore {
  append(sample: ResourceSample, signal?: AbortSignal): Promise<void>;
  read(identity: AttemptIdentity): Promise<ResourceTrace>;
}
export interface ResourceReader {
  readResources(request: SandboxRequest, expected: WorkerIncarnation | null, settings: ResourceObservationSettings, signal: AbortSignal): Promise<ResourceSample>;
}
export interface ResourceExecutionObserver { start(request: SandboxRequest, supervisor: ExecutionSupervisor): { stop(): void } }
export interface ResourceView {
  readonly schemaVersion: 1; readonly state: 'fresh' | 'stale' | 'gap' | 'unavailable' | 'disabled';
  readonly coverage: 'partial'; readonly provisional: true; readonly ageMs: number | null;
  readonly latest: ResourceSample | null; readonly sampleCount: number; readonly gapCount: number;
  readonly cpuSeconds: number | null; readonly sampledPeakBytes: number | null; readonly trimmedBeforeMs: number | null;
  readonly reason: ResourceGap | null;
}
export function resourceGap(identity: AttemptIdentity, now: number, reason: ResourceGap, worker: WorkerIncarnation | null = null): ResourceSample {
  return resourceSampleSchema.parse({ schemaVersion: 1, identity, worker, observedAtMs: now, source: 'unknown',
    cpuSeconds: null, cpuCores: null, memoryBytes: null, memoryLimitBytes: null, kernelPeakBytes: null, gap: reason });
}
export function sameResourceWorker(a: WorkerIncarnation | null, b: WorkerIncarnation | null): boolean {
  return !!a && !!b && a.startedAt === b.startedAt && ((a.kind === 'container' && b.kind === 'container' && a.id === b.id)
    || (a.kind === 'process' && b.kind === 'process' && a.pid === b.pid));
}
export function validateResourceSample(input: unknown, identity: AttemptIdentity, expected: WorkerIncarnation | null): ResourceSample {
  const sample = resourceSampleSchema.parse(input);
  if (!sameAttemptIdentity(sample.identity, identity) || (expected && !sameResourceWorker(sample.worker, expected))) throw new Error('RESOURCE_IDENTITY');
  if (!sample.gap && !sample.worker) throw new Error('RESOURCE_IDENTITY');
  return sample;
}
