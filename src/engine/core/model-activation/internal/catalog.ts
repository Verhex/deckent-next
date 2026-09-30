import { createHash } from 'node:crypto';
import { encodeModelCatalogTarget, ModelCatalogError, modelActivationActorSchema, modelActivationAuthorizationSchema, modelCatalogTargets, parseModelCatalogCommand,
  parseModelCatalogReceipt, type ModelActivationAuthorization, type ModelCatalogActivationRecord, type ModelCatalogChannelRecord,
  type ModelCatalogCommand, type ModelCatalogModelRecord, type ModelCatalogReceipt, type ModelCatalogTarget, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';

/** Trusted admission after authentication and policy; the store re-validates it inside its transaction. */
export interface ModelCatalogAdmission {
  readonly command: ModelCatalogCommand;
  readonly actor: ModelCatalogReceipt['actor'];
  readonly authorizations: ModelCatalogReceipt['authorizations'];
  readonly admittedAtMs: number;
}
export interface ModelCatalogResult { readonly replayed: boolean; readonly receipt: ModelCatalogReceipt }
/** Writer port: one transaction per command (replay check, plan, rows, receipt). */
export interface ModelCatalogStore {
  apply(admission: ModelCatalogAdmission): Promise<ModelCatalogResult>;
  close(): void;
}
/** Read port used by admission. Rows are verified by the adapter; absence is null, never a default. */
export interface ModelCatalogReader {
  channel(channelId: string): Promise<ModelCatalogChannelRecord | null>;
  models(channelId: string): Promise<readonly ModelCatalogModelRecord[]>;
  activation(scopeId: string, channelId: string, modelId: string | null): Promise<ModelCatalogActivationRecord | null>;
  close(): void;
}
export interface ModelCatalogAuthorizer {
  authorize(action: 'activate' | 'deactivate', scopeId: string, target: ModelCatalogTarget, principal: VerifiedPrincipal): Promise<ModelActivationAuthorization>;
}
/** Policy resource id of a catalog target (the `model-activation` resource kind is shared with exact-reference activation). */
export function modelCatalogTargetId(target: unknown): string {
  return createHash('sha256').update(encodeModelCatalogTarget(target), 'utf8').digest('hex');
}
/** Same command identity (bytes) and actor, or a conflict. */
export function sameModelCatalogRequest(receipt: ModelCatalogReceipt, command: ModelCatalogCommand, actor: ModelCatalogReceipt['actor']): boolean {
  return JSON.stringify(receipt.command) === JSON.stringify(command) && JSON.stringify(receipt.actor) === JSON.stringify(actor);
}

/** Governed catalog writes: register facts, activate or deactivate a channel or one of its models in a scope. */
export class ModelCatalogApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorizer: ModelCatalogAuthorizer,
    private readonly openStore: () => Promise<ModelCatalogStore>, private readonly now: () => number) {}
  async apply(input: unknown, credential?: unknown): Promise<ModelCatalogResult> {
    const command = parseModelCatalogCommand(input);
    const principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = modelActivationActorSchema.parse({ id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance });
    // Enabling (register, activate) needs `activate`; only narrowing (deactivate) is allowed with `deactivate`.
    const action = command.action === 'deactivate' ? 'deactivate' as const : 'activate' as const;
    const authorizations = [];
    for (const target of modelCatalogTargets(command)) {
      authorizations.push(Object.freeze({ target, action,
        authorization: modelActivationAuthorizationSchema.parse(await this.authorizer.authorize(action, command.scopeId, target, principal)) }));
    }
    const store = await this.openStore();
    try {
      const result = await store.apply({ command, actor, authorizations: Object.freeze(authorizations), admittedAtMs: this.now() });
      const receipt = parseModelCatalogReceipt(result.receipt);
      if (typeof result.replayed !== 'boolean' || !sameModelCatalogRequest(receipt, command, actor)) throw new ModelCatalogError('MODEL_CATALOG_CORRUPT');
      return Object.freeze({ replayed: result.replayed, receipt });
    } finally { store.close(); }
  }
}
