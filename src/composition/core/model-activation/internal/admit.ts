import { modelActivationCommandSchema, type ModelActivationCommand } from '#domain/index.js';
import { ModelActivationApplication, ModelActivationPolicyAuthorization, ModelBindingApplication } from '#engine/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { assessModelInvocationProfileDeliverySurfaces, configuredModelInvocationDeliverySurfaces,
  configuredModelInvocationProfiles } from '#composition/core/model-invocation/index.js';

/** Explicit local activation admission, not provider invocation. Store path is resolved only after the gate. */
export async function admitConfiguredModelActivation(projectRoot: string, input: ModelActivationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = modelActivationCommandSchema.parse(input);
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options, 'write');
    const bindings = new ModelBindingApplication({ async read() { return config['provider_catalog']; } });
    // SESSION-RESULT-LIMIT-2026-09-28: a profile already declared for this reference would fail every line-mode/MCP
    // invocation forever once this activation makes it reachable; an activating owner should see that now, not
    // after. No profile yet (the common case: profiles are set up separately) is not a finding — there is nothing
    // to protect yet, and doctor stays the ongoing authority (e.g. service.responseMaxBytes shrinking later).
    if (command.action === 'activate') {
      const surfaces = configuredModelInvocationDeliverySurfaces(config);
      for (const profile of configuredModelInvocationProfiles(config, command.scopeId, command.reference)) {
        const binding = await bindings.inspect(profile.reference);
        if (binding.status !== 'declared') continue;
        const first = assessModelInvocationProfileDeliverySurfaces(profile, binding.definition, binding.catalogRevision, surfaces)[0];
        if (first) throw ErrorRegistry.createError('MODEL_ACTIVATION_DELIVERY_UNFIT', { params: { profileId: first.profileId,
          surface: first.surface, requiredBytes: first.requiredBytes, availableBytes: first.availableBytes } });
      }
    }
    const app = new ModelActivationApplication({ async verify() { return principal; } },
      new ModelActivationPolicyAuthorization({ async load() { return document; } }), bindings,
      async () => openSqliteModelActivationStore(await path(), config.storage.sqlite, 'forbid'), Date.now);
    return await app.admit(command);
  } catch (error) { throw queryFailure(error); }
}
