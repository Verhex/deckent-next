import type { AttemptSnapshot } from '#domain/index.js';

export interface AttemptReceipt {
  readonly commandId: string;
  readonly command: string;
  readonly snapshot: AttemptSnapshot;
}
export interface AttemptCommit extends AttemptReceipt {
  readonly expectedRevision: number | null;
}
/** Each commit atomically compares the revision, writes the snapshot and records the command receipt.
 * Receipt identity is scope + commandId; a conflicting payload is never an idempotent success.
 */
export interface AttemptStore {
  load(scopeId: string, attemptId: string): Promise<AttemptSnapshot | null>;
  receipt(scopeId: string, commandId: string): Promise<AttemptReceipt | null>;
  commit(input: AttemptCommit): Promise<AttemptReceipt>;
}
export class AttemptStoreError extends Error {
  constructor(readonly code: 'ATTEMPT_STORE_CONFLICT' | 'ATTEMPT_COMMAND_CONFLICT' | 'ATTEMPT_STORE_VERSION' | 'ATTEMPT_STORE_CORRUPT' | 'ATTEMPT_STORE_BUSY' | 'ATTEMPT_STORE_OPTIONS' | 'ATTEMPT_STORE_OUTCOME_UNKNOWN') {
    super(code); this.name = 'AttemptStoreError';
  }
}
