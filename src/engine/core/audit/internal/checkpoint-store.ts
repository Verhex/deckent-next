import type { AuditCheckpoint } from '#domain/index.js';
import type { AuditStore } from './store.js';
/** The engine owns heads and seals; the adapter owns consistent snapshots and append-only persistence. */
export interface AuditCheckpointStore extends AuditStore {
  scopeIds(limit: number): readonly string[];
  snapshot<T>(write: boolean, work: () => T): T;
  checkpointPage(scopeId: string, afterSequence: number, limit: number): readonly AuditCheckpoint[];
  appendCheckpoint(checkpoint: AuditCheckpoint): void;
}
