export { NATIVE_MODEL_ID_MAX_LENGTH, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PROVIDER_CATALOG_SCHEMA_VERSION, PROVIDER_CATALOG_WIRE_LIMITS,
  ProviderCatalogError, parseProviderCatalog, providerCatalogObjectSchema, providerProtocolSchema } from './internal/catalog.js';
export type { ProviderCatalog, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ProviderCatalogErrorCode } from './internal/catalog.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_BINDING_ENCODING_VERSION, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_BINDING_PREFIX, encodeModelBindingDefinition,
  resolveParsedModelBindingDefinition, encodeParsedModelBindingDefinition, modelReferenceSchema, parseModelBindingDefinition, parseModelReference, resolveModelBindingDefinition } from './internal/binding.js';
export type { ModelBindingDefinition, ModelReference } from './internal/binding.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ PROVIDER_CATALOG_DOCUMENT_SCHEMA_VERSION, CATALOG_CHANNEL_KINDS, NATIVE_CLI_CHANNELS, MODEL_LIFECYCLE_STATES, REASONING_EFFORTS, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ EXACT_MODEL_ID_MAX_LENGTH,
  exactModelIdSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelLifecycleSchema, catalogChannelSchema, catalogModelSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ providerCatalogDocumentSchema,
  parseProviderCatalogDocument, reportedNameConflict, connectTermsMisplaced, catalogPinModelEvidence, workerModelPinEvidenceShape } from './internal/catalog-document.js';
export { reportedModelNameSchema, catalogTariffSealSchema, promptFramingAllowanceSchema } from './internal/catalog-metadata.js';
export type { CatalogTariffLookup, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ CatalogTariffSeal } from './internal/catalog-metadata.js';
export type { ProviderCatalogDocument, CatalogChannel, CatalogModel, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelLifecycle, CatalogPinModelEvidence } from './internal/catalog-document.js';

export { providerIdSchema, nativeCliIds, nativeCliIdSchema, modelUsageEvidenceSchema, readLegacyModelUsageEvidence } from './internal/native-cli.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ NativeCliId, ModelUsageEvidence } from './internal/native-cli.js';
export { NativeCliRegistryError, nativeCliVocabulary, INSTRUCTION_SURFACE_PATHS, instructionSurfacePaths, frozenHiddenPaths } from './internal/native-cli.js';

export { workerEffortSchema } from './internal/worker-effort.js';
export { endpointMayCarryKey } from './internal/endpoint-key.js';
export type { WorkerEffort, ReasoningEffort } from './internal/worker-effort.js';
export { MODEL_TIERS, MODEL_ROLE_LIMITS, CORE_MODEL_ROLES, ModelRoleError, modelRoleRegistrySchema, modelRoleConfigSchema, mergeModelRoleRegistries, decideRoleModel, eligibleRoleModels,
  roleModelKey } from './internal/model-role.js';
export type { ModelTier, ModelRoleRegistry, ModelRolePolicy, ModelRoleErrorCode, RoleModelTarget, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ RoleModelFacts, RoleModelRefusal, RoleModelDecision,
  RoleModelRow } from './internal/model-role.js';
export { MODEL_MAKERS, canonicalModelMaker, makersIndependent, independentMakerRows } from './internal/model-maker.js';
