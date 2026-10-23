import type { VerifiedPrincipal } from '#domain/index.js';
import { recoveryContinuationApproval } from './approval.js';

export type RecoveryConfigMode = 'off' | 'shadow' | 'live';
/** Whether the owner's standing grant `recovery-action/apply continue-new-attempt` holds in every scope read, some, none, or could not be read. */
export type RecoveryGrantState = 'present' | 'partial' | 'missing' | 'unknown';
/**
 * What lost-worker recovery does with this configuration (S6R-6 live switch semantics, S6R-DESIGN §11):
 * `none` — recovery off: no case, no decision (a lost worker's Run is held for a person by Nervous or stays as reconciliation leaves it);
 * `recorded` — shadow: a decision is sealed as what would happen, nothing changes;
 * `automatic` — live with the grant: a lost task may continue in a new Attempt within its frozen bounds (§7 gate first);
 * `person` — live without the grant (rollout phase 2): every case is sealed and goes to a person (`continuation-not-approved`), no model call;
 * `partial` — live, the grant holds in some scopes only; `unknown` — live, the grant could not be read (treated as no grant at decision time).
 */
export type RecoveryContinuation = 'none' | 'recorded' | 'automatic' | 'person' | 'partial' | 'unknown';
export type RecoveryModeState = Readonly<{ nervous: RecoveryConfigMode; recovery: RecoveryConfigMode; grant: RecoveryGrantState; continuation: RecoveryContinuation }>;

/** The grant state over `scopeIds` (read fresh; any read failure is `unknown`, never `present`). */
export function recoveryGrantState(document: unknown, principal: VerifiedPrincipal, scopeIds: readonly string[], nowMs: number): RecoveryGrantState {
  if (!scopeIds.length) return 'unknown';
  try {
    const held = scopeIds.filter(scopeId => recoveryContinuationApproval(document, principal, scopeId, nowMs) !== null).length;
    return held === scopeIds.length ? 'present' : held ? 'partial' : 'missing';
  } catch { return 'unknown'; }
}
/** Pure: the one reading of the protected modes and the grant that doctor and monitor both show (one transition owner: the recovery decision). */
export function recoveryModeState(modes: Readonly<{ nervous: RecoveryConfigMode; recovery: RecoveryConfigMode }>, grant: RecoveryGrantState): RecoveryModeState {
  const continuation: RecoveryContinuation = modes.recovery === 'off' ? 'none' : modes.recovery === 'shadow' ? 'recorded'
    : grant === 'present' ? 'automatic' : grant === 'missing' ? 'person' : grant;
  return Object.freeze({ nervous: modes.nervous, recovery: modes.recovery, grant, continuation });
}
