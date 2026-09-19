export { MODEL_ACTIVATION_SCHEMA_VERSION, MODEL_ACTIVATION_TARGET_ENCODING_VERSION, MODEL_ACTIVATION_TARGET_PREFIX,
  encodeModelActivationTarget, modelActivationActorSchema, modelActivationAuthorizationSchema, modelActivationBindingSchema,
  modelActivationCommandSchema, modelActivationReceiptSchema, modelActivationRecordSchema, parseModelActivationCommand,
  parseModelActivationReceipt, parseModelActivationRecord, parseModelActivationReference, ModelActivationError } from './internal/contract.js';
export type { ModelActivationActor, ModelActivationAuthorization, ModelActivationBinding, ModelActivationCommand,
  ModelActivationReceipt, ModelActivationRecord, ModelActivationErrorCode } from './internal/contract.js';
export { transitionModelActivation } from './internal/transition.js';
export { modelActivationQuerySchema, parseModelActivationQuery } from './internal/query.js';
export type { ModelActivationQuery } from './internal/query.js';
