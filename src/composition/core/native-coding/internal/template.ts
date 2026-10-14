import { createNativeCodingTemplate, detectNativeCliVersion } from '#adapters/index.js';
import { configureNativeTemplate, initializeNativeRegistry, type NativeTemplatePorts } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig } from '#composition/core/config/index.js';
function ports(root: string, options: ConfigLoadOptions, dependencies: { readonly beforeWrite?: () => void | Promise<void>; readonly detect?: NativeTemplatePorts['detect'] }): NativeTemplatePorts {
  return { snapshot: () => snapshotConfiguredConfig(root, { ...options, heal: false }),
    principal: scope => resolveConfiguredConfigPrincipal(root, scope, options),
    writer: guard => createConfiguredConfigApplication(root, options, guard), template: createNativeCodingTemplate,
    detect: dependencies.detect ?? detectNativeCliVersion,
    ...(dependencies.beforeWrite ? { beforeWrite: dependencies.beforeWrite } : {}) };
}
export function configureNativeCodingTemplate(root: string, input: unknown, options: ConfigLoadOptions = {}, dependencies: { readonly beforeWrite?: () => void | Promise<void> } = {}) {
  return configureNativeTemplate(input, ports(root, options, dependencies));
}
export function initializeNativeCodingRegistry(root: string, input: unknown, options: ConfigLoadOptions = {}, dependencies: { readonly beforeWrite?: () => void | Promise<void>; readonly detect?: NativeTemplatePorts['detect'] } = {}) {
  return initializeNativeRegistry(input, ports(root, options, dependencies));
}
export type { CodingTemplateRequest, CodingTemplateResult } from '#engine/index.js';
