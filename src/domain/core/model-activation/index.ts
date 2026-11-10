export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_ACTIVATION_SCHEMA_VERSION, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_ACTIVATION_TARGET_ENCODING_VERSION, MODEL_ACTIVATION_TARGET_PREFIX,
  encodeModelActivationTarget, modelActivationActorSchema, modelActivationAuthorizationSchema, modelActivationBindingSchema,
  modelActivationCommandSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelActivationReceiptSchema, modelActivationRecordSchema, parseModelActivationCommand,
  parseModelActivationReceipt, parseModelActivationRecord, parseModelActivationReference, ModelActivationError } from './internal/contract.js';
export type { ModelActivationActor, ModelActivationAuthorization, ModelActivationBinding, ModelActivationCommand,
  ModelActivationReceipt, ModelActivationRecord, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelActivationErrorCode } from './internal/contract.js';
export { transitionModelActivation } from './internal/transition.js';
export { modelActivationQuerySchema, parseModelActivationQuery } from './internal/query.js';
export type { ModelActivationQuery } from './internal/query.js';
export { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_CATALOG_SCHEMA_VERSION, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_CATALOG_TARGET_PREFIX, ModelCatalogError, catalogModelRetired, retiredModelActivationRefusal, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelCatalogTargetSchema, modelCatalogCommandSchema, modelCatalogQuerySchema,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelCatalogChannelRecordSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelCatalogModelRecordSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelCatalogActivationRecordSchema, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ modelCatalogReceiptSchema,
  parseModelCatalogCommand, parseModelCatalogReceipt, parseModelCatalogChannelRecord, parseModelCatalogModelRecord,
  parseModelCatalogActivationRecord, encodeModelCatalogTarget, modelCatalogTargets, planModelCatalogRegistration,
  transitionModelCatalogActivation } from './internal/catalog.js';
export type { /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ModelCatalogErrorCode, ModelCatalogCommand, ModelCatalogTarget, ModelCatalogChannelRecord, ModelCatalogModelRecord,
  ModelCatalogActivationRecord, ModelCatalogReceipt, ModelCatalogChange, ModelCatalogQuery } from './internal/catalog.js';
export { MODEL_CONNECT_OPERATION_ID, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ MODEL_CONNECT_SCHEMA_VERSION, modelConnectCommandSchema } from './internal/connect.js';
export type { ModelConnectCommand, ModelConnectResult, ModelConnectStepState } from './internal/connect.js';
export type { SubscriptionConnectionRequest, SubscriptionConnectionResult, SubscriptionConnectionInspection } from './internal/connect.js';
