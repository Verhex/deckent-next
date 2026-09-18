import type { AttemptSnapshot, VerifiedPrincipal } from '#domain/index.js';

export interface AttemptReceipt {
  readonly commandId: string;
  readonly command: string;
  readonly snapshot: AttemptSnapshot;
}
export interface AttemptCommit extends AttemptReceipt {
  readonly expectedRevision: number | null;
  /** Present only for an authenticated cancellation command. Persistence uses it to attribute an
   * existing exact dispatch in the same transaction as the Attempt and receipt writes. */
  readonly cancellationActor?: VerifiedPrincipal;
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
  constructor(readonly code: 'ATTEMPT_STORE_CONFLICT' | 'ATTEMPT_COMMAND_CONFLICT' | 'ATTEMPT_STORE_VERSION' | 'LEDGER_RESET_REQUIRED' | 'ATTEMPT_STORE_CORRUPT' | 'ATTEMPT_STORE_BUSY' | 'ATTEMPT_STORE_OPTIONS' | 'ATTEMPT_STORE_OUTCOME_UNKNOWN' | 'ATTEMPT_STORE_READ_UNAVAILABLE') {
    super(code); this.name = 'AttemptStoreError';
  }
}
