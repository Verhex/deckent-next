import type { AuditCounter, AuditEvent, AuditRecord } from '#domain/index.js';
/**
 * Durable audit port (general Core audit port, first slice). Events are append-only: the adapter assigns the next scope-local
 * sequence under its write transaction and calls `seal` for that sequence, so the persisted MAC binds scope, sequence and
 * content atomically. Nothing here updates or deletes an event; counters are mutable summaries only (owner q5).
 */
export interface AuditStore {
  /** Appends `event` as the next record of its scope, or returns the existing record of the same event id and content
   * (`AUDIT_CONFLICT` when the content differs). Any failure to persist is `AUDIT_UNAVAILABLE`: the caller applies no effect. */
  append(event: AuditEvent, seal: (sequence: number) => AuditRecord): AuditRecord;
  /** Records of one scope with `sequence > afterSequence`, ascending, at most `limit`; other scopes are never visible. */
  page(scopeId: string, afterSequence: number, limit: number): readonly AuditRecord[];
  /** Adds `by` to a summary counter of one scope (created at zero); `atMs` is the caller's trusted clock. */
  increment(scopeId: string, counter: string, by: number, atMs: number): AuditCounter;
  counters(scopeId: string): readonly AuditCounter[];
}
