import { productResourcePath, type ProductLayout, type ProductResource } from './resolve.js';

/** Shared read-only inspection; resolving a location does not create or verify that resource. */
export function inspectProductLayout(layout: ProductLayout) {
  const resources = Object.fromEntries((Object.keys(layout.resources) as ProductResource[])
    .map(resource => [resource, productResourcePath(layout, resource)])) as Record<ProductResource, string>;
  return Object.freeze({ schemaVersion: layout.schemaVersion, layoutRevision: layout.revision,
    root: layout.root, bootstrapConfigPath: layout.bootstrapConfigPath, resources: Object.freeze(resources) });
}
export type ProductPathInspection = ReturnType<typeof inspectProductLayout>;
