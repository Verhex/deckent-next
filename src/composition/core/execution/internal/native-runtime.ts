import type { NativeAgentExecution } from '#capabilities/index.js';
import { nativeCliWorkerFence, withMcpPrincipal, type NativeCliWorkerBinding, type NativeCliWorkerPorts, type SqliteAttemptStore } from '#adapters/index.js';
import { inspectSubscriptionReadiness, nativeReadinessQuery, type SubscriptionReadinessReader } from '#composition/core/subscription-readiness/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { recheckNativeWorkerUse, resolveNativeWorkerUse, assertNativeWorkerReservation, type NativeWorkerUse } from '#composition/core/runs/index.js';
/** K16 owns the shared isolated driver/readiness; K1 owns the tool session. No invocation claim is opened for this Run worker. */
export interface NativeCliWorkerRuntime {
  prepare?(profile: import('#domain/index.js').ModelInvocationProfile): Promise<import('#capabilities/index.js').NativeAgentReadinessReason | null>;
  readonly readiness: SubscriptionReadinessReader;
  /** `use`: the point's fresh K5 resolution, reused by its evidence target; `execution`: the seal its readiness read (no second observation read). */
  f08(query: Readonly<{ scopeId: string; reference: import('#domain/index.js').ModelReference; binding: NativeCliWorkerBinding; use?: NativeWorkerUse;
    execution?: NativeAgentExecution }>): Promise<NativeAgentExecution | null>;
  readonly verification?: NativeCliWorkerPorts['verification'];
  readonly driver: NativeCliWorkerPorts['driver'];
  /** `plan`: the Run's recorded worker ceiling (R9; null: none recorded). */ readonly openTools: (...args: [...Parameters<NativeCliWorkerPorts['openTools']>, plan?: import('#domain/index.js').RunExecutionSnapshot['workerMode'] | null]) => ReturnType<NativeCliWorkerPorts['openTools']>;
  readonly bridgeLimits: NativeCliWorkerPorts['bridgeLimits'];
  readonly checkEnvironment?: NativeCliWorkerPorts['checkEnvironment'];
}
export function createConfiguredNativeCliWorkerPorts(root: string, scopeId: string, store: Pick<SqliteAttemptStore, 'loadRun' | 'loadRunResourceCapacity' | 'loadBoundDispatch' | 'load' | 'loadRunReceipt'>,
  options: ConfigLoadOptions, runtime: NativeCliWorkerRuntime): NativeCliWorkerPorts {
  const recheck: NativeCliWorkerPorts['recheck'] = async (request, binding, signal) => {
    if (signal.aborted || request.identity.scopeId !== scopeId || !await nativeCliWorkerFence(store, request.identity)) throw ErrorRegistry.createError('DISPATCH_FENCED');
    await recheckNativeWorkerUse(root, scopeId, binding, options);
  };
  const readinessPoint: NonNullable<NativeCliWorkerPorts['readinessPoint']> = async binding => {
    const current = await resolveNativeWorkerUse(root, scopeId, binding, options), query = nativeReadinessQuery(current.profile, 'worker'); // the profile carries binding.profileDigest
    const f08 = (execution: NativeAgentExecution) => runtime.f08({ scopeId, reference: current.profile.reference, binding, use: current, execution });
    if (!query) return { readiness: { state: 'unknown', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' }, f08 };
    const observed = await runtime.readiness.read(query); // read once; a wired verification checks unknown surface facts in the guarded first run
    return { readiness: await inspectSubscriptionReadiness(query, { read: async () => observed }, runtime.verification ? { unknownSurfaceFacts: 'allow' } : {}), f08 };
  };
  return {
    ...(runtime.prepare ? { prepare: async (binding: NativeCliWorkerBinding) => runtime.prepare!((await recheckNativeWorkerUse(root, scopeId, binding, options)).profile) } : {}),
    readiness: async binding => (await readinessPoint(binding)).readiness, readinessPoint,
    async f08(binding) {
      const current = await resolveNativeWorkerUse(root, scopeId, binding, options);
      return runtime.f08({ scopeId, reference: current.profile.reference, binding, use: current });
    },
    ...(runtime.verification ? { verification: runtime.verification } : {}),
    recheck,
    capacity: { async acquire(request, binding, signal) {
      await recheck(request, binding, signal);
      const run = await store.loadRun(scopeId, request.identity.runId);
      if (!run || !assertNativeWorkerReservation(run, request, binding, await store.loadRunResourceCapacity(run))) return { state: 'waiting' };
      // Reservation/progress in the existing ledger owns both acquisition and release. Unknown remains occupied.
      return { state: 'acquired', async release() {} };
    } },
    async openTools(request, binding, signal, context) {
      await recheck(request, binding, signal); const plan = (await store.loadRun(scopeId, request.identity.runId))?.execution.workerMode ?? null;
      const tools = await withMcpPrincipal(() => runtime.openTools(request, binding, signal, context, plan));
      return { session: tools.session, terminalFailure: () => tools.terminalFailure?.() ?? null, propose: (...args) => withMcpPrincipal(() => tools.propose(...args)),
        cancel: () => withMcpPrincipal(() => tools.cancel()), revoke: () => withMcpPrincipal(() => tools.revoke()) };
    },
    async driver(input, signal) {
      const driver = await withMcpPrincipal(() => runtime.driver(input, signal));
      return { ...driver, tools: driver.tools, run: (...args) => withMcpPrincipal(() => driver.run(...args)), close: () => withMcpPrincipal(() => driver.close()) };
    },
    ...(runtime.checkEnvironment ? { checkEnvironment: async (...args: Parameters<NonNullable<NativeCliWorkerPorts['checkEnvironment']>>) => {
      const [request, binding, , , signal] = args; await recheck(request, binding, signal);
      await withMcpPrincipal(() => runtime.checkEnvironment!(...args));
    } } : {}),
    bridgeLimits: runtime.bridgeLimits,
  };
}
