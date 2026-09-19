import { userInfo } from 'node:os';
import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { ModelInvocationStoreError } from '#engine/index.js';
import type { LocalPeerIdentity } from '#adapters/index.js';
import { loadConfiguredScopeContext, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';

export async function loadInvocationContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions) {
  const context = await loadConfiguredScopeContext(projectRoot, scopeId, options);
  return withFreshPolicy(projectRoot, options, context);
}
export async function loadPeerInvocationContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions, peer: LocalPeerIdentity) {
  const context = await loadConfiguredPeerScopeContext(projectRoot, scopeId, options, peer);
  return withFreshPolicy(projectRoot, options, context);
}
function withFreshPolicy(projectRoot: string, options: ConfigLoadOptions, context: Awaited<ReturnType<typeof loadConfiguredScopeContext>>) {
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
