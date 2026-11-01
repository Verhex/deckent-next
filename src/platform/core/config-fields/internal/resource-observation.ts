import { persistedInteger } from '#platform/core/validate/index.js';
import { z } from 'zod';
/** Provisional policy until the collector OFF/ON pilot; all bounds are operator-configurable. */
export const RESOURCE_OBSERVATION_SETTINGS = z.strictObject({
  provisional: z.literal(true).prefault(true), enabled: z.boolean().prefault(true),
  intervalMs: persistedInteger().min(100).max(2147483647).prefault(5000),
  timeoutMs: persistedInteger().positive().max(2147483647).prefault(1000),
  maxConcurrentReads: persistedInteger().positive().max(256).prefault(2),
  maxReadBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(65536),
  maxQueueEntries: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(64),
  maxStoreBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(4194304),
  maxStoreEntries: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(2048),
  segmentMaxBytes: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(65536),
  segmentMaxEntries: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(64),
  segmentMaxAgeMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(60000),
  syncIntervalMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(15000),
  retentionMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(86400000),
  staleMs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(15000),
  fileName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).prefault('resource-trace.json'),
  recommendation: z.strictObject({ axis: z.enum(['cpu-seconds', 'wall-ms', 'api-usd-nanos', 'subscription-ms']).prefault('cpu-seconds'), maxCandidates: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(8), minPairs: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(30), confidence: z.number().positive().lt(1).prefault(0.99),
    maxLossRisk: z.number().positive().lt(1).prefault(0.01), maxEvidenceEntries: persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).prefault(2048) }).prefault({}),
}).prefault({});
export type ResourceObservationSettings = z.output<typeof RESOURCE_OBSERVATION_SETTINGS>;
