import { createNativeCliWorkerDriver, createClaudeAgentDriver, preflightNativeAgent, runHeadlessIsolated,
  nativeBridgeLimits, nativeCliAgent, nativeAgentFlagSetDigest, nativeWorkerEvidenceFile, readNativeAgentObservation } from '#adapters/index.js';
import { nativeCliHeadlessDefinitionSchema, prepareNativeWorkerObservation, nativeWorkerVerificationPorts, nativeWorkerEvidenceKey, nativeWorkerEvidenceTargetSchema } from '#capabilities/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { configuredBubblewrap } from '#composition/core/model-invocation/index.js';
import { configuredNativeChatReadiness } from '#composition/core/subscription-readiness/index.js';
import { recheckNativeWorkerUse, type NativeWorkerUse } from '#composition/core/runs/index.js';
import type { NativeCliWorkerRuntime } from './native-runtime.js';
import { nativeWorkerEnvironment } from './worker-floor.js';
import { openConfiguredNativeWorkerTools } from './worker-tools.js';
/** Trusted composition dependencies, never command/task input. Missing F08 remains unknown. */
export function createConfiguredNativeCliWorkerRuntime(root: string, options: ConfigLoadOptions = {}): NativeCliWorkerRuntime | undefined {
  const bridgeLimits = nativeBridgeLimits(), isolation = configuredBubblewrap(options);
  if (!bridgeLimits) return undefined;
  const readiness = configuredNativeChatReadiness(root, options), evidence = (use?: NativeWorkerUse) => nativeWorkerVerificationPorts(async (scopeId, binding, execution) => {
    const { profile } = await recheckNativeWorkerUse(root, scopeId, binding, options, use), entry = nativeCliAgent(binding.protocolFamily);
    if (!entry) throw ErrorRegistry.createError('NATIVE_WORKER_F08_INVALID');
    const value = nativeWorkerEvidenceTargetSchema.parse({ scopeId, reference: profile.reference, connectionId: binding.connectionId, execution });
    return { value, file: nativeWorkerEvidenceFile(binding.definition.stateDir, binding.definition.ownerUid, entry.headless.limits.preflightOutputBytes, nativeWorkerEvidenceKey(value)) };
  });
  return Object.freeze({ readiness, verification: evidence().verification,
    async f08(query) {
      const entry = nativeCliAgent(query.binding.protocolFamily); if (!entry) return null;
      const execution = query.execution ?? (await readiness.read({ surface: 'worker', scopeId: query.scopeId, reference: query.reference,
        profileDigest: query.binding.profileDigest, flagSetDigest: nativeAgentFlagSetDigest(entry) }))?.execution;
      return execution ? evidence(query.use).read(query.scopeId, query.binding, execution) : null;
    },
    async prepare(profile) {
      const entry = nativeCliAgent(profile.protocol.family); if (!entry) return 'NATIVE_AGENT_CAPABILITY_UNSEALED';
      const definition = nativeCliHeadlessDefinitionSchema.parse(profile.adapter.definition);
      return prepareNativeWorkerObservation({ read: () => readNativeAgentObservation(profile),
        claim: () => nativeWorkerEvidenceFile(definition.stateDir, definition.ownerUid, entry.headless.limits.preflightOutputBytes,
          modelInvocationProfileDigest(profile), 'worker-preflight').claim(), preflight: () => preflightNativeAgent(profile, Date.now, isolation) });
    },
    checkEnvironment: nativeWorkerEnvironment(root, options),
    bridgeLimits,
    openTools: (request, binding, signal, context, plan) => openConfiguredNativeWorkerTools(root, request, binding, signal, context, options, plan),
    async driver(input, signal) {
      if (signal.aborted) throw ErrorRegistry.createError('DISPATCH_FENCED');
      const scopeId = input.binding.modelUsePin?.['scopeId'];
      if (typeof scopeId !== 'string' || !scopeId) throw ErrorRegistry.createError('DISPATCH_FENCED');
      const { profile } = await recheckNativeWorkerUse(root, scopeId, input.binding, options);
      return createNativeCliWorkerDriver(input, { profile, preflight: signal => preflightNativeAgent(profile, Date.now, isolation, signal),
        claudeDriver: createClaudeAgentDriver,
        runIsolated: (entry, spawn, bounds, signal, line) => runHeadlessIsolated(entry, isolation, spawn, bounds, signal, line) }, signal);
    },
  } satisfies NativeCliWorkerRuntime);
}
/** The execution options with the configured native worker runtime, when the agent bridge is usable. */
export function withNativeCliWorkerOptions(root: string, options: ConfigLoadOptions = {}) {
  const runtime = createConfiguredNativeCliWorkerRuntime(root, options);
  return { ...options, ...(runtime ? { nativeCliWorker: { runtime, projectionRetired: false } } : {}) };
}
