import { ModelInvocationError, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import { resolveModelUse } from '#engine/index.js';
import { createNativeAgentDriver, nativeCliAgentBridge, nativeEgressLimits, shellSandboxCapabilities } from '#adapters/index.js';
import { modelUseReadPorts } from '#composition/core/model-use/index.js';
import { configuredNativeChatReadiness } from '#composition/core/subscription-readiness/index.js';
import { globalStateRoot, type ConfigLoadOptions } from '#platform/index.js';
import type { NativeChatRuntime } from './native.js';

/** Production assembly only; no wire flag, preflight, login or model call at construction. */
export function createConfiguredNativeChatRuntime(projectRoot: string, options: ConfigLoadOptions = {}): NativeChatRuntime | undefined {
  const bridge = nativeCliAgentBridge(), egress = nativeEgressLimits();
  if (!bridge?.maxConnections || !bridge.replayMaxEntries || !bridge.replayMaxBytes || bridge.maxConnections >= egress.connections) return undefined;
  const ports = modelUseReadPorts(options);
  const pinModel = (profile: ModelInvocationProfile, actor: VerifiedPrincipal) => resolveModelUse(ports, projectRoot, profile, actor, { action: 'pin' });
  const pins = new WeakMap<object, NonNullable<Awaited<ReturnType<typeof pinModel>>>>();
  const runtime: NativeChatRuntime = { readiness: configuredNativeChatReadiness(projectRoot, options),
    limits: { idleMs: egress.idleMs, maxConnections: bridge.maxConnections, replayMaxEntries: bridge.replayMaxEntries, replayMaxBytes: bridge.replayMaxBytes },
    async resolveModelUse(profile, actor, check) {
      if (check.action === 'pin') {
        const pin = await pinModel(profile, actor);
        if (!pin) return null;
        pins.set(pin, pin); return pin;
      }
      const pin = pins.get(check.pin);
      if (!pin) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
      await resolveModelUse(ports, projectRoot, profile, actor, { action: 'recheck', pin });
    },
    driver: async input => createNativeAgentDriver({ ...input, now: Date.now,
      isolation: async () => (await shellSandboxCapabilities(globalStateRoot(options.env ?? process.env))).bubblewrap }),
  };
  return Object.freeze(runtime);
}
