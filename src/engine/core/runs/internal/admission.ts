import { z } from 'zod';
import { branchInputSchema, resolveAdmissionBranch, identitySchema, taskGraphSchema, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { PoolAuthorization } from '#engine/core/policy/index.js';
import { runCreateSchema, RunStoreError, type RunStore, type RunCreate, type RunReceipt } from './store.js';
import type { RunAuthorization } from './application.js';
import { projectRunView } from './view.js';
export const runAdmissionSchema = z.object({ schemaVersion: z.literal(1), commandId: identitySchema,
  scopeId: identitySchema, runId: identitySchema, graph: taskGraphSchema, branch: branchInputSchema.optional() }).strict();
export type RunAdmission = z.infer<typeof runAdmissionSchema>;
export interface RunAdmissionContext {
  /** Trusted composition resolves installation layout, clock and execution policy. Never read them from model wire fields. */
  resolve(command: RunAdmission, principal: VerifiedPrincipal): Promise<Pick<RunCreate, 'now' | 'policy' | 'execution'> & { layoutRevision: string }>;
}
const persistedCreate = runCreateSchema.extend({ action: z.literal('create-run') }).strict();
export class RunAdmissionApplication {
  constructor(private readonly store: Pick<RunStore, 'createRun' | 'loadRunReceipt'>, private readonly verifier: PrincipalVerifier,
    private readonly authorization: RunAuthorization, private readonly poolAuthorization: PoolAuthorization, private readonly context: RunAdmissionContext) {}
  private replay(receipt: RunReceipt, command: RunAdmission, actor: RunCreate['actor']) {
    let previous;
    try { previous = persistedCreate.parse(JSON.parse(receipt.command)); } catch { throw new RunStoreError('RUN_COMMAND_CONFLICT'); }
    if (previous.commandId !== command.commandId || previous.identity.runId !== command.runId || previous.identity.scopeId !== command.scopeId ||
      JSON.stringify(previous.actor) !== JSON.stringify(actor) || JSON.stringify(previous.branch?.sourceGraph ?? previous.graph) !== JSON.stringify(command.graph) ||
      JSON.stringify(previous.branch?.request) !== JSON.stringify(command.branch)) throw new RunStoreError('RUN_COMMAND_CONFLICT');
    if (JSON.stringify(receipt.snapshot.graph) !== JSON.stringify(previous.graph)) throw new RunStoreError('RUN_STORE_CORRUPT');
    const view = projectRunView(receipt.snapshot);
    if (JSON.stringify(receipt.snapshot.branch) !== JSON.stringify(previous.branch)) throw new RunStoreError('RUN_STORE_CORRUPT');
    if (JSON.stringify(receipt.snapshot.execution) !== JSON.stringify(previous.execution)) throw new RunStoreError('RUN_STORE_CORRUPT');
    if (view.runId !== command.runId || view.scopeId !== command.scopeId || view.layoutRevision !== previous.identity.layoutRevision) throw new RunStoreError('RUN_STORE_CORRUPT');
    return Object.freeze({ schemaVersion: 1 as const, commandId: command.commandId, run: view });
  }
  async create(input: unknown, credential?: unknown) {
    const command = runAdmissionSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.authorization.authorize('create', command, principal);
    const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
    const replay = await this.store.loadRunReceipt(command.scopeId, command.commandId);
    if (replay) return this.replay(replay, command, actor);
    const resolved = command.branch ? resolveAdmissionBranch(command.graph, command.branch) : undefined;
    const graph = resolved?.graph ?? command.graph;
    const context = await this.context.resolve({ ...command, graph }, principal);
    await this.poolAuthorization.authorize(context.policy.poolId, command.scopeId, principal);
    try {
      const receipt = await this.store.createRun({ commandId: command.commandId, actor, graph, ...(resolved ? { branch: resolved.decision } : {}),
        identity: { runId: command.runId, scopeId: command.scopeId, layoutRevision: context.layoutRevision }, now: context.now, policy: context.policy, execution: context.execution });
      return this.replay(receipt, command, actor);
    } catch (error) {
      // A concurrent identical admission may have won using a different sampled clock/config snapshot.
      if (!(error instanceof RunStoreError) || error.code !== 'RUN_COMMAND_CONFLICT') throw error;
      const winner = await this.store.loadRunReceipt(command.scopeId, command.commandId);
      if (!winner) throw error;
      return this.replay(winner, command, actor);
    }
  }
}
