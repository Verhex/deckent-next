import { createNativeCodingTemplate, detectNativeCliVersion, nativeCliAgent, openSqliteInventoryReader, headlessCapacityBinding, readHeadlessSealedVersion } from '#adapters/index.js';
import { configureNativeTemplate, initializeNativeRegistry, addNativeProfile, resolveNativeTemplateConnection, type NativeTemplatePorts } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { configPersonWitness, createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { modelUseReadPorts } from '#composition/core/model-use/index.js';
type Dependencies = { readonly beforeWrite?: () => void | Promise<void>; readonly detect?: NativeTemplatePorts['detect']; readonly witness?: { attest(): Promise<boolean> } };
function ports(root: string, options: ConfigLoadOptions, dependencies: Dependencies): NativeTemplatePorts {
  return { snapshot: () => snapshotConfiguredConfig(root, { ...options, heal: false }),
    principal: scope => resolveConfiguredConfigPrincipal(root, scope, options),
    writer: guard => createConfiguredConfigApplication(root, options, guard), template: createNativeCodingTemplate,
    connection: (snapshot, id, provider) => resolveNativeTemplateConnection(root, snapshot.effective, id, provider, modelUseReadPorts(options), nativeCliAgent, async (context, definition) => {
      const reader = await openSqliteInventoryReader(await context.path(), { busyTimeoutMs: context.config.storage.sqlite.busyTimeoutMs });
      try { return await reader.findCapacityResource(headlessCapacityBinding(definition)); } finally { reader.close(); }
    }), observed: worker => readHeadlessSealedVersion(worker.definition), detect: dependencies.detect ?? detectNativeCliVersion, witness: configPersonWitness(dependencies.witness),
    ...(dependencies.beforeWrite ? { beforeWrite: dependencies.beforeWrite } : {}) };
}
export function configureNativeCodingTemplate(root: string, input: unknown, options: ConfigLoadOptions = {}, dependencies: Omit<Dependencies, 'detect'> = {}) {
  return configureNativeTemplate(input, ports(root, options, dependencies));
}
export function initializeNativeCodingRegistry(root: string, input: unknown, options: ConfigLoadOptions = {}, dependencies: Dependencies = {}) {
  return initializeNativeRegistry(input, ports(root, options, dependencies));
}
export function addNativeCodingProfile(root: string, input: unknown, options: ConfigLoadOptions = {}, dependencies: Dependencies = {}) {
  return addNativeProfile(input, ports(root, options, dependencies));
}
export type { CodingTemplateRequest, CodingTemplateResult } from '#engine/index.js';
