import { CORE_API_VERSION, adapterModuleManifestSchema, type AdapterModuleManifest } from '#domain/index.js';
import type { AdapterModuleRegistration } from '#engine/index.js';
import { HttpConditionalEffectTarget, httpConditionalEffectOptionsSchema } from './target.js';

/** Core registry entry for the generic conditional-write HTTP target. Same shape an Enterprise/ERP package ships next to its
 * adapter; being a Core (root-namespace) entry comes from composition passing it at registry construction, not from `tier`. */
export const httpConditionalAdapterManifest: AdapterModuleManifest = adapterModuleManifestSchema.parse({
  schemaVersion: 1, module: { id: 'core.http-conditional-effect', version: '1', tier: 'core', namespace: null },
  requires: { coreApi: { min: CORE_API_VERSION, max: CORE_API_VERSION } },
  provides: { targetAdapters: [{ adapterId: 'http-conditional', version: 1 }], operations: [] },
  signature: null,
});
export const httpConditionalAdapterModule: AdapterModuleRegistration = Object.freeze({
  manifest: httpConditionalAdapterManifest,
  factories: Object.freeze({ 'http-conditional': Object.freeze({ optionsSchema: httpConditionalEffectOptionsSchema, create: (options: unknown) => new HttpConditionalEffectTarget(options) }) }),
});
