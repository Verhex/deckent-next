import { nativeCodingDependencyLayout, openSqliteInventoryReader, selectNativePackageProfile } from '#adapters/index.js';
import { inspectNativePackageInputs, nativePackageAdmission } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { configuredPackageList, configuredWorkerPackagePorts } from '#composition/core/workspace-patch/index.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
export function nativeInputAdmission(root: string, context: Context, options: ConfigLoadOptions) {
  return nativePackageAdmission(configuredWorkerPackagePorts(root, options), context, selectNativePackageProfile);
}

export async function produceConfiguredNativeInputs(root: string, scopeId: string, options: ConfigLoadOptions, cachePath?: string) {
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
  return { ...await configuredPackageList(root, context, scopeId, options, cachePath), layout: nativeCodingDependencyLayout() };
}

export async function inspectConfiguredNativeInputs(root: string, scopeId: string, options: ConfigLoadOptions = {}, runId?: string) {
  const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
  return inspectNativePackageInputs(configuredWorkerPackagePorts(root, options), context, scopeId, selectNativePackageProfile,
    async () => openSqliteInventoryReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs }), runId);
}
