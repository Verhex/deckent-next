import { userInfo } from 'node:os';
import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { ModelInvocationStoreError } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

export async function loadInvocationContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions) {
  const context = await loadConfiguredScopeContext(projectRoot, scopeId, options);
  const layoutIdentity = JSON.stringify(context.layout);
  return Object.freeze({ ...context,
    policy: createLayoutPolicySource(context.layout, userInfo().uid, context.config.inspection.policyMaxBytes),
    async freshConfig() {
      const config = await loadConfig(projectRoot, { ...options, heal: false });
      if (JSON.stringify(config.productLayout) !== layoutIdentity) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
      return config;
    },
  });
}
