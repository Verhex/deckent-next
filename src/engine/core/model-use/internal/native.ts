import type { ModelInvocationNativePort } from '#engine/core/model-invocation/index.js';
/** Native CLI credentials remain in the original login directory; revocation is checked before every spawn/send. */
export function guardModelUseNative(port: ModelInvocationNativePort, check: () => Promise<unknown>): ModelInvocationNativePort {
  return { ...port,
    async send(...args) { await check(); return port.send(...args); },
    ...(port.measure ? { async measure(...args: Parameters<NonNullable<ModelInvocationNativePort['measure']>>) { await check(); return port.measure!(...args); } } : {}),
  };
}
