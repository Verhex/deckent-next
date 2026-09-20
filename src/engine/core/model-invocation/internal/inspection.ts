import { parseModelInvocationQuery, type ModelInvocationPurgeReceipt, type ModelInvocationQuery,
  type ModelInvocationReceipt, type ModelInvocationResponseContent } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelInvocationAuthorizer } from './application.js';
import { verifyModelInvocationRecord } from './content.js';
import { ModelInvocationStoreError, type ModelInvocationStore } from './port.js';
import { checkInvocationResultDelivery, validateInvocationDelivery, type ModelInvocationDelivery } from './delivery.js';

export type ModelInvocationInspection = Readonly<{ schemaVersion: 3; scopeId: string; invocationId: string;
  reference: ModelInvocationQuery['reference']; invocation: ModelInvocationReceipt | null;
  contentStatus: 'retained' | 'not-captured' | 'purged' | null; purge: ModelInvocationPurgeReceipt | null;
  responseContent?: ModelInvocationResponseContent | null }>;
export class ModelInvocationInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly openReader: () => Promise<Pick<ModelInvocationStore, 'loadInvocation' | 'close'>>) {}
  async inspect(input: unknown, credential?: unknown, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection> {
    validateInvocationDelivery(delivery);
    const query = parseModelInvocationQuery(input), principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', { scopeId: query.scopeId, reference: query.reference }, principal);
    if (query.includeResponseContent === true) await this.authorization.authorize('inspect-content',
      { scopeId: query.scopeId, reference: query.reference }, principal);
    const identity = { schemaVersion: 3 as const, scopeId: query.scopeId, invocationId: query.invocationId, reference: query.reference };
    const reader = await this.openReader();
    try {
      const stored = await reader.loadInvocation(query.scopeId, query.invocationId);
      if (!stored) return checkInvocationResultDelivery(Object.freeze({ ...identity, invocation: null, contentStatus: null, purge: null,
        ...(query.includeResponseContent === true ? { responseContent: null } : {}) }), delivery);
      const record = verifyModelInvocationRecord(stored), receipt = record.receipt;
      if (receipt.claim.scopeId !== query.scopeId || receipt.claim.invocationId !== query.invocationId
        || JSON.stringify(receipt.request.reference) !== JSON.stringify(query.reference)) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      return checkInvocationResultDelivery(Object.freeze({ ...identity, invocation: receipt,
        contentStatus: record.purge ? 'purged' : record.content === null ? 'not-captured' : 'retained', purge: record.purge,
        ...(query.includeResponseContent === true ? { responseContent: record.content } : {}) }), delivery);
    } finally { reader.close(); }
  }
}
