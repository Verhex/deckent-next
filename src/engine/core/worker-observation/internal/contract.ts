import { z } from 'zod';
import { identitySchema, type AttemptIdentity } from '#domain/index.js';
import type { DispatchTerminal } from '#engine/core/dispatch/index.js';
export const workerObservationQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  source: identitySchema.optional(), after: identitySchema.nullable().default(null), limit: z.number().int().positive().optional() }).strict();
export type WorkerObservationQuery = z.input<typeof workerObservationQuerySchema>;
export interface ObservationLimits { readonly maxFileBytes: number; readonly maxEntries: number; readonly staleMs: number }
export type WorkerProcessState = 'running' | 'paused' | 'created' | 'exited' | 'missing' | 'unknown' | 'present-unverified' | 'absent-unverified' | 'denied';
export interface WorkerActivity {
  readonly schemaVersion: 1; readonly identity: AttemptIdentity; readonly backend: 'docker';
  readonly provider: string; readonly workspace: string; readonly observedAt: number;
  readonly process: WorkerProcessState; readonly handle: string | null;
  readonly terminal: DispatchTerminal | null; readonly outputRecorded: boolean;
}
export interface WorkerSidecars {
  readonly provider: string;
  readonly heartbeat: { readonly state: string; readonly ageMs: number | null; readonly freshness: 'fresh' | 'stale' | 'future' | 'unknown'; readonly phase: string };
  readonly log: { readonly state: string; readonly byteLength: number; readonly truncated: boolean; readonly sampledLines: number; readonly diagnostics: readonly string[]; readonly events: readonly { readonly sequence: number; readonly observedAt: number; readonly process: string; readonly exitCode: number | null }[] };
  readonly result: { readonly state: string; readonly exitCode: number | null; readonly reportedAssessment: string | null };
  readonly pid: number | null;
}
export interface WorkerObservation {
  readonly taskId: string; readonly identity: AttemptIdentity | null; readonly authority: 'next-ledger' | 'legacy-activity';
  readonly provider: string; readonly workspace: string | null; readonly process: WorkerProcessState;
  readonly handle: string | null; readonly terminal: DispatchTerminal | null;
  readonly outputRecorded: boolean; readonly patchRecorded: boolean; readonly files: WorkerSidecars | null;
  readonly diagnostics: readonly string[];
}
export interface WorkerObservationSource {
  readonly id: string; readonly path: string; readonly kind: string; readonly status: 'available' | 'unavailable' | 'denied' | 'not-sampled';
  readonly workers: readonly WorkerObservation[]; readonly nextAfter: string | null; readonly truncated: boolean;
}
export interface WorkerObservationReport {
  readonly schemaVersion: 1; readonly observedAt: number; readonly scopeId: string;
  readonly sources: readonly WorkerObservationSource[]; readonly control: 'observe-only';
}
export class WorkerObservationError extends Error {
  constructor(readonly code: 'WORKER_OBSERVATION_INVALID' | 'WORKER_OBSERVATION_UNAVAILABLE') { super(code); this.name = 'WorkerObservationError'; }
}
