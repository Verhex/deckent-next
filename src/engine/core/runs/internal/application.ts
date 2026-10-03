import { observeRunPool, type RunPoolEvidence } from './pool-observation.js';
import { projectRunView } from './view.js';
import { z } from 'zod';
import { identitySchema, counterSchema, runSnapshotSchema, type CorePolicyAction, type VerifiedPrincipal } from '#domain/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { describeRunWorkerModels, type WorkerEventArtifacts, type WorkerEventLogStore } from '#engine/core/worker-observation/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { RunStoreError, type RunStore } from './store.js';
export const runQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, runId: identitySchema }).strict();
export const runCommandSchema = runQuerySchema.extend({ commandId: identitySchema, action: z.literal('cancel'), expectedRevision: counterSchema }).strict();
export type RunQuery = z.infer<typeof runQuerySchema>;
export type RunCommand = z.infer<typeof runCommandSchema>;
export interface RunAuthorization { authorize(action: CorePolicyAction<'run'>, query: RunQuery, principal: VerifiedPrincipal): Promise<void> }
/** Sealed worker evidence ports for the pinned model rows of `run inspect` (WORKER-CURRENCY-2); each attempt needs `read-output`. */
export interface RunModelEvidence {
  readonly store: Pick<WorkerEventLogStore, 'loadWorkerEventLog'>; readonly artifacts: WorkerEventArtifacts; readonly authorization: DispatchIdentityAuthorization;
}
/** Shared authenticated ingress. Cancellation records intent; it never fabricates worker termination. */
export class RunInspectionApplication {
  constructor(private readonly readStore: Pick<RunStore, 'loadRun'> & { loadRunPoolEvidence?(scopeId: string, runId: string): Promise<RunPoolEvidence> }, protected readonly verifier: PrincipalVerifier,
    protected readonly authorization: RunAuthorization, private readonly models?: RunModelEvidence, private readonly poolConfig?: { readonly admission?: { readonly executionSlots: number; readonly inFlightSlots: number }; readonly ceiling: number }) {}
  async inspect(input: unknown, credential?: unknown) { return (await this.load(input, credential)).run; }
  /** The Run view with requested → init → usage → verdict of each pinned worker task (empty without the evidence ports). */
  async inspectWithModels(input: unknown, credential?: unknown) {
    const { run, snapshot, principal } = await this.load(input, credential);
    const models = run && this.models ? await describeRunWorkerModels(runSnapshotSchema.parse(snapshot), principal, this.models.store, this.models.artifacts,
      this.models.authorization) : Object.freeze([]);
    return Object.freeze({ run, models });
  }
  private async load(input: unknown, credential?: unknown) {
    const query = runQuerySchema.parse(input);
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', query, principal);
    const evidence = this.readStore.loadRunPoolEvidence ? await this.readStore.loadRunPoolEvidence(query.scopeId, query.runId) : null;
    const snapshot = evidence ? evidence.snapshot : await this.readStore.loadRun(query.scopeId, query.runId);
    if (!snapshot) return { run: null, snapshot, principal };
    const pool = evidence ? observeRunPool(evidence, Date.now(), this.poolConfig?.admission, this.poolConfig?.ceiling) : undefined;
    const view = { ...projectRunView(snapshot), ...(pool ? { pool } : {}) };
    if (view.scopeId !== query.scopeId || view.runId !== query.runId) throw new RunStoreError('RUN_STORE_CORRUPT');
    return { run: view, snapshot, principal };
  }
}
export class RunApplication extends RunInspectionApplication {
  constructor(private readonly store: Pick<RunStore, 'loadRun' | 'cancelRun'>, verifier: PrincipalVerifier, authorization: RunAuthorization) {
    super(store, verifier, authorization);
  }
  async execute(input: unknown, credential?: unknown) {
    const command = runCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    await this.authorization.authorize(command.action, command, principal);
    return this.store.cancelRun({ commandId: command.commandId, scopeId: command.scopeId, runId: command.runId,
      expectedRevision: command.expectedRevision, actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject } });
  }
}
