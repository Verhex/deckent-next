import { createNativeCliWorkerDriver, createClaudeAgentDriver, prepareClaudeAgentRun, preflightNativeAgent, runHeadlessIsolated,
  nativeCliAgentBridge, nativeEgressLimits, shellSandboxCapabilities } from '#adapters/index.js';
import { globalStateRoot, ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { configuredNativeChatReadiness } from '#composition/core/subscription-readiness/index.js';
import { recheckNativeWorkerUse } from '#composition/core/runs/index.js';
import type { NativeCliWorkerRuntime } from './native-runtime.js';
import { openConfiguredNativeWorkerTools } from './worker-tools.js';

/** Trusted composition dependencies, never command/task input. Missing F08 remains unknown. */
export function createConfiguredNativeCliWorkerRuntime(root: string, options: ConfigLoadOptions = {},
  f08: NativeCliWorkerRuntime['f08'] = async () => null): NativeCliWorkerRuntime | undefined {
  const bridge = nativeCliAgentBridge(), egress = nativeEgressLimits();
  if (!bridge?.maxConnections || !bridge.replayMaxEntries || !bridge.replayMaxBytes || bridge.maxConnections >= egress.connections) return undefined;
  const isolation = async () => (await shellSandboxCapabilities(globalStateRoot(options.env ?? process.env))).bubblewrap;
  return Object.freeze({ readiness: configuredNativeChatReadiness(root, options), f08,
    bridgeLimits: { idleMs: egress.idleMs, maxConnections: bridge.maxConnections, replayMaxEntries: bridge.replayMaxEntries, replayMaxBytes: bridge.replayMaxBytes },
    openTools: (request, binding, signal, context) => openConfiguredNativeWorkerTools(root, request, binding, signal, context, options),
    async driver(input, signal) {
      if (signal.aborted) throw ErrorRegistry.createError('DISPATCH_FENCED');
      const scopeId = input.binding.modelUsePin?.['scopeId'];
      if (typeof scopeId !== 'string' || !scopeId) throw ErrorRegistry.createError('DISPATCH_FENCED');
      const { profile } = await recheckNativeWorkerUse(root, scopeId, input.binding, options);
      return createNativeCliWorkerDriver(input, { profile, preflight: signal => preflightNativeAgent(profile, Date.now, isolation, signal),
        claudeDriver: createClaudeAgentDriver, claudeRun: prepareClaudeAgentRun,
        runIsolated: (entry, spawn, bounds, signal, line) => runHeadlessIsolated(entry, isolation, spawn, bounds, signal, line) }, signal);
    },
  } satisfies NativeCliWorkerRuntime);
}
