import { isDeepStrictEqual } from 'node:util';
import { parseModelInvocationControlRecord, parseModelInvocationQuery, type ModelInvocationControlRecord, type ModelInvocationPurgeReceipt, type ModelInvocationQuery,
  type ModelInvocationReceipt, type ModelInvocationResponseContent } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelInvocationAuthorizer } from './application.js';
import { verifyModelInvocationRecord } from './content.js';
import { ModelInvocationStoreError, type ModelInvocationRecord } from './port.js';
import { checkInvocationResultDelivery, validateInvocationDelivery, type ModelInvocationDelivery } from './delivery.js';

export interface ModelInvocationInspectionRecord { readonly record: ModelInvocationRecord; readonly control: ModelInvocationControlRecord }
export interface ModelInvocationInspectionReader {
  loadInspection(scopeId: string, invocationId: string): Promise<ModelInvocationInspectionRecord | null>;
  close(): void;
}
export type ModelInvocationInspection = Readonly<{ schemaVersion: 5; scopeId: string; invocationId: string;
  reference: ModelInvocationQuery['reference']; invocation: ModelInvocationReceipt | null;
  control: ModelInvocationControlRecord | null;
  historyIntegrity: 'not-recorded';
  contentStatus: 'retained' | 'not-captured' | 'purged' | null; purge: ModelInvocationPurgeReceipt | null;
  responseContent?: ModelInvocationResponseContent | null }>;
export class ModelInvocationInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly openReader: () => Promise<ModelInvocationInspectionReader>) {}
  async inspect(input: unknown, credential?: unknown, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection> {
    validateInvocationDelivery(delivery);
    const query = parseModelInvocationQuery(input), principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', { scopeId: query.scopeId, reference: query.reference }, principal);
    if (query.includeResponseContent === true) await this.authorization.authorize('inspect-content',
      { scopeId: query.scopeId, reference: query.reference }, principal);
    const identity = { schemaVersion: 5 as const, scopeId: query.scopeId, invocationId: query.invocationId, reference: query.reference,
      historyIntegrity: 'not-recorded' as const };
    const reader = await this.openReader();
    try {
      const stored = await reader.loadInspection(query.scopeId, query.invocationId);
      if (!stored) return checkInvocationResultDelivery(Object.freeze({ ...identity, invocation: null, control: null, contentStatus: null, purge: null,
        ...(query.includeResponseContent === true ? { responseContent: null } : {}) }), delivery);
      const record = verifyModelInvocationRecord(stored.record), receipt = record.receipt;
      const control = verifyModelInvocationInspectionControl(receipt, stored.control);
      if (receipt.claim.scopeId !== query.scopeId || receipt.claim.invocationId !== query.invocationId
        || JSON.stringify(receipt.request.reference) !== JSON.stringify(query.reference)) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      return checkInvocationResultDelivery(Object.freeze({ ...identity, invocation: receipt, control,
        contentStatus: record.purge ? 'purged' : record.content === null ? 'not-captured' : 'retained', purge: record.purge,
        ...(query.includeResponseContent === true ? { responseContent: record.content } : {}) }), delivery);
    } finally { reader.close(); }
  }
}

export function verifyModelInvocationInspectionControl(receipt: ModelInvocationReceipt, input: unknown): ModelInvocationControlRecord {
  try {
    const control = parseModelInvocationControlRecord(input), outcome = receipt.outcome, cancellation = control.cancellation;
    if (!isDeepStrictEqual(control.claim, receipt.claim) || !isDeepStrictEqual(control.reference, receipt.request.reference)
      || (control.send.state === 'pending' && outcome !== null)
      || ((outcome?.state === 'not-sent') !== (control.send.state === 'prevented'))
      || (outcome?.state === 'not-sent' && (outcome.cancellationCommandId !== cancellation?.command.commandId
        || outcome.observedAtMs !== cancellation.requestedAtMs))
      || (cancellation?.disposition === 'already-terminal' && outcome?.state !== 'responded' && outcome?.state !== 'rejected')) {
      throw new Error();
    }
    return control;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}
