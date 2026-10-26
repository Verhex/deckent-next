import { createNativeCodingTemplate, detectNativeCliVersion } from '#adapters/index.js';
import { configureNativeTemplate, initializeNativeRegistry, addNativeProfile, type NativeTemplatePorts } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { configPersonWitness, createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig } from '#composition/core/config/index.js';
/** `witness` (alpha.55.1): the person's terminal witness of an apply (the engine `AuthorityWitness` shape, kept structural so the published
 * declarations do not reach the config composition); the default is this process's controlling terminal. */
type Dependencies = { readonly beforeWrite?: () => void | Promise<void>; readonly detect?: NativeTemplatePorts['detect']; readonly witness?: { attest(): Promise<boolean> } };
function ports(root: string, options: ConfigLoadOptions, dependencies: Dependencies): NativeTemplatePorts {
  return { snapshot: () => snapshotConfiguredConfig(root, { ...options, heal: false }),
    principal: scope => resolveConfiguredConfigPrincipal(root, scope, options),
    writer: guard => createConfiguredConfigApplication(root, options, guard), template: createNativeCodingTemplate,
    detect: dependencies.detect ?? detectNativeCliVersion, witness: configPersonWitness(dependencies.witness),
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
