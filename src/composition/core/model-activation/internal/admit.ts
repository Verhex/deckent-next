import { modelActivationCommandSchema, type ModelActivationCommand } from '#domain/index.js';
import { ModelActivationApplication, ModelActivationPolicyAuthorization, ModelBindingApplication,
  assessModelInvocationProfileDeliveries } from '#engine/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { configuredModelInvocationDeliverySurfaces } from '#composition/core/model-invocation/index.js';

/** Explicit local activation admission, not provider invocation. Store path is resolved only after the gate. */
export async function admitConfiguredModelActivation(projectRoot: string, input: ModelActivationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = modelActivationCommandSchema.parse(input);
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    // Adapter selection/wiring only (SESSION-RESULT-LIMIT-2026-09-28 review): the audit decision itself — which
    // declared profiles match this reference, whether any is unfit, refuse or not — lives in
    // ModelActivationApplication.admit (engine); this composition root only resolves the two surfaces' capacity
    // and wires the real size-math implementation in as `assess` (engine/core/model-activation cannot import
    // engine/core/model-invocation directly — that package already depends back on model-activation, so a
    // direct import would cycle; composition, which depends on both, is where the two meet).
    const app = new ModelActivationApplication({ async verify() { return principal; } },
      new ModelActivationPolicyAuthorization({ async load() { return document; } }),
      new ModelBindingApplication({ async read() { return config['provider_catalog']; } }),
      async () => openSqliteModelActivationStore(await path(), config.storage.sqlite, 'forbid'), Date.now,
      { profiles: config['provider_invocation_profiles'], surfaces: configuredModelInvocationDeliverySurfaces(config),
        assess: assessModelInvocationProfileDeliveries });
    return await app.admit(command);
  } catch (error) { throw queryFailure(error); }
}
