import { runSnapshotSchema, type RunSnapshot } from '#domain/index.js';
import { RunStoreError } from '#engine/index.js';
import { decodeStored } from './options.js';
/** One canonical row decoder for Run writers and cross-scope resource occupancy readers: identity always, plus the caller's checks and code. */
export const decodeLedgerRunSnapshot = (snapshot: unknown, scopeId: string, runId: string, error: () => Error = () => new RunStoreError('RUN_STORE_CORRUPT'),
  matches: (run: RunSnapshot) => boolean = () => true) =>
  decodeStored(runSnapshotSchema, snapshot, error, value => value.identity.scopeId === scopeId && value.identity.runId === runId && matches(value));
