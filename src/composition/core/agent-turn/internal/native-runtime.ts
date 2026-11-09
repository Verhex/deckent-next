import { ModelInvocationError, type ModelInvocationProfile, type VerifiedPrincipal } from '#domain/index.js';
import { pinCurrentModelUse, recheckCurrentModelUse } from '#engine/index.js';
import { createNativeAgentDriver, preflightNativeAgent, nativeBridgeLimits } from '#adapters/index.js';
import { modelUseReadPorts } from '#composition/core/model-use/index.js';
import { configuredBubblewrap } from '#composition/core/model-invocation/index.js';
import { configuredNativeChatReadiness } from '#composition/core/subscription-readiness/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { NativeChatRuntime } from './native.js';

/** Production assembly only; no wire flag, preflight, login or model call at construction. */
export function createConfiguredNativeChatRuntime(projectRoot: string, options: ConfigLoadOptions = {}): NativeChatRuntime | undefined {
  const limits = nativeBridgeLimits(), isolation = configuredBubblewrap(options);
  if (!limits) return undefined;
  const ports = modelUseReadPorts(options);
  const pinModel = (profile: ModelInvocationProfile, actor: VerifiedPrincipal) => pinCurrentModelUse(ports, projectRoot, profile, actor);
  const pins = new WeakMap<object, NonNullable<Awaited<ReturnType<typeof pinModel>>>>();
  const runtime: NativeChatRuntime = { readiness: configuredNativeChatReadiness(projectRoot, options), limits,
    async resolveModelUse(profile, actor, check) {
      if (check.action === 'pin') {
        const pin = await pinModel(profile, actor);
        if (!pin) return null;
        pins.set(pin, pin); return pin;
      }
      const pin = pins.get(check.pin);
      if (!pin) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
      await recheckCurrentModelUse(ports, projectRoot, profile, actor, pin);
    },
    async preflight(profile, signal) { await preflightNativeAgent(profile, Date.now, isolation, signal); },
    driver: async input => createNativeAgentDriver({ ...input, now: Date.now, isolation }),
  };
  return Object.freeze(runtime);
}
