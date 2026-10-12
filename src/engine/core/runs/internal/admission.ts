import { clientCommandIdSchema } from '#domain/index.js';
import { z } from 'zod';
import { branchInputSchema, resolveAdmissionBranch, identitySchema, taskGraphSchema, type RunProposalBinding, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { PoolAuthorization } from '#engine/core/policy/index.js';
import { runWorkspaceCustodySchema, type RunWorkspaceCustody, type RunWorkspaceCustodyStore } from '#engine/core/workspaces/index.js';
import { runCreateSchema, RunStoreError, type RunStore, type RunCreate, type RunReceipt } from './store.js';
import { RunCreationAuthority, type RunAdmissionEvaluation } from './authority.js';
import { projectRunView } from './view.js';
export const runAdmissionSchema = z.object({ schemaVersion: z.literal(1), commandId: clientCommandIdSchema,
  scopeId: identitySchema, runId: identitySchema, graph: taskGraphSchema, branch: branchInputSchema.optional() }).strict();
export type RunAdmission = z.infer<typeof runAdmissionSchema>;
/** Engine-only deterministic provenance, never an ingress field of run create. */
export type BoundRunAdmission = RunAdmission & { readonly proposal?: RunProposalBinding };
/** Local SDK ingress for a Run pinned to a completed delivery of the same scope; the commit is resolved by trusted composition. */
export const runDeliveryAdmissionSchema = runAdmissionSchema.extend({ deliveryCommandId: identitySchema }).strict();
export type RunDeliveryAdmission = z.infer<typeof runDeliveryAdmissionSchema>;
/** Trusted composition resolves the pinned workspace custody after `run:create` authorization. Never a wire field. `replay` is true
 * when the command already has a receipt: the answer then comes from recorded state, never from a live reference that may have moved. */
export type RunWorkspacePin = (replay: boolean) => Promise<RunWorkspaceCustody>;
export interface RunAdmissionContext {
  /** Trusted composition resolves installation layout, clock and execution policy. Never read them from model wire fields. */
  resolve(command: BoundRunAdmission, principal: VerifiedPrincipal): Promise<Pick<RunCreate, 'now' | 'policy' | 'execution'> & { layoutRevision: string }>;
}
const persistedCreate = runCreateSchema.extend({ action: z.literal('create-run') }).strict();
export class RunAdmissionApplication {
  constructor(private readonly store: Pick<RunStore, 'createRun' | 'loadRunReceipt'> & Pick<RunWorkspaceCustodyStore, 'loadRunWorkspaceCustody'>, private readonly verifier: PrincipalVerifier,
    private readonly authorization: RunCreationAuthority, private readonly poolAuthorization: PoolAuthorization, private readonly context: RunAdmissionContext) {}
  async hasReceipt(scopeId: string, commandId: string) { return (await this.store.loadRunReceipt(scopeId, commandId)) !== null; }
  private replay(receipt: RunReceipt, command: BoundRunAdmission, actor: RunCreate['actor']) {
    let previous;
    try { previous = persistedCreate.parse(JSON.parse(receipt.command)); } catch { throw new RunStoreError('RUN_COMMAND_CONFLICT'); }
    if (previous.commandId !== command.commandId || previous.identity.runId !== command.runId || previous.identity.scopeId !== command.scopeId ||
      JSON.stringify(previous.actor) !== JSON.stringify(actor) || JSON.stringify(previous.branch?.sourceGraph ?? previous.graph) !== JSON.stringify(command.graph) ||
      JSON.stringify(previous.proposal) !== JSON.stringify(command.proposal) ||
      JSON.stringify(previous.branch?.request) !== JSON.stringify(command.branch)) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    if (JSON.stringify(receipt.snapshot.graph) !== JSON.stringify(previous.graph)) throw new RunStoreError('RUN_STORE_CORRUPT');
    const view = projectRunView(receipt.snapshot);
    if (JSON.stringify(receipt.snapshot.branch) !== JSON.stringify(previous.branch)) throw new RunStoreError('RUN_STORE_CORRUPT');
    if (JSON.stringify(receipt.snapshot.execution) !== JSON.stringify(previous.execution)) throw new RunStoreError('RUN_STORE_CORRUPT');
    if (JSON.stringify(receipt.snapshot.proposal) !== JSON.stringify(previous.proposal)) throw new RunStoreError('RUN_STORE_CORRUPT');
    if (JSON.stringify(receipt.snapshot.authority) !== JSON.stringify(previous.authority)) throw new RunStoreError('RUN_STORE_CORRUPT');
    if (view.runId !== command.runId || view.scopeId !== command.scopeId || view.layoutRevision !== previous.identity.layoutRevision) throw new RunStoreError('RUN_STORE_CORRUPT');
    return Object.freeze({ schemaVersion: 1 as const, commandId: command.commandId, run: view });
  }
  /** A pinned admission is identical only with the same recorded custody (source and commit); anything else never reuses the Run. */
  private async pinned(receipt: RunReceipt, command: BoundRunAdmission, principal: VerifiedPrincipal, workspace?: RunWorkspaceCustody) {
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const result = this.replay(receipt, command, actor);
    const recorded = await this.store.loadRunWorkspaceCustody(command.scopeId, command.runId);
    const previous = runCreateSchema.strip().parse(persistedCreate.parse(JSON.parse(receipt.command)));
    this.authorization.verifyReplay(command, principal, previous, recorded ?? undefined);
    if (workspace) {
      if (!recorded || JSON.stringify(recorded) !== JSON.stringify(workspace)) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    }
    return result;
  }
  async create(input: unknown, credential?: unknown, pin?: RunWorkspacePin) {
    const command = runAdmissionSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const evaluation = await this.authorization.evaluate(command, principal);
    return this.admitEvaluated(command, principal, evaluation, pin);
  }
  /** Trusted proposal application shares this exact path and passes its one sampled policy evaluation. */
  async admitEvaluated(command: BoundRunAdmission, principal: VerifiedPrincipal, evaluation: RunAdmissionEvaluation, pin?: RunWorkspacePin) {
    evaluation = this.authorization.evaluatePermissions(command, principal, evaluation);
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const replay = await this.store.loadRunReceipt(command.scopeId, command.commandId);
    const workspace = pin ? runWorkspaceCustodySchema.parse(await pin(replay !== null)) : undefined;
    if (workspace && (workspace.scopeId !== command.scopeId || workspace.runId !== command.runId)) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    if (replay) return this.pinned(replay, command, principal, workspace);
    let create: RunCreate;
    try {
      const resolved = command.branch ? resolveAdmissionBranch(command.graph, command.branch) : undefined;
      const graph = resolved?.graph ?? command.graph;
      const context = await this.context.resolve({ ...command, graph }, principal);
      await this.poolAuthorization.authorize(context.policy.poolId, command.scopeId, principal);
      create = runCreateSchema.parse({ commandId: command.commandId, actor, graph, ...(command.proposal ? { proposal: command.proposal } : {}), ...(resolved ? { branch: resolved.decision } : {}),
        identity: { runId: command.runId, scopeId: command.scopeId, layoutRevision: context.layoutRevision }, now: context.now, policy: context.policy, execution: context.execution });
    } catch (error) {
      this.authorization.recordUnapplied(command, principal, evaluation);
      throw error;
    }
    const admitted = await this.authorization.prepare(command, principal, evaluation, create, workspace);
    try {
      const receipt = await this.store.createRun({ ...create, authority: admitted.authority }, workspace, admitted.assert);
      return await this.pinned(receipt, command, principal, workspace);
    } catch (error) {
      // A concurrent identical admission may have won using a different sampled clock/config snapshot.
      if (!(error instanceof RunStoreError) || error.code !== 'RUN_COMMAND_CONFLICT') throw error;
      const winner = await this.store.loadRunReceipt(command.scopeId, command.commandId);
      if (!winner) throw error;
      return this.pinned(winner, command, principal, workspace);
    }
  }
}
