import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { identitySchema, parseModelInvocationControlRecord } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelInvocationAuthorizer } from './application.js';
import type { ModelInvocationControllers, ModelInvocationAbortResult } from './controllers.js';
import { modelInvocationCancellationInventoryQuerySchema, modelInvocationCancellationRecoveryCommandSchema,
  type ModelInvocationCancellationInventory, type ModelInvocationCancellationInventoryEntry } from './cancellation-inventory.js';
import { verifyModelInvocationReceipt } from './evidence.js';
import { ModelInvocationStoreError } from './port.js';

const entrySchema = z.object({ receipt: z.unknown(), control: z.unknown() }).strict();
const pageSchema = z.object({ entries: z.array(entrySchema), nextAfterInvocationId: identitySchema.nullable() }).strict();
export type ModelInvocationCancellationRecoveryStatus = ModelInvocationAbortResult | 'denied' | 'failed';
export interface ModelInvocationCancellationRecoveryOutcome { readonly invocationId: string;
  readonly status: ModelInvocationCancellationRecoveryStatus }
export interface ModelInvocationCancellationRecoveryPage { readonly nextAfterInvocationId: string | null;
  readonly outcomes: readonly ModelInvocationCancellationRecoveryOutcome[] }

function bytesCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
function invalid(): never { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
function validatedEntry(input: z.infer<typeof entrySchema>, scopeId: string): ModelInvocationCancellationInventoryEntry {
  try {
    const receipt = verifyModelInvocationReceipt(input.receipt), control = parseModelInvocationControlRecord(input.control);
    const cancellation = control.cancellation, outcome = receipt.outcome;
    if (receipt.claim.scopeId !== scopeId || !isDeepStrictEqual(control.claim, receipt.claim)
      || !isDeepStrictEqual(control.reference, receipt.request.reference) || !cancellation
      || cancellation.disposition !== 'requested' || (control.send.state !== 'permitted' && control.send.state !== 'unobserved')
      || (outcome !== null && outcome.state !== 'unknown')
      || cancellation.command.scopeId !== scopeId || cancellation.command.targetCommandId !== receipt.claim.commandId
      || cancellation.command.expectedRequestDigest !== receipt.claim.requestDigest
      || !isDeepStrictEqual(cancellation.command.reference, receipt.request.reference)
      || !isDeepStrictEqual(cancellation.claim, receipt.claim)) invalid();
    return Object.freeze({ receipt, control });
  } catch (error) {
    if (error instanceof ModelInvocationStoreError) throw error;
    return invalid();
  }
}

export class ModelInvocationCancellationRecoveryApplication {
  private readonly maxPageSize: number;
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly openInventory: () => Promise<ModelInvocationCancellationInventory>,
    private readonly controllers: Pick<ModelInvocationControllers, 'requestAbort'>, options: { readonly maxPageSize: number }) {
    if (!modelInvocationCancellationInventoryQuerySchema.safeParse({ schemaVersion: 1, scopeId: 'validation',
      afterInvocationId: null, limit: options.maxPageSize }).success) {
      throw new RangeError('MODEL_INVOCATION_CANCELLATION_RECOVERY_INVALID');
    }
    this.maxPageSize = options.maxPageSize;
  }

  async recover(input: unknown, credential?: unknown): Promise<ModelInvocationCancellationRecoveryPage> {
    const command = modelInvocationCancellationRecoveryCommandSchema.parse(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const inventory = await this.openInventory();
    try {
      const raw = pageSchema.parse(await inventory.inspectCancellationInventory({ ...command, limit: this.maxPageSize }));
      if (raw.entries.length > this.maxPageSize) invalid();
      const entries = raw.entries.map(entry => validatedEntry(entry, command.scopeId));
      let prior = command.afterInvocationId;
      for (const entry of entries) {
        const current = entry.receipt.claim.invocationId;
        if (prior !== null && bytesCompare(current, prior) <= 0) invalid();
        prior = current;
      }
      if ((raw.nextAfterInvocationId === null) !== (entries.length === 0)
        || (entries.length > 0 && raw.nextAfterInvocationId !== entries.at(-1)!.receipt.claim.invocationId)) invalid();

      const outcomes: ModelInvocationCancellationRecoveryOutcome[] = [];
      for (const entry of entries) {
        let status: ModelInvocationCancellationRecoveryStatus;
        try {
          await this.authorization.authorize('cancel-invocation', entry.control.cancellation!.command, principal);
          status = entry.control.send.state === 'unobserved' ? 'not-live' : this.controllers.requestAbort(entry.control);
        } catch (error) {
          status = error && typeof error === 'object' && 'code' in error && error.code === 'POLICY_DENIED' ? 'denied' : 'failed';
        }
        outcomes.push(Object.freeze({ invocationId: entry.receipt.claim.invocationId, status }));
      }
      return Object.freeze({ nextAfterInvocationId: raw.nextAfterInvocationId, outcomes: Object.freeze(outcomes) });
    } finally { inventory.close(); }
  }
}
