import type { OperationDescriptor } from '#domain/core/effect/index.js';

/** Where a catalog operation comes from. `core`: a module the Core composition passed at registry construction (its ids are Core's);
 * `module`: a registered overlay (owns only its namespace); `config`: the installation's `operations.catalog`. Provenance is data for
 * conflict decisions and inspection; it grants nothing (policy still decides every operation). */
export type OperationProvenance = { readonly source: 'core' | 'module'; readonly module: string } | { readonly source: 'config' };
export interface CatalogOperation { readonly descriptor: OperationDescriptor; readonly provenance: OperationProvenance }

export class OperationCatalogError extends Error {
  constructor(readonly code: 'OPERATION_TARGET_KIND_RESERVED' | 'OPERATION_CORE_REDEFINED' | 'OPERATION_CATALOG_CONFLICT' | 'OPERATION_NAMESPACE_RESERVED' | 'OPERATION_COMPENSATION_UNKNOWN',
    readonly subject: string) { super(`${code}: ${subject}`); this.name = 'OperationCatalogError'; }
}

export const operationKey = (operation: { readonly id: string; readonly version: number }) => `${operation.id}@${operation.version}`;
/** An id is inside a namespace's territory when it equals it or nests under it (`ns` or `ns.*`), never the other way round —
 * a config id sitting *above* a registered namespace is not this module's territory. */
const withinNamespace = (id: string, namespace: string) => id === namespace || id.startsWith(`${namespace}.`);

/**
 * Pure unification of the three operation sources into one catalog keyed by `id@version`, or a typed refusal. `registered` holds the
 * Core and module operations the registry already admitted among themselves (adds-only, namespaced); `configCatalog` and
 * `configTargetKinds` are the validated `operations` section; `moduleNamespaces` is every registered module's namespace (root or
 * overlay, `null` excluded). Check order (the first applicable refusal wins):
 *  1. a config target claims the target kind of a Core operation (it would route Core operations to a foreign target);
 *  2. a config entry uses the id of a Core operation at any version (the id is Core's; a new version is Core's new operation);
 *  3. the same `id@version` from two sources (config vs module, or twice in config);
 *  4. a config id lives inside a registered module's namespace — the module's territory even for an id it never declared itself
 *     (owner 2026-09-27 decision 7; checked after 3 so an exact `id@version` collision still reports the more specific conflict);
 *  5. an entry's compensation is not in the unified catalog.
 * A module cannot reach 2 or 3 against Core: admission already keeps its ids inside its own namespace (owner Q5, adds-only).
 */
export function unifyOperationCatalog(registered: readonly CatalogOperation[], configCatalog: readonly OperationDescriptor[],
  configTargetKinds: readonly string[], moduleNamespaces: readonly string[]): ReadonlyMap<string, CatalogOperation> {
  const core = registered.filter(entry => entry.provenance.source === 'core');
  const reservedKinds = new Set(core.map(entry => entry.descriptor.targetKind));
  for (const kind of configTargetKinds) if (reservedKinds.has(kind)) throw new OperationCatalogError('OPERATION_TARGET_KIND_RESERVED', kind);
  const coreIds = new Set(core.map(entry => entry.descriptor.operation.id));
  for (const descriptor of configCatalog) if (coreIds.has(descriptor.operation.id)) throw new OperationCatalogError('OPERATION_CORE_REDEFINED', operationKey(descriptor.operation));
  const catalog = new Map<string, CatalogOperation>();
  const add = (entry: CatalogOperation) => {
    const key = operationKey(entry.descriptor.operation);
    if (catalog.has(key)) throw new OperationCatalogError('OPERATION_CATALOG_CONFLICT', key);
    catalog.set(key, entry);
  };
  for (const entry of registered) add(entry);
  for (const descriptor of configCatalog) add({ descriptor, provenance: { source: 'config' } });
  for (const descriptor of configCatalog) {
    if (moduleNamespaces.some(namespace => withinNamespace(descriptor.operation.id, namespace))) {
      throw new OperationCatalogError('OPERATION_NAMESPACE_RESERVED', operationKey(descriptor.operation));
    }
  }
  for (const [key, entry] of catalog) {
    if (entry.descriptor.compensation && !catalog.has(operationKey(entry.descriptor.compensation))) throw new OperationCatalogError('OPERATION_COMPENSATION_UNKNOWN', key);
  }
  return catalog;
}
