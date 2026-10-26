import { identitySchema, counterSchema, brainPlanCommandInputSchema, encodeCommandProjection, isAiPrincipal, type BrainPlanCommand, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry, sha256, type TrustedClock } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { RunAuthorization } from '#engine/core/runs/index.js';
import type { RunProposalResult } from './proposal-application.js';
import { isRunIntent, runIntentDigest, setupIntentFactSchema, type RunIntentRecord, type RunProposalStore, type SetupIntentFact } from './proposal-contract.js';
export type RunIntentResult = Readonly<{ schemaVersion: 2; kind: 'intent'; intent: RunIntentRecord; run: null }>;
export type RunPlanningResult = RunProposalResult | RunIntentResult;
export const intentResult = (intent: RunIntentRecord): RunIntentResult => ({ schemaVersion: 2, kind: 'intent', intent, run: null });
export const isRunIntentResult = (value: RunPlanningResult): value is RunIntentResult => 'kind' in value && value.kind === 'intent';
const actor = (p: VerifiedPrincipal) => ({ id: p.id, issuer: p.issuer, subject: p.subject });
const conflict = (): never => { throw ErrorRegistry.createError('RUN_PROPOSAL_COMMAND_CONFLICT'); };
/** Pre-plan state belongs to the proposal owner. No graph, approval, budget or admission is fabricated here. */
export class RunIntentApplication {
  constructor(private readonly store: RunProposalStore, private readonly verifier: PrincipalVerifier, private readonly authorization: RunAuthorization,
    private readonly clock: TrustedClock, private readonly facts: (scopeId: string, principal: VerifiedPrincipal) => Promise<SetupIntentFact | null>,
    private readonly person: (action: 'release' | 'cancel' | 'start') => Promise<void>) {}
  private async principal(command: BrainPlanCommand, credential?: unknown) {
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.authorization.authorize('inspect', { schemaVersion: 1, scopeId: command.scopeId, runId: this.runId(command) }, principal);
    return principal;
  }
  private runId(command: BrainPlanCommand) { return sha256(encodeCommandProjection('brain-run:1', { scopeId: command.scopeId, commandId: command.commandId })); }
  /** All ordinary entrypoints call this before Brain preparation, counting, budget or model I/O. Replay never releases/starts. */
  async preflight(input: unknown, credential?: unknown): Promise<RunIntentResult | null> {
    const command = brainPlanCommandInputSchema.parse(input), principal = await this.principal(command, credential);
    const digest = runIntentDigest(command, actor(principal)), kept = await this.store.loadProposal(command.scopeId, command.commandId);
    if (kept) {
      if (!isRunIntent(kept)) return null;
      if (kept.digest !== digest) conflict();
      return intentResult(kept);
    }
    const observed = await this.facts(command.scopeId, principal);
    if (!observed || observed.ready) return null;
    const fact = setupIntentFactSchema.parse(observed), runId = this.runId(command);
    const record: RunIntentRecord = { schemaVersion: 2, kind: 'intent', command, proposer: actor(principal), proposalId: runId,
      runId, digest, revision: 0, recordedAt: this.clock.sample().wallMs, status: 'parked', fact, transitions: [] };
    const stored = await this.store.recordProposal(record);
    if (!isRunIntent(stored) || stored.digest !== digest) return conflict();
    return intentResult(stored);
  }
  /** Facts are consumed once by identity/revision; no timer writes and no implicit release-to-Run. */
  async transition(input: Readonly<{ command: BrainPlanCommand; commandId: string; expectedRevision: number; action: 'release' | 'cancel' | 'start' | 'fact' }>,
    credential?: unknown): Promise<RunIntentResult> {
    identitySchema.parse(input.commandId); counterSchema.parse(input.expectedRevision);
    if (!['release', 'cancel', 'start', 'fact'].includes(input.action)) return conflict();
    const command = brainPlanCommandInputSchema.parse(input.command), principal = await this.principal(command, credential);
    if (input.action !== 'fact') { if (isAiPrincipal(principal)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED'); await this.person(input.action); }
    const previous = await this.store.loadProposal(command.scopeId, command.commandId);
    if (!previous || !isRunIntent(previous) || previous.digest !== runIntentDigest(command, actor(principal))) return conflict();
    const digest = sha256(encodeCommandProjection('intent-transition:2', input));
    const replay = previous.transitions.find(row => row.commandId === input.commandId);
    if (replay) { if (replay.digest !== digest) return conflict(); return intentResult(previous); }
    if (previous.revision !== input.expectedRevision || previous.status === 'cancelled' || previous.status === 'starting') return conflict();
    let fact = previous.fact; let status: RunIntentRecord['status'];
    if (input.action === 'cancel') status = 'cancelled';
    else {
      const fresh = await this.facts(command.scopeId, principal);
      if (!fresh) return conflict();
      fact = setupIntentFactSchema.parse(fresh);
      if (fact.id === previous.fact.id && fact.revision < previous.fact.revision) return conflict();
      if (input.action === 'start') {
        if (previous.status !== 'released' || !fact.ready) throw ErrorRegistry.createError('WORKER_SETUP_PENDING', { params: fact.params });
        status = 'starting';
      } else status = fact.ready ? 'released' : 'parked';
      if (input.action === 'fact' && fact.id === previous.fact.id && fact.revision === previous.fact.revision) {
        if (JSON.stringify(fact) !== JSON.stringify(previous.fact)) return conflict();
        return intentResult(previous);
      }
    }
    const next: RunIntentRecord = { ...previous, status, fact, revision: previous.revision + 1,
      transitions: [...previous.transitions, { commandId: input.commandId, action: input.action, revision: previous.revision + 1, digest }] };
    const stored = await this.store.transitionProposal(previous, next);
    return isRunIntent(stored) ? intentResult(stored) : conflict();
  }
}

/** Transition revisions advance once; replay uses the revision the start command compared. */
export const intentStartExpectedRevision = (revision: number) => revision - 1;
