import type { ModelInvocationControllerHandle } from './controllers.js';
import { identitySchema, ModelInvocationError, modelActivationActorSchema, modelActivationAuthorizationSchema, parseModelInvocationCommand,
  parseModelInvocationNativeResult, parseModelInvocationPurgeCommand, parseModelInvocationControlRecord, type JsonObject, type ModelBindingDefinition, type ModelInvocationAuthorization,
  type ModelInvocationClaim, type ModelInvocationNativeResponse, type ModelInvocationNativeResult, type ModelInvocationProfile, type ModelInvocationReceipt,
  type ModelInvocationPurgeReceipt, type ModelReference, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelActivationReader } from '#engine/core/model-activation/index.js';
import type { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, parseModelInvocationAdmission,
  sameModelInvocationRequest, createModelInvocationClaimReceipt } from './evidence.js';
import { verifyModelInvocationResponseEvidence } from './response-evidence.js';
import { createModelInvocationPreventedRecord, createModelInvocationEvidenceRecord, createModelInvocationResponseRecord, createModelInvocationUnknownRecord,
  parseModelInvocationPurgeAdmission, verifyModelInvocationPurgeReceipt, verifyModelInvocationRecord } from './content.js';
import { assertInvocationDeliveryFit, assertInvocationEvidenceStorageFit, checkInvocationResultDelivery, validateInvocationDelivery, type ModelInvocationDelivery } from './delivery.js';
import { ModelInvocationStoreError, type ModelInvocationAdmission, type ModelInvocationClaimResult,
  type ModelInvocationRecord, type ModelInvocationStore } from './port.js';
import type { ModelInvocationPurgeResult, ModelInvocationPurgeStore } from './port.js';

export interface ModelInvocationAuthorizer {
  authorize(action: 'invoke' | 'inspect' | 'inspect-content' | 'purge-content' | 'cancel-invocation', target: { readonly scopeId: string; readonly reference: ModelReference },
    principal: VerifiedPrincipal): Promise<ModelInvocationAuthorization>;
}
export interface ModelInvocationProfileSource {
  resolve(scopeId: string, reference: ModelReference): Promise<ModelInvocationProfile | null>;
}
export interface ModelInvocationNativePort {
  /** Pure validation/serialization only: no network, credential lookup or other external effect. */
  prepare(profile: ModelInvocationProfile, definition: ModelBindingDefinition, nativeRequest: JsonObject): Promise<unknown>;
  /** Pure upper bound for serialized {schemaVersion,native,usage}; required by bounded result callers. */
  responseBytesUpperBound?(prepared: unknown): bigint;
  /** The only external transport operation. */
  send(prepared: unknown, signal?: AbortSignal): Promise<ModelInvocationNativeResult>;
}
export interface ModelInvocationNativeRegistry { resolve(profile: ModelInvocationProfile): ModelInvocationNativePort | null }
export interface ModelInvocationRuntime {
  invocationId(): string; ownerId(): string; now(): number;
  register?(claim: ModelInvocationClaim, ownerId: string): ModelInvocationControllerHandle;
}
export interface ModelInvocationResult { readonly replayed: boolean; readonly receipt: ModelInvocationReceipt;
  readonly response: ModelInvocationNativeResponse | null; readonly contentStatus: 'retained' | 'not-captured' | 'purged';
  readonly purge: ModelInvocationPurgeReceipt | null }

function exactReference(left: ModelReference, right: ModelReference): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function checkedResult(result: ModelInvocationClaimResult, command: ReturnType<typeof parseModelInvocationCommand>,
  requestDigest: string, actor: Parameters<typeof sameModelInvocationRequest>[3], admission?: ModelInvocationAdmission): ModelInvocationClaimResult {
  const record = verifyModelInvocationRecord(result.record);
  if (typeof result.replayed !== 'boolean' || !sameModelInvocationRequest(record.receipt, command, requestDigest, actor)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  const receipt = record.receipt;
  if (!result.replayed && receipt.outcome !== null) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  if (admission && !result.replayed && (!exactReference(receipt.request.reference, admission.command.reference)
    || receipt.claim.invocationId !== admission.invocationId || receipt.claim.profileDigest !== admission.profileDigest
    || receipt.activationRevision !== admission.activation.revision
    || JSON.stringify(receipt.authorization) !== JSON.stringify(admission.authorization)
    || JSON.stringify(receipt.profile) !== JSON.stringify(admission.profile)
    || JSON.stringify(receipt.definition) !== JSON.stringify(admission.definition))) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  return Object.freeze({ replayed: result.replayed, record });
}
function publicResult(replayed: boolean, recordInput: ModelInvocationRecord): ModelInvocationResult {
  const record = verifyModelInvocationRecord(recordInput), content = record.content;
  return Object.freeze({ replayed, receipt: record.receipt,
    response: content?.kind === 'native-response' ? content.response : null,
    contentStatus: record.purge ? 'purged' : content === null ? 'not-captured' : 'retained', purge: record.purge });
}

export class ModelInvocationPurgeApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly openStore: () => Promise<ModelInvocationPurgeStore>, private readonly runtime: Pick<ModelInvocationRuntime, 'now'>) {}
  async purge(input: unknown, credential?: unknown, delivery?: ModelInvocationDelivery): Promise<ModelInvocationPurgeResult> {
    validateInvocationDelivery(delivery);
    const command = parseModelInvocationPurgeCommand(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = modelActivationActorSchema.parse({ id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance });
    await this.authorization.authorize('purge-content', { scopeId: command.scopeId, reference: command.reference }, principal);
    const store = await this.openStore();
    try {
      const authorization = modelActivationAuthorizationSchema.parse(await this.authorization.authorize('purge-content',
        { scopeId: command.scopeId, reference: command.reference }, principal));
      const admission = parseModelInvocationPurgeAdmission({ command, actor, authorization, purgedAtMs: this.runtime.now() });
      const expectedReceipt = verifyModelInvocationPurgeReceipt({ schemaVersion: 1, ...admission });
      checkInvocationResultDelivery({ replayed: false, receipt: expectedReceipt }, delivery);
      const result = await store.purgeContent(admission);
      if (typeof result.replayed !== 'boolean') throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      const receipt = verifyModelInvocationPurgeReceipt(result.receipt);
      if (!isDeepStrictEqual(receipt.command, command) || !isDeepStrictEqual(receipt.actor, actor)
        || (!result.replayed && !isDeepStrictEqual(receipt, expectedReceipt))) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      return checkInvocationResultDelivery(Object.freeze({ replayed: result.replayed, receipt }), delivery);
    } finally { store.close(); }
  }
}

export class ModelInvocationApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly bindings: Pick<ModelBindingApplication, 'inspect'>, private readonly openActivationReader: () => Promise<ModelActivationReader>,
    private readonly profiles: ModelInvocationProfileSource, private readonly natives: ModelInvocationNativeRegistry,
    private readonly openStore: () => Promise<ModelInvocationStore>, private readonly runtime: ModelInvocationRuntime) {}

  async invoke(input: unknown, credential?: unknown, signal?: AbortSignal, delivery?: ModelInvocationDelivery): Promise<ModelInvocationResult> {
    validateInvocationDelivery(delivery);
    const command = parseModelInvocationCommand(input), requestDigest = modelInvocationRequestDigest(command);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = modelActivationActorSchema.parse({ id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance });
    modelActivationAuthorizationSchema.parse(await this.authorization.authorize('invoke',
      { scopeId: command.scopeId, reference: command.reference }, principal));
    const store = await this.openStore();
    try {
      const prior = await store.loadReceipt(command.scopeId, command.commandId);
      if (prior) {
        if (!sameModelInvocationRequest(prior.receipt, command, requestDigest, actor)) {
          throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        }
        return checkInvocationResultDelivery(publicResult(true, prior), delivery);
      }
      const binding = await this.bindings.inspect(command.reference);
      if (binding.status !== 'declared' || binding.catalogRevision !== command.catalogRevision
        || binding.binding.digest !== command.expectedBinding.digest) throw new ModelInvocationError('MODEL_INVOCATION_BINDING_CONFLICT');
      const activationReader = await this.openActivationReader(); let activation;
      try { activation = await activationReader.loadRecord(command.scopeId, command.reference); }
      finally { activationReader.close(); }
      if (!activation || activation.state !== 'active' || activation.catalogRevision !== command.catalogRevision
        || activation.binding.digest !== command.expectedBinding.digest) throw new ModelInvocationStoreError('MODEL_INVOCATION_ACTIVATION_CONFLICT');
      const profile = await this.profiles.resolve(command.scopeId, command.reference);
      if (!profile || profile.scopeId !== command.scopeId || !exactReference(profile.reference, command.reference)
        || profile.bindingDigest !== command.expectedBinding.digest
        || !binding.definition.model.protocols.some(protocol => protocol.family === profile.protocol.family
          && protocol.version === profile.protocol.version)) throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
      const native = this.natives.resolve(profile);
      if (!native) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
      const prepared = await native.prepare(profile, binding.definition, command.nativeRequest);
      if (signal?.aborted) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
      const authorization = modelActivationAuthorizationSchema.parse(await this.authorization.authorize('invoke',
        { scopeId: command.scopeId, reference: command.reference }, principal));
      const currentBinding = await this.bindings.inspect(command.reference), currentProfile = await this.profiles.resolve(command.scopeId, command.reference);
      if (currentBinding.status !== 'declared' || currentBinding.catalogRevision !== binding.catalogRevision
        || currentBinding.binding.digest !== binding.binding.digest || JSON.stringify(currentBinding.definition) !== JSON.stringify(binding.definition)
        || !currentProfile || modelInvocationProfileDigest(currentProfile) !== modelInvocationProfileDigest(profile)) {
        throw new ModelInvocationError('MODEL_INVOCATION_PROFILE_CONFLICT');
      }
      const admission = parseModelInvocationAdmission({ command, requestDigest, actor, authorization,
        definition: currentBinding.definition, activation, profile: currentProfile, profileDigest: modelInvocationProfileDigest(currentProfile),
        invocationId: identitySchema.parse(this.runtime.invocationId()), claimedAtMs: this.runtime.now() });
      const responseBound = delivery ? native.responseBytesUpperBound?.(prepared) : undefined;
      const prospectiveReceipt = createModelInvocationClaimReceipt(admission);
      assertInvocationEvidenceStorageFit(prospectiveReceipt);
      if (delivery) assertInvocationDeliveryFit(prospectiveReceipt, responseBound, delivery);
      const ownerId = identitySchema.parse(this.runtime.ownerId());
      const live = this.runtime.register?.(prospectiveReceipt.claim, ownerId);
      try {
        const claimResult = checkedResult(await store.claim(admission), command, requestDigest, actor, admission);
        if (claimResult.replayed) return checkInvocationResultDelivery(publicResult(true, claimResult.record), delivery);
        const claimReceipt = claimResult.record.receipt;
        const permission = await store.permitSend(claimReceipt.claim, ownerId, this.runtime.now());
        const control = parseModelInvocationControlRecord(permission.control), permittedRecord = verifyModelInvocationRecord(permission.record);
        if (typeof permission.granted !== 'boolean' || !isDeepStrictEqual(control.claim, claimReceipt.claim)
          || !isDeepStrictEqual(control.reference, claimReceipt.request.reference)
          || !isDeepStrictEqual({ ...permittedRecord.receipt, outcome: null }, claimReceipt)
          || (permission.granted && (control.send.state !== 'permitted' || control.send.ownerId !== ownerId
            || control.cancellation !== null || permittedRecord.receipt.outcome !== null))) {
          throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
        }
        if (!permission.granted) {
          // This invocation just created the claim. A denied permit can only complete it with an exact concurrent cancellation.
          if (control.send.state !== 'prevented' || !control.cancellation
            || !isDeepStrictEqual(permittedRecord, createModelInvocationPreventedRecord(claimReceipt, control.cancellation))) {
            throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
          }
          return checkInvocationResultDelivery(publicResult(false, permittedRecord), delivery);
        }
        let response;
        try {
          response = parseModelInvocationNativeResult(await native.send(prepared, live ? (signal ? AbortSignal.any([signal, live.signal]) : live.signal) : signal));
          if ('kind' in response) verifyModelInvocationResponseEvidence(response.evidence, profile);
          if (!('kind' in response) && responseBound !== undefined && BigInt(Buffer.byteLength(JSON.stringify(response), 'utf8')) > responseBound) {
            throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
          }
        } catch {
          try {
            const observedAtMs = this.runtime.now();
            const record = verifyModelInvocationRecord(await store.recordUnknown(claimReceipt.claim, 'transport-error', observedAtMs));
            if (!isDeepStrictEqual(record, createModelInvocationUnknownRecord(claimReceipt, observedAtMs))) {
              throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
            }
            return checkInvocationResultDelivery(publicResult(false, record), delivery);
          } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'); }
        }
        try {
          const observedAtMs = this.runtime.now();
          const record = verifyModelInvocationRecord('kind' in response
            ? response.evidence.body.complete
              ? await store.recordRejected(claimReceipt.claim, response.evidence, observedAtMs)
              : await store.recordUnknown(claimReceipt.claim, 'transport-error', observedAtMs, response.evidence)
            : await store.recordResponse(claimReceipt.claim, response, observedAtMs));
          const expected = 'kind' in response
            ? createModelInvocationEvidenceRecord(claimReceipt, response.evidence, observedAtMs)
            : createModelInvocationResponseRecord(claimReceipt, response, observedAtMs);
          if (!isDeepStrictEqual(record, expected)) throw new Error('CORRUPT');
          return checkInvocationResultDelivery(publicResult(false, record), delivery);
        } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'); }
      } finally { live?.release(); }
    } finally { store.close(); }
  }
}
import { isDeepStrictEqual } from 'node:util';
