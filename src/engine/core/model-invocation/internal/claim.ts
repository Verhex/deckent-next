import { ProviderSpendError } from '#engine/core/provider-spend/index.js';
import type { ModelInvocationAdmission, ModelInvocationClaimResult, ModelInvocationStore } from './port.js';
import { sameModelInvocationRequest } from './evidence.js';
import { verifyModelInvocationRecord } from './content.js';

/** Two identical commands can acquire different tariff observations before either claims.
 * A conflict never replaces the winner's quote. Read its durable result; the caller still validates
 * request and actor identity through checkedResult before exposing a replay. Other failures propagate.
 */
export async function claimModelInvocation(store: ModelInvocationStore,
  admission: ModelInvocationAdmission): Promise<ModelInvocationClaimResult> {
  try { return await store.claim(admission); }
  catch (error) {
    if (!(error instanceof ProviderSpendError) || error.code !== 'PROVIDER_SPEND_CONFLICT') throw error;
    const prior = await store.loadReceipt(admission.command.scopeId, admission.command.commandId);
    if (!prior) throw error;
    const record = verifyModelInvocationRecord(prior);
    if (!sameModelInvocationRequest(record.receipt, admission.command, admission.requestDigest, admission.actor)) throw error;
    return Object.freeze({ replayed: true, record });
  }
}
