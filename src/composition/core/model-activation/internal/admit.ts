import { modelActivationCommandSchema, type ModelActivationCommand } from '#domain/index.js';
import { ModelActivationApplication, ModelActivationPolicyAuthorization, ModelBindingApplication } from '#engine/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

/** Explicit local activation admission, not provider invocation. Store path is resolved only after the gate. */
export async function admitConfiguredModelActivation(projectRoot: string, input: ModelActivationCommand, options: ConfigLoadOptions = {}) {
  try {
    const command = modelActivationCommandSchema.parse(input);
    const { config, document, principal, path } = await loadConfiguredScopeContext(projectRoot, command.scopeId, options);
    const app = new ModelActivationApplication({ async verify() { return principal; } },
      new ModelActivationPolicyAuthorization({ async load() { return document; } }),
      new ModelBindingApplication({ async read() { return config['provider_catalog']; } }),
      async () => openSqliteModelActivationStore(await path(), config.storage.sqlite, 'forbid'), Date.now);
    return await app.admit(command);
  } catch (error) { throw queryFailure(error); }
}
