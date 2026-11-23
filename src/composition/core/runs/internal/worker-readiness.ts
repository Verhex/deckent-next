import { executionRegistrySchema } from '#domain/index.js';
import { inspectWorkerReadiness, composeModelRolePolicy, connectedModelProfile } from '#engine/index.js';
import { compileNativeCodingWorkInput, isNativeCodingTemplate, nativeCodingTemplateWorker, nativeCliWorkerBindingSchema, openSqliteModelCatalogReader } from '#adapters/index.js';
import { inspectNativeStateCustody, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { isToolchainRefreshInProgress } from '#composition/core/toolchains/index.js';

/** Observation only: no model activation, worker, reservation or provider call. */
export async function inspectConfiguredWorkerReadiness(root: string, scopeId: string, options: ConfigLoadOptions, targetKind: string) {
  const context = await loadConfiguredScopeContext(root, scopeId, { ...options, heal: false }, 'read'), { config } = context;
  const registry = executionRegistrySchema.safeParse(config.admission?.registry);
  if (!registry.success) return { ready: false, code: 'RUN_ADMISSION_NOT_CONFIGURED', cli: ['deckent', 'setup'] };
  const reader = await openSqliteModelCatalogReader(await context.path(), { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs });
  try {
    return await inspectWorkerReadiness(registry.data, registry.data.profiles.filter(isNativeCodingTemplate).map(profile => ({ profile, ...nativeCodingTemplateWorker(profile) })), reader,
      { scopeId, nowMs: Date.now(), imageRefreshInProgress: await isToolchainRefreshInProgress(root, options), roles: composeModelRolePolicy(config['model_roles']) },
      (template, input, evidence) => compileNativeCodingWorkInput(template, input, undefined, evidence), async (template, model) => {
        const binding = nativeCliWorkerBindingSchema.safeParse(template.parameters['worker']);
        if (!binding.success) return true;
        const connection = await connectedModelProfile(config, scopeId, binding.data, model);
        if (!connection) return false;
        return await inspectNativeStateCustody(connection.definition, options.env) === 'outside-installation'
          ? { ready: false, code: 'HEADLESS_STATE_OUTSIDE_INSTALLATION', cli: ['deckent', 'models', 'login', '--connection', model.channelId] } : true;
      }, targetKind);
  } finally { reader.close(); }
}
