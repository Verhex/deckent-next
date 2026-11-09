export {
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ INFERENCE_SERVING_SCHEMA_VERSION,
  inferenceServingConfigSchema,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ inferenceServingProfileSchema,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ inferenceBackendSchema,
  /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ inferenceTopologySchema,
  parseInferenceServingConfig,
  resolveActiveInferenceProfile,
  type InferenceServingConfig,
  type InferenceServingProfile,
  type InferenceRole,
} from './internal/contract.js';
