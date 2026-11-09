import { attemptIdentitySchema, parseRun, type AttemptIdentity } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { DispatchIdentityAuthorization } from '#engine/core/dispatch/index.js';
import { selectReservedTaskProfile, RunStoreError, type RunStore } from '#engine/core/runs/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
type Store = Pick<RunStore, 'loadRun'> & Pick<AttemptStore, 'load'>;
const opened = new WeakMap<object, { store: Store; authorization: DispatchIdentityAuthorization }>();
/** One authorized ledger read for a task-start chain; launch fencing remains fresh at dispatch. */
export class TaskStartApplication {
  constructor(private readonly store: Store, private readonly verifier: PrincipalVerifier,
    private readonly authorization: DispatchIdentityAuthorization) {}
  async open(input: AttemptIdentity, credential?: unknown) {
    const identity = attemptIdentitySchema.parse(input);
    const principal = await authenticate(this.verifier, credential, identity.scopeId);
    await this.authorization.authorizeIdentity('execute', identity, principal);
    const run = parseRun(await this.store.loadRun(identity.scopeId, identity.runId));
    const attempt = await this.store.load(identity.scopeId, identity.attemptId);
    const profile = selectReservedTaskProfile(run, attempt, identity);
    const context = Object.freeze({ identity, principal, run, attempt, profile });
    opened.set(context, { store: this.store, authorization: this.authorization });
    return context;
  }
}
export type TaskStartContext = Awaited<ReturnType<TaskStartApplication['open']>>;
/** The internal continuation accepts only this store and authorization owner's authenticated context. */
export function assertTaskStartContext(context: TaskStartContext, store: Store, authorization: DispatchIdentityAuthorization): void {
  const owner = opened.get(context);
  if (owner?.store !== store || owner.authorization !== authorization) throw new RunStoreError('RUN_STORE_CONFLICT');
}
