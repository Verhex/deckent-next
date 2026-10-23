import type { AttemptIdentity, DispatchLossDecision } from '#domain/index.js';
import type { NervousExecutors } from './broker.js';
import type { NervousProposal } from './detect.js';

/** Which launch evidence the fenced dispatch retained: the incarnation (id + start), only the created container id (S6R-1), or neither. */
export type NervousRetained = 'incarnation' | 'container' | 'none';
/** The reconciliation of the Attempt; no `disposition`: the fresh observation settled the dispatch as an ordinary exit, so nothing was fenced. */
export type NervousRecoveryResult = Readonly<{ status: string; disposition?: DispatchLossDecision | undefined; retained?: NervousRetained | undefined }>;
/** The existing applications behind the broker (composition wires them; nothing here reaches an adapter, opens an Attempt or calls a model). */
export interface NervousRecoveryPorts {
  /** The lost-dispatch chain for one Attempt (MARK-LOST-ATOMIC): `fence` writes the fence and then tries the release with a trusted termination
   * observation; `stop` also issues the authorized cancellation between the two (`DISPATCH_FENCED` from the induced exit = stop issued, proof
   * pending). Every step replays from the ledger. */
  recover(identity: AttemptIdentity, step: 'fence' | 'stop'): Promise<NervousRecoveryResult>;
  /** The s5b Nervous safety hold of one Run, idempotent by its command id (a person resumes it). */
  hold(command: Readonly<{ schemaVersion: 1; scopeId: string; runId: string; commandId: string; holdReason: string }>): Promise<unknown>;
}
/** The hold a case leaves for a person: a command id derived from the case (a replay holds once) and a stable code note (EN/TR text is S6R-6). */
export function nervousHoldCommand(proposal: NervousProposal, code: string) {
  const runId = proposal.target.kind === 'attempt' ? proposal.target.identity.runId : proposal.target.kind === 'task' ? proposal.target.runId : null;
  if (runId === null) return null;
  return Object.freeze({ schemaVersion: 1 as const, scopeId: proposal.scopeId, runId, commandId: `nervous-hold:${proposal.caseId}`,
    holdReason: `nervous:${code}:${proposal.rule.id}:${proposal.caseId.slice(0, 12)}` });
}
/** Waiting is right only for a stop whose worker is still seen under its retained incarnation; every other missing proof is structural. */
const pending = (result: NervousRecoveryResult) => result.disposition?.kind === 'hold-manual' && result.disposition.reason === 'termination-required' && result.retained === 'incarnation';

/**
 * S6R-3 (S6R-DESIGN §7 steps 1–3; owner Q-R1/Q-R4/Q-R5): the broker's executors for the stop list it may run. Fence → (stop) → release with proof,
 * in that fixed order; a release needs nothing more here (the task stays `reconciling`; continuation is S6R-4/5). No proof and none coming →
 * the Run goes to a person through the Nervous safety hold. Alert-brain and restart-component have no executor (proposal only).
 */
export function nervousExecutors(ports: NervousRecoveryPorts): NervousExecutors {
  const hold = async (proposal: NervousProposal, code: string) => { const command = nervousHoldCommand(proposal, code); if (command) await ports.hold(command); return 'held' as const; };
  // `pending` lets the broker re-apply the case on a later page (the stop is sent again, a late proof releases); its last application holds instead.
  const lost = (step: 'fence' | 'stop') => async (proposal: NervousProposal, options?: Readonly<{ last: boolean }>) => {
    if (proposal.target.kind !== 'attempt') return 'refused' as const;
    const result = await ports.recover(proposal.target.identity, step);
    if (result.disposition?.kind !== 'hold-manual') return 'done' as const;
    return pending(result) && !options?.last ? 'pending' as const : hold(proposal, result.disposition.reason);
  };
  return Object.freeze({ 'fence-attempt': lost('fence'), 'stop-orphan': lost('stop'),
    'hold-run': (proposal: NervousProposal) => hold(proposal, 'hold-run'), 'hand-to-human': (proposal: NervousProposal) => hold(proposal, 'hand-to-human') });
}
