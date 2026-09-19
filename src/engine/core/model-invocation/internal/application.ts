import { identitySchema, ModelInvocationError, modelActivationActorSchema, modelActivationAuthorizationSchema, parseModelInvocationCommand,
  parseModelInvocationNativeResponse, type JsonObject, type ModelBindingDefinition, type ModelInvocationAuthorization,
  type ModelInvocationNativeResponse, type ModelInvocationProfile, type ModelReference, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelActivationReader } from '#engine/core/model-activation/index.js';
import type { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, parseModelInvocationAdmission,
  sameModelInvocationRequest, verifyModelInvocationReceipt, createModelInvocationClaimReceipt } from './evidence.js';
import { assertInvocationDeliveryFit, checkInvocationResultDelivery, validateInvocationDelivery, type ModelInvocationDelivery } from './delivery.js';
import { ModelInvocationStoreError, type ModelInvocationAdmission, type ModelInvocationClaimResult,
  type ModelInvocationStore } from './port.js';

export interface ModelInvocationAuthorizer {
  authorize(action: 'invoke' | 'inspect', target: { readonly scopeId: string; readonly reference: ModelReference },
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
  send(prepared: unknown, signal?: AbortSignal): Promise<ModelInvocationNativeResponse>;
}
export interface ModelInvocationNativeRegistry { resolve(profile: ModelInvocationProfile): ModelInvocationNativePort | null }
export interface ModelInvocationRuntime { invocationId(): string; now(): number }
export interface ModelInvocationResult { readonly replayed: boolean; readonly receipt: ReturnType<typeof verifyModelInvocationReceipt> }

function exactReference(left: ModelReference, right: ModelReference): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function checkedResult(result: ModelInvocationClaimResult, command: ReturnType<typeof parseModelInvocationCommand>,
  requestDigest: string, actor: Parameters<typeof sameModelInvocationRequest>[3], admission?: ModelInvocationAdmission): ModelInvocationResult {
  if (typeof result.replayed !== 'boolean' || !sameModelInvocationRequest(result.receipt, command, requestDigest, actor)) {
    throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
  }
  const receipt = verifyModelInvocationReceipt(result.receipt);
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
  return Object.freeze({ replayed: result.replayed, receipt });
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
        if (!sameModelInvocationRequest(prior, command, requestDigest, actor)) {
          throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT');
        }
        const receipt = verifyModelInvocationReceipt(prior);
        return checkInvocationResultDelivery(Object.freeze({ replayed: true, receipt }), delivery);
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
      if (delivery) assertInvocationDeliveryFit(createModelInvocationClaimReceipt(admission), responseBound, delivery);
      const claimResult = checkedResult(await store.claim(admission), command, requestDigest, actor, admission);
      if (claimResult.replayed) return checkInvocationResultDelivery(claimResult, delivery);
      let response;
      try {
        response = parseModelInvocationNativeResponse(await native.send(prepared, signal));
        if (responseBound !== undefined && BigInt(Buffer.byteLength(JSON.stringify(response), 'utf8')) > responseBound) {
          throw new ModelInvocationStoreError('MODEL_INVOCATION_RESULT_LIMIT');
        }
      } catch {
        try {
          const receipt = verifyModelInvocationReceipt(await store.recordUnknown(claimResult.receipt.claim, 'transport-error', this.runtime.now()));
          if (receipt.outcome?.state !== 'unknown' || JSON.stringify(receipt.claim) !== JSON.stringify(claimResult.receipt.claim)
            || JSON.stringify({ ...receipt, outcome: null }) !== JSON.stringify(claimResult.receipt)) {
            throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
          }
          return Object.freeze({ replayed: false, receipt });
        } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'); }
      }
      try {
        const receipt = verifyModelInvocationReceipt(await store.recordResponse(claimResult.receipt.claim, response, this.runtime.now()));
        if (receipt.outcome?.state !== 'responded' || JSON.stringify(receipt.claim) !== JSON.stringify(claimResult.receipt.claim)
          || JSON.stringify(receipt.outcome.response) !== JSON.stringify(response)
          || JSON.stringify({ ...receipt, outcome: null }) !== JSON.stringify(claimResult.receipt)) throw new Error('CORRUPT');
        return Object.freeze({ replayed: false, receipt });
      } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_OUTCOME_UNKNOWN'); }
    } finally { store.close(); }
  }
}
