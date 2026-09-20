import type { ModelInvocationControllers } from './controllers.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { counterSchema, createImmutableJsonObjectSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS,
  modelActivationActorSchema, modelActivationAuthorizationSchema, modelInvocationCancellationCommandSchema,
  parseModelInvocationCancellationCommand, parseModelInvocationCancellationReceipt } from '#domain/index.js';
import { ModelInvocationStoreError, type ModelInvocationCancellationAdmission, type ModelInvocationCancellationStore, type ModelInvocationCancellationResult } from './port.js';
const envelope = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
const admission = z.object({ command: modelInvocationCancellationCommandSchema, actor: modelActivationActorSchema,
  authorization: modelActivationAuthorizationSchema, requestedAtMs: counterSchema }).strict().readonly();
export function parseModelInvocationCancellationAdmission(input: unknown): ModelInvocationCancellationAdmission {
  try { return admission.parse(envelope.parse(input)); }
  catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}

import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelInvocationAuthorizer, ModelInvocationRuntime } from './application.js';
import { verifyModelInvocationRecord } from './content.js';
import { checkInvocationResultDelivery, validateInvocationDelivery, type ModelInvocationDelivery } from './delivery.js';

/** Records intent under fresh policy; transport delivery belongs to the shared runtime, never the caller connection. */
export class ModelInvocationCancellationApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly openStore: () => Promise<ModelInvocationCancellationStore>, private readonly runtime: Pick<ModelInvocationRuntime, 'now'>,
    private readonly controllers?: Pick<ModelInvocationControllers, 'requestAbort'>) {}
  async cancel(input: unknown, credential?: unknown, delivery?: ModelInvocationDelivery): Promise<ModelInvocationCancellationResult> {
    validateInvocationDelivery(delivery);
    const command = parseModelInvocationCancellationCommand(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = modelActivationActorSchema.parse({ id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance });
    await this.authorization.authorize('cancel-invocation', command, principal);
    const store = await this.openStore();
    try {
      const loaded = await store.loadReceipt(command.scopeId, command.targetCommandId);
      if (!loaded) throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      const current = verifyModelInvocationRecord(loaded);
      if (current.receipt.claim.scopeId !== command.scopeId || current.receipt.claim.commandId !== command.targetCommandId
        || current.receipt.claim.requestDigest !== command.expectedRequestDigest
        || !isDeepStrictEqual(current.receipt.request.reference, command.reference)) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
      }
      const authorization = modelActivationAuthorizationSchema.parse(await this.authorization.authorize('cancel-invocation', command, principal));
      const admitted = parseModelInvocationCancellationAdmission({ command, actor, authorization, requestedAtMs: this.runtime.now() });
      // Longest disposition bounds the persisted command result, including exact server-resolved claim.
      checkInvocationResultDelivery({ replayed: false, receipt: { schemaVersion: 1, ...admitted,
        claim: current.receipt.claim, disposition: 'already-terminal' } }, delivery);
      const result = await store.cancelInvocation(admitted), receipt = parseModelInvocationCancellationReceipt(result.receipt);
      if (typeof result.replayed !== 'boolean' || !isDeepStrictEqual(receipt.command, command) || !isDeepStrictEqual(receipt.actor, actor)
        || !isDeepStrictEqual(receipt.claim, current.receipt.claim) || (!result.replayed
          && (!isDeepStrictEqual(receipt.authorization, admitted.authorization) || receipt.requestedAtMs !== admitted.requestedAtMs))) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      if (this.controllers) {
        const control = await store.loadControl(receipt.claim.scopeId, receipt.claim.invocationId);
        if (!control || !isDeepStrictEqual(control.cancellation, receipt)) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
        await this.authorization.authorize('cancel-invocation', command, principal);
        // Only local abort is requested. The durable receipt continues to describe intent, never remote completion.
        this.controllers.requestAbort(control);
      }
      return checkInvocationResultDelivery(Object.freeze({ replayed: result.replayed, receipt }), delivery);
    } finally { store.close(); }
  }
}
