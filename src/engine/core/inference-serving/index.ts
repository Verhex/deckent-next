export { estimateReplicaCapacity, roleContextCeiling, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type ReplicaCapacityEstimate } from './internal/capacity.js';
export { buildInferenceServingPlan, type InferenceServingPlan } from './internal/plan.js';
export { InferenceTokenBudget, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type TokenBudgetState, type TokenReservationRequest } from './internal/token-budget.js';
export { loopbackMetricsUrl, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ type InferenceMetricsEndpoint } from './internal/metrics-endpoint.js';
export { previewEmptyInferenceSlot } from './internal/slot-preview.js';
export { InferenceServingError, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ readInferenceServingConfig, readInferenceServingProfile, selectInferenceProfile } from './internal/config-source.js';
