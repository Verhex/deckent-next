import type { VerifiedPrincipal } from '#domain/index.js';
import type { ModelBindingDefinition, ModelInvocationProfile, ModelReference } from '#domain/index.js';
import { parseModelActivationCommand, modelActivationActorSchema, modelActivationAuthorizationSchema, modelInvocationProfileSchema,
  type ModelActivationAuthorization } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { parseModelActivationAdmission, sameModelActivationRequest, verifyModelActivationReceipt } from './evidence.js';
import { ModelActivationStoreError, type ModelActivationResult, type ModelActivationStore } from './port.js';

export interface ModelActivationAuthorizer {
  authorize(action: 'activate' | 'deactivate' | 'inspect', target: { readonly scopeId: string; readonly reference: ModelReference },
    principal: VerifiedPrincipal): Promise<ModelActivationAuthorization>;
}
/**
 * SESSION-RESULT-LIMIT-2026-09-28: optional — omitted, `admit` behaves exactly as before. When supplied, `admit`
 * refuses to activate a reference for which an already-declared invocation profile could never deliver its
 * worst-case result on any surface. `assess` is injected rather than imported directly: engine/core/model-invocation
 * already depends on engine/core/model-activation (verifyModelActivationRecord), so this package importing back
 * would cycle; composition wires `assessModelInvocationProfileDeliveries` (#engine/index.js) as `assess`, keeping
 * the accept/reject decision itself here while the size-math implementation stays in model-invocation, single-sourced.
 */
export interface ModelActivationDeliverySurface { readonly maxResultBytes: number }
export interface ModelActivationDeliveryTarget {
  readonly profile: ModelInvocationProfile;
  readonly definition: ModelBindingDefinition;
  readonly catalogRevision: string;
}
export interface ModelActivationInvocationDelivery {
  /** Raw `provider_invocation_profiles` config value, as composition read it (parsed here, never by the caller). */
  readonly profiles: unknown;
  readonly surfaces: readonly (readonly [string, ModelActivationDeliverySurface])[];
  assess(targets: readonly ModelActivationDeliveryTarget[],
    surfaces: readonly (readonly [string, ModelActivationDeliverySurface])[]): readonly { readonly requiredBytes: number }[];
}
function exactReference(left: ModelReference, right: ModelReference): boolean { return JSON.stringify(left) === JSON.stringify(right); }
export class ModelActivationApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelActivationAuthorizer,
    private readonly bindings: Pick<ModelBindingApplication, 'inspect'>,
    private readonly openStore: () => Promise<ModelActivationStore>, private readonly now: () => number,
    private readonly invocationDelivery?: ModelActivationInvocationDelivery) {}
  async admit(input: unknown, credential?: unknown): Promise<ModelActivationResult> {
    const command = parseModelActivationCommand(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = modelActivationActorSchema.parse({ id: principal.id, issuer: principal.issuer,
      subject: principal.subject, assurance: principal.assurance });
    const authorization = modelActivationAuthorizationSchema.parse(await this.authorization.authorize(command.action,
      { scopeId: command.scopeId, reference: command.reference }, principal));
    // No store or catalog read precedes the fresh gate. Historical replay does not require a surviving declaration.
    const store = await this.openStore();
    try {
      const prior = await store.loadReceipt(command.scopeId, command.commandId);
      if (prior) {
        if (!sameModelActivationRequest(prior, command, actor)) throw new ModelActivationStoreError('MODEL_ACTIVATION_COMMAND_CONFLICT');
        return Object.freeze({ replayed: true, receipt: verifyModelActivationReceipt(prior) });
      }
      let definition: ModelBindingDefinition | undefined;
      if (command.action === 'activate') {
        const observed = await this.bindings.inspect(command.reference);
        if (observed.status !== 'declared' || observed.catalogRevision !== command.catalogRevision
          || observed.binding.digest !== command.expectedBinding.digest) throw new ModelActivationStoreError('MODEL_ACTIVATION_CATALOG_CONFLICT');
        definition = observed.definition;
        // SESSION-RESULT-LIMIT-2026-09-28: a profile already declared for this reference would fail every
        // line-mode/MCP invocation forever once this activation makes it reachable; refuse now, before any
        // store write. No profile yet (the common case: profiles are set up separately) is not a finding —
        // there is nothing to protect yet, and doctor stays the ongoing authority (drift after activation).
        if (this.invocationDelivery) {
          const configured = this.invocationDelivery.profiles as { profiles?: unknown[] } | undefined;
          const targets = (configured?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value))
            .filter(profile => profile.scopeId === command.scopeId && exactReference(profile.reference, command.reference))
            .map(profile => ({ profile, definition: observed.definition, catalogRevision: observed.catalogRevision }));
          if (this.invocationDelivery.assess(targets, this.invocationDelivery.surfaces).length > 0) {
            throw new ModelActivationStoreError('MODEL_ACTIVATION_DELIVERY_UNFIT');
          }
        }
      }
      const admission = parseModelActivationAdmission({ command, actor, authorization, admittedAtMs: this.now(),
        ...(definition === undefined ? {} : { definition }) });
      const result = await store.admit(admission), receipt = verifyModelActivationReceipt(result.receipt);
      if (typeof result.replayed !== 'boolean' || !sameModelActivationRequest(receipt, command, actor)
        || (!result.replayed && (JSON.stringify(receipt.authorization) !== JSON.stringify(authorization)
          || receipt.admittedAtMs !== admission.admittedAtMs))) throw new ModelActivationStoreError('MODEL_ACTIVATION_CORRUPT');
      return Object.freeze({ replayed: result.replayed, receipt });
    } finally { store.close(); }
  }
}
