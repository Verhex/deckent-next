import type { VerifiedPrincipal } from '#domain/index.js';
import type { ModelReference } from '#domain/index.js';
import { parseModelActivationCommand, modelActivationActorSchema, modelActivationAuthorizationSchema,
  type ModelActivationAuthorization } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { parseModelActivationAdmission, sameModelActivationRequest, verifyModelActivationReceipt } from './evidence.js';
import { ModelActivationStoreError, type ModelActivationResult, type ModelActivationStore } from './port.js';

export interface ModelActivationAuthorizer {
  authorize(action: 'activate' | 'deactivate', target: { readonly scopeId: string; readonly reference: ModelReference },
    principal: VerifiedPrincipal): Promise<ModelActivationAuthorization>;
}
export class ModelActivationApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelActivationAuthorizer,
    private readonly bindings: Pick<ModelBindingApplication, 'inspect'>,
    private readonly openStore: () => Promise<ModelActivationStore>, private readonly now: () => number) {}
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
      let definition;
      if (command.action === 'activate') {
        const observed = await this.bindings.inspect(command.reference);
        if (observed.status !== 'declared' || observed.catalogRevision !== command.catalogRevision
          || observed.binding.digest !== command.expectedBinding.digest) throw new ModelActivationStoreError('MODEL_ACTIVATION_CATALOG_CONFLICT');
        definition = observed.definition;
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
