import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { operationDescriptorSchema } from '#domain/core/effect/index.js';
import { operationKey } from './catalog.js';

/** Version of the Core port contract a target adapter module binds to (`EffectTarget`, `OperationCatalog`). Bumps only when
 * those ports change incompatibly; a manifest whose range excludes it is refused before anything is registered. */
export const CORE_API_VERSION = 1;
/** Tier is descriptive distribution data (which edition ships the module); it never grants authority or namespace ownership. */
export const moduleTierSchema = z.enum(['core', 'base', 'enterprise', 'custom', 'user']);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Room for signed Enterprise manifests (owner Q7). Present in v1 so the shape need not change; verification arrives with A04-3,
 * and until then a non-null signature is refused rather than accepted unverified. */
export const manifestSignatureSchema = z.object({ algorithm: z.literal('ed25519'), keyId: identitySchema, digest, value: z.string().min(1).max(4096) }).strict().readonly();
/** Manifest v1: pure data describing one adapter module. Every level, including the `provides` collections, is frozen on parse so
 * an admitted manifest cannot be edited through a returned reference (Astra 2126 R2). `namespace: null` means the root (unprefixed ids) and is only honoured
 * for modules the Core composition passes at registry construction; overlays must own a dotted namespace. Adapter and operation
 * ids provided by a namespaced module must live under `<namespace>.`. `provides.operations` are validated for the adds-only rule
 * (no redefinition of a registered `id@version`) and feed the unified catalog (A04-2) next to the config catalog. */
export const adapterModuleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  module: z.object({ id: identitySchema, version: identitySchema, tier: moduleTierSchema, namespace: identitySchema.nullable() }).strict().readonly(),
  requires: z.object({ coreApi: z.object({ min: z.number().int().positive().safe(), max: z.number().int().positive().safe() }).strict()
    .refine(range => range.max >= range.min).readonly() }).strict().readonly(),
  provides: z.object({
    targetAdapters: z.array(z.object({ adapterId: identitySchema, version: z.number().int().positive().safe() }).strict().readonly()).max(64).readonly(),
    operations: z.array(operationDescriptorSchema).max(1024).readonly(),
  }).strict().readonly(),
  signature: manifestSignatureSchema.nullable(),
}).strict().readonly();
export type AdapterModuleManifest = z.infer<typeof adapterModuleManifestSchema>;
export type ModuleTier = z.infer<typeof moduleTierSchema>;

export class RegistryError extends Error {
  constructor(readonly code: 'REGISTRY_MANIFEST_INVALID' | 'REGISTRY_SIGNATURE_UNSUPPORTED' | 'REGISTRY_CORE_API_UNSUPPORTED'
    | 'REGISTRY_NAMESPACE_RESERVED' | 'REGISTRY_MODULE_DUPLICATE' | 'REGISTRY_NAMESPACE_SHADOWED' | 'REGISTRY_ID_OUTSIDE_NAMESPACE'
    | 'REGISTRY_ADAPTER_DUPLICATE' | 'REGISTRY_ADAPTER_UNKNOWN' | 'REGISTRY_OPERATION_REDEFINED' | 'REGISTRY_FACTORY_MISMATCH' | 'REGISTRY_SEALED'
    | 'REGISTRY_OPTIONS_INVALID' | 'REGISTRY_OPTIONS_ASYNC', options?: ErrorOptions) {
    super(code, options); this.name = 'RegistryError';
  }
}

const moduleKey = (manifest: AdapterModuleManifest) => `${manifest.module.id}@${manifest.module.version}`;
const within = (id: string, namespace: string) => id.startsWith(`${namespace}.`);
const overlaps = (a: string, b: string) => a === b || within(a, b) || within(b, a);
const rootIds = (manifest: AdapterModuleManifest) => [...manifest.provides.targetAdapters.map(adapter => adapter.adapterId), ...manifest.provides.operations.map(entry => entry.operation.id)];

/** Pure admission of one manifest against the already admitted set. `root` is true only for modules the Core composition passes
 * at construction: it is the sole grant of unprefixed ids, so a manifest cannot claim the root through its own data.
 * Check order (each refusal is typed and the first applicable one wins): schema → signature → Core API range → root/reserved →
 * duplicate module id@version → namespace shadowing → ids inside the namespace → duplicate adapter id → operation redefinition. */
export function admitModuleManifest(admitted: readonly AdapterModuleManifest[], candidate: unknown, root: boolean): AdapterModuleManifest {
  const parsed = adapterModuleManifestSchema.safeParse(candidate);
  if (!parsed.success) throw new RegistryError('REGISTRY_MANIFEST_INVALID', { cause: parsed.error });
  const manifest = parsed.data;
  if (manifest.signature !== null) throw new RegistryError('REGISTRY_SIGNATURE_UNSUPPORTED');
  if (CORE_API_VERSION < manifest.requires.coreApi.min || CORE_API_VERSION > manifest.requires.coreApi.max) throw new RegistryError('REGISTRY_CORE_API_UNSUPPORTED');
  if (!root && (manifest.module.namespace === null || manifest.module.tier === 'core')) throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
  if (admitted.some(existing => moduleKey(existing) === moduleKey(manifest))) throw new RegistryError('REGISTRY_MODULE_DUPLICATE');
  const namespace = manifest.module.namespace;
  if (namespace !== null) {
    for (const existing of admitted) {
      if (existing.module.namespace !== null && overlaps(existing.module.namespace, namespace)) throw new RegistryError('REGISTRY_NAMESPACE_SHADOWED');
      if (existing.module.namespace === null && rootIds(existing).some(id => overlaps(id, namespace))) throw new RegistryError('REGISTRY_NAMESPACE_SHADOWED');
    }
    if (rootIds(manifest).some(id => !within(id, namespace))) throw new RegistryError('REGISTRY_ID_OUTSIDE_NAMESPACE');
  }
  const adapters = new Set<string>();
  for (const id of manifest.provides.targetAdapters.map(adapter => adapter.adapterId)) {
    if (adapters.has(id) || admitted.some(existing => existing.provides.targetAdapters.some(adapter => adapter.adapterId === id))) throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    adapters.add(id);
  }
  const operations = new Set<string>();
  for (const key of manifest.provides.operations.map(entry => operationKey(entry.operation))) {
    if (operations.has(key) || admitted.some(existing => existing.provides.operations.some(entry => operationKey(entry.operation) === key))) throw new RegistryError('REGISTRY_OPERATION_REDEFINED');
    operations.add(key);
  }
  return manifest;
}
