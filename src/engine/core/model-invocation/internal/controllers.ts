import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { identitySchema, modelInvocationClaimSchema, parseModelInvocationControlRecord,
  type ModelInvocationClaim, type ModelInvocationControlRecord } from '#domain/index.js';
import { ModelInvocationStoreError } from './port.js';

interface Entry {
  readonly claim: ModelInvocationClaim;
  readonly ownerId: string;
  readonly controller: AbortController;
  readonly handle: symbol;
}
export interface ModelInvocationControllerHandle { readonly signal: AbortSignal; release(): void }
export type ModelInvocationAbortResult = 'abort-requested' | 'already-requested' | 'not-live' | 'not-needed';
const key = (claim: ModelInvocationClaim): string => JSON.stringify([claim.scopeId, claim.invocationId]);

/** Process-local transport custody only; durable permission and cancellation remain store-owned. */
export class ModelInvocationControllers {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) throw new RangeError('MODEL_INVOCATION_CONTROLLERS_INVALID');
  }

  register(claimInput: ModelInvocationClaim, ownerInput: string): ModelInvocationControllerHandle {
    let claim: ModelInvocationClaim; let ownerId: string;
    try { claim = modelInvocationClaimSchema.parse(claimInput); ownerId = identitySchema.parse(ownerInput); }
    catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
    const entryKey = key(claim);
    if (this.entries.has(entryKey)) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
    if (this.entries.size >= this.maxConcurrent) throw new ModelInvocationStoreError('MODEL_INVOCATION_CAPACITY_EXHAUSTED');
    const entry: Entry = { claim, ownerId, controller: new AbortController(), handle: Symbol('model-invocation-controller') };
    this.entries.set(entryKey, entry);
    return Object.freeze({ signal: entry.controller.signal, release: () => {
      if (this.entries.get(entryKey)?.handle === entry.handle) this.entries.delete(entryKey);
    } });
  }

  requestAbort(controlInput: ModelInvocationControlRecord): ModelInvocationAbortResult {
    let control: ModelInvocationControlRecord;
    try { control = parseModelInvocationControlRecord(controlInput); }
    catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
    if (control.send.state !== 'permitted' || control.cancellation?.disposition !== 'requested') return 'not-needed';
    const entry = this.entries.get(key(control.claim));
    if (!entry) return 'not-live';
    if (!isDeepStrictEqual(entry.claim, control.claim) || entry.ownerId !== control.send.ownerId) {
      throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
    }
    if (entry.controller.signal.aborted) return 'already-requested';
    entry.controller.abort();
    return 'abort-requested';
  }
}

/**
 * The send owner a runtime-service instance records on the calls it permits: `runtime-service:<custodyId>:<instanceId>`, where
 * `custodyId` names the endpoint custody the instance holds (the guard socket's digest; FIX-2143-SLOTS, Astra 2145 R1). Only the
 * service host mints it. Custody of one endpoint proves only that no instance is alive on THAT endpoint (the runtime socket is a
 * configurable layout resource; a second endpoint may share the ledger), so an owner is proven ended only by a start holding the very
 * custody the owner names.
 */
const RUNTIME_SERVICE_OWNER = 'runtime-service:';
const custodyIdSchema = identitySchema.pipe(z.string().regex(/^[0-9a-f]{64}$/));
export function runtimeServiceModelOwnerId(custodyId: string, instanceId: string): string {
  return identitySchema.parse(`${RUNTIME_SERVICE_OWNER}${custodyIdSchema.parse(custodyId)}:${identitySchema.parse(instanceId)}`);
}
/** The start-time proof for the custody held now: true only for an owner minted under this exact `custodyId`. Any other owner (another
 * endpoint's instance, a host-less direct call, an earlier unpublished shape without custody) stays unproven, so its call keeps its slot. */
export function endedRuntimeServiceModelOwner(custodyId: string): (ownerId: string) => boolean {
  const prefix = `${RUNTIME_SERVICE_OWNER}${custodyIdSchema.parse(custodyId)}:`;
  return ownerId => typeof ownerId === 'string' && ownerId.length > prefix.length && ownerId.startsWith(prefix)
    && identitySchema.safeParse(ownerId).success;
}
