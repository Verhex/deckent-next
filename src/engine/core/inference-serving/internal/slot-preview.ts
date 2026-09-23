import type { InferenceServingProfile } from '#domain/index.js';
import { estimateReplicaCapacity, roleContextCeiling } from './capacity.js';
import { InferenceTokenBudget, type TokenReservationRequest } from './token-budget.js';

/**
 * One request against an empty local estimate. It does not reserve a shared endpoint and is not consulted by Run admission.
 */
export function previewEmptyInferenceSlot(profile: InferenceServingProfile, request: TokenReservationRequest): 'admitted' | 'wait' | 'rejected' {
  const capacity = estimateReplicaCapacity(profile);
  const budget = new InferenceTokenBudget(capacity.totalTokenBudget, role => roleContextCeiling(profile, role));
  const disposition = budget.tryReserve(request);
  budget.release(request.id);
  return disposition;
}
