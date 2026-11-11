import { userInfo } from 'node:os';
import { contextPolicySource } from '#composition/core/policy/index.js';
import { readConfigFileSnapshot, inspectInstallationSourceFiles } from '#adapters/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { DeclaredModelsApplication, ModelBindingApplication, PolicyAuthorizationError } from '#engine/index.js';
import type { ConfigLoadOptions, ResolvedConfig } from '#platform/index.js';
import { loadConfiguredScopeContext, resolveConfiguredScopeMembership, type inspectConfiguredInstallationSource } from '#composition/core/scoped-request/index.js';

/** Display only, owned by one window inspection. Never pass this to an action or keep credential values here. */
export async function openModelInspection(root: string, scopeId: string, options: ConfigLoadOptions, signal?: AbortSignal) {
  const lifetime = new AbortController();
  const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const configs = new Map<string, Promise<ResolvedConfig>>(), scopes = new Map<string, ReturnType<typeof loadConfiguredScopeContext>>();
  const catalogs = new Map<ResolvedConfig, Promise<{ declared: Awaited<ReturnType<DeclaredModelsApplication['inspect']>>; bindings: ModelBindingApplication }>>();
  const policies = new Map<ResolvedConfig, ReturnType<ReturnType<typeof contextPolicySource>['load']>>();
  const layers = new Map<string, ReturnType<typeof readConfigFileSnapshot>>();
  const configFor = (root: string) => {
    active.throwIfAborted();
    let value = configs.get(root);
    if (!value) { value = loadComposedConfig(root, { ...options, heal: false }); configs.set(root, value); }
    return value;
  };
  const policyFor = (config: ResolvedConfig) => {
    active.throwIfAborted(); let value = policies.get(config);
    if (!value) { value = contextPolicySource({ layout: config.productLayout, config, ownerUid: userInfo().uid }).load(); policies.set(config, value); }
    return value;
  };
  const inspectSource: typeof inspectConfiguredInstallationSource = async (root, scopeId, actor) => {
    const config = await configFor(root), document = await policyFor(config);
    return inspectInstallationSourceFiles(config, scopeId, actor, async () => { await resolveConfiguredScopeMembership(config, document, actor, [scopeId], 'read'); });
  };
  const contextFor = (root: string, scopeId: string) => {
    active.throwIfAborted();
    // Includes identity.installation/project for this opening's display checks; actions re-read context outside this snapshot.
    const key = JSON.stringify([root, scopeId]); let value = scopes.get(key);
    if (!value) { value = configFor(root).then(async config => loadConfiguredScopeContext(root, scopeId, options, 'read', { config, document: await policyFor(config).catch(() => { throw new PolicyAuthorizationError('POLICY_UNAVAILABLE'); }), inspectSource })); scopes.set(key, value); }
    return value;
  };
  const catalogFor = (config: ResolvedConfig) => {
    active.throwIfAborted();
    let value = catalogs.get(config);
    if (!value) { value = new DeclaredModelsApplication({ read: async () => config['provider_catalog'] }).inspect()
      .then(declared => ({ declared, bindings: new ModelBindingApplication({ read: async () => undefined }, declared.catalog) })); catalogs.set(config, value); }
    return value;
  };
  const documentsFor = (root: string) => {
    active.throwIfAborted();
    let value = layers.get(root);
    if (!value) { value = configFor(root).then(config => readConfigFileSnapshot(root, options, 'project', config)); layers.set(root, value); }
    return value;
  };
  const dispose = () => { configs.clear(); scopes.clear(); catalogs.clear(); layers.clear(); policies.clear(); active.removeEventListener('abort', dispose); lifetime.abort(); };
  active.addEventListener('abort', dispose, { once: true });
  const config = await configFor(root), { declared, bindings } = await catalogFor(config);
  return Object.freeze({ dispose, root, scopeId, config, declared, bindings, inspectSource, configFor, contextFor, catalogFor, documentsFor,
    documents: () => documentsFor(root), context: () => contextFor(root, scopeId),
  });
}
export type ModelInspectionSnapshot = Awaited<ReturnType<typeof openModelInspection>>;
