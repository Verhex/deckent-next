import { parseModelInvocationQuery, type ModelInvocationQuery, type ModelInvocationReceipt } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelInvocationAuthorizer } from './application.js';
import { verifyModelInvocationReceipt } from './evidence.js';
import { ModelInvocationStoreError, type ModelInvocationStore } from './port.js';
import { checkInvocationResultDelivery, validateInvocationDelivery, type ModelInvocationDelivery } from './delivery.js';

export type ModelInvocationInspection = Readonly<{ schemaVersion: 1; scopeId: string; invocationId: string;
  reference: ModelInvocationQuery['reference']; invocation: ModelInvocationReceipt | null }>;
export class ModelInvocationInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly openReader: () => Promise<Pick<ModelInvocationStore, 'loadInvocation' | 'close'>>) {}
  async inspect(input: unknown, credential?: unknown, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection> {
    validateInvocationDelivery(delivery);
    const query = parseModelInvocationQuery(input), principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', { scopeId: query.scopeId, reference: query.reference }, principal);
    const reader = await this.openReader();
    try {
      const stored = await reader.loadInvocation(query.scopeId, query.invocationId);
      if (!stored) return checkInvocationResultDelivery(Object.freeze({ ...query, invocation: null }), delivery);
      const receipt = verifyModelInvocationReceipt(stored);
      if (receipt.claim.scopeId !== query.scopeId || receipt.claim.invocationId !== query.invocationId
        || JSON.stringify(receipt.request.reference) !== JSON.stringify(query.reference)) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      return checkInvocationResultDelivery(Object.freeze({ ...query, invocation: receipt }), delivery);
    } finally { reader.close(); }
  }
}
