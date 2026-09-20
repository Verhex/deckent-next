import { identitySchema, type ModelInvocationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError, verifyModelInvocationReceipt } from '#engine/core/model-invocation/index.js';
import { parseModelAllocationCheckpoint, type ModelAllocationCheckpoint } from './checkpoint.js';

export interface ModelAllocationIntegrityQuery {
  readonly scopeId: string; readonly allocationId: string;
  readonly checkpoint: ModelAllocationCheckpoint | null; readonly afterInvocationId: string | null; readonly limit: number;
}
export interface ModelAllocationIntegrityPage {
  readonly checkpoint: ModelAllocationCheckpoint;
  readonly receipts: readonly ModelInvocationReceipt[];
  readonly nextInvocationId: string | null;
}
export interface ModelAllocationIntegrityReader {
  readPage(query: ModelAllocationIntegrityQuery): Promise<ModelAllocationIntegrityPage | null>;
  close(): void;
}
export const MODEL_ALLOCATION_INTEGRITY_PAGE_MAX = 1000;
export function validateModelAllocationPageSize(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MODEL_ALLOCATION_INTEGRITY_PAGE_MAX) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
}
/** Counts retained invocation records, including pre-spending records; it grants no runtime admission. */
export async function verifyModelAllocationIntegrity(reader: ModelAllocationIntegrityReader, scopeId: string,
  allocationId: string, pageSize: number, signal?: AbortSignal) {
  if (!identitySchema.safeParse(scopeId).success || !identitySchema.safeParse(allocationId).success) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  validateModelAllocationPageSize(pageSize);
  let checkpoint: ModelAllocationCheckpoint | null = null, cursor: string | null = null, lifetimeCalls = 0, inFlight = 0;
  for (;;) {
    if (signal?.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    const page = await reader.readPage({ scopeId, allocationId, checkpoint, afterInvocationId: cursor, limit: pageSize });
    if (signal?.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
    if (!page) {
      if (checkpoint) throw new ModelInvocationStoreError('MODEL_INVOCATION_ALLOCATION_CONFLICT');
      return Object.freeze({ status: 'not-found' as const });
    }
    const current = parseModelAllocationCheckpoint(page.checkpoint), allocation = current.allocation;
    if (allocation.scopeId !== scopeId || allocation.allocationId !== allocationId) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    if (checkpoint && checkpoint.digest !== current.digest) throw new ModelInvocationStoreError('MODEL_INVOCATION_ALLOCATION_CONFLICT');
    checkpoint = current;
    if (!Array.isArray(page.receipts) || page.receipts.length > pageSize || (cursor !== null && page.receipts.length === 0)) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
    for (const input of page.receipts) {
      const receipt = verifyModelInvocationReceipt(input), profile = receipt.profile.allocation, id = receipt.claim.invocationId;
      if (receipt.claim.scopeId !== scopeId || profile.id !== allocationId || profile.maxCalls !== allocation.maxCalls
        || profile.maxInFlight !== allocation.maxInFlight || (cursor !== null && Buffer.compare(Buffer.from(id), Buffer.from(cursor)) <= 0)) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      cursor = id; lifetimeCalls++;
      const state = receipt.outcome?.state;
      if (state === undefined || state === 'unknown') inFlight++;
      if (lifetimeCalls > allocation.lifetimeCalls || inFlight > allocation.inFlight) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
    if (page.nextInvocationId !== null) {
      if (page.receipts.length !== pageSize || page.nextInvocationId !== cursor) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      continue;
    }
    if (lifetimeCalls !== allocation.lifetimeCalls || inFlight !== allocation.inFlight) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    return Object.freeze({ status: 'consistent' as const, checkpoint, lifetimeCalls, inFlight });
  }
}
