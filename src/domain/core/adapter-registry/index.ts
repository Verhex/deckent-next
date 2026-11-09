export { CORE_API_VERSION, adapterModuleManifestSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ manifestSignatureSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ moduleTierSchema, RegistryError, admitModuleManifest } from './internal/manifest.js';
export type { AdapterModuleManifest, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModuleTier } from './internal/manifest.js';
export { OperationCatalogError, operationKey, unifyOperationCatalog } from './internal/catalog.js';
export type { CatalogOperation, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ OperationProvenance } from './internal/catalog.js';
