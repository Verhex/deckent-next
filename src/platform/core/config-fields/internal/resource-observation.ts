import { z } from 'zod';
/** Provisional policy until the collector OFF/ON pilot; all bounds are operator-configurable. */
export const RESOURCE_OBSERVATION_SETTINGS = z.object({
  provisional: z.literal(true).default(true), enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(100).max(2147483647).default(5000),
  timeoutMs: z.number().int().positive().max(2147483647).default(1000),
  maxConcurrentReads: z.number().int().positive().max(256).default(2),
  maxReadBytes: z.number().int().positive().safe().default(65536),
  maxQueueEntries: z.number().int().positive().safe().default(64),
  maxStoreBytes: z.number().int().positive().safe().default(4194304),
  maxStoreEntries: z.number().int().positive().safe().default(2048),
  segmentMaxBytes: z.number().int().positive().safe().default(65536),
  segmentMaxEntries: z.number().int().positive().safe().default(64),
  segmentMaxAgeMs: z.number().int().positive().safe().default(60000),
  syncIntervalMs: z.number().int().positive().safe().default(15000),
  retentionMs: z.number().int().positive().safe().default(86400000),
  staleMs: z.number().int().positive().safe().default(15000),
  fileName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).default('resource-trace.json'),
  recommendation: z.object({ axis: z.enum(['cpu-seconds', 'wall-ms', 'api-usd-nanos', 'subscription-ms']).default('cpu-seconds'), maxCandidates: z.number().int().positive().safe().default(8), minPairs: z.number().int().positive().safe().default(30), confidence: z.number().positive().lt(1).default(0.99),
    maxLossRisk: z.number().positive().lt(1).default(0.01), maxEvidenceEntries: z.number().int().positive().safe().default(2048) }).strict().default({}),
}).strict().default({});
export type ResourceObservationSettings = z.output<typeof RESOURCE_OBSERVATION_SETTINGS>;
