import { createHash } from 'node:crypto';
import { encodeModelCatalogTarget, ModelCatalogError, modelActivationActorSchema, modelActivationAuthorizationSchema, modelCatalogQuerySchema, modelCatalogTargets,
  parseModelCatalogCommand, parseModelCatalogReceipt, type ModelActivationAuthorization, type ModelCatalogActivationRecord, type ModelCatalogChannelRecord,
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
  /** Every registered channel, ordered by id (catalog listing). */
  channels(): Promise<readonly ModelCatalogChannelRecord[]>;
  channel(channelId: string): Promise<ModelCatalogChannelRecord | null>;
  models(channelId: string): Promise<readonly ModelCatalogModelRecord[]>;
  activation(scopeId: string, channelId: string, modelId: string | null): Promise<ModelCatalogActivationRecord | null>;
  close(): void;
}
export interface ModelCatalogAuthorizer {
  /** `installation`: the write changes facts every scope reads, so authority must hold installation-wide; `scope`: one scope's rows. */
  authorize(action: 'activate' | 'deactivate' | 'inspect', scopeId: string, target: ModelCatalogTarget, principal: VerifiedPrincipal,
    level: 'installation' | 'scope'): Promise<ModelActivationAuthorization>;
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
    // Registered facts are installation-wide (every scope's admission reads them); activation rows belong to the command's scope.
    const level = command.action === 'register' ? 'installation' as const : 'scope' as const;
    const authorizations = [];
    for (const target of modelCatalogTargets(command)) {
      authorizations.push(Object.freeze({ target, action, level,
        authorization: modelActivationAuthorizationSchema.parse(await this.authorizer.authorize(action, command.scopeId, target, principal, level)) }));
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

/** A channel as one scope sees it (WORKER-CURRENCY-2): installation facts plus the scope's activation rows; `denied` without `inspect`. */
export type ModelCatalogChannelView = Readonly<{ channelId: string; access: 'denied' }> | Readonly<{ channelId: string; access: 'allowed';
  revision: number; providerVersion: number; catalogRevision: string; channel: ModelCatalogChannelRecord['channel'];
  activation: Readonly<{ state: 'active' | 'inactive'; revision: number }> | null;
  models: readonly Readonly<{ modelId: string; revision: number; model: ModelCatalogModelRecord['model'];
    activation: Readonly<{ state: 'active' | 'inactive'; revision: number }> | null }>[] }>;
export interface ModelCatalogInspection { readonly schemaVersion: 1; readonly scopeId: string; readonly channels: readonly ModelCatalogChannelView[] }
/** Read-only catalog listing with the scope's activation state; each channel needs the scoped `inspect` decision on its target. */
export class ModelCatalogInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorizer: ModelCatalogAuthorizer,
    private readonly openReader: () => Promise<ModelCatalogReader>) {}
  async inspect(input: unknown, credential?: unknown): Promise<ModelCatalogInspection> {
    const parsed = modelCatalogQuerySchema.safeParse(input);
    if (!parsed.success) throw new ModelCatalogError('MODEL_CATALOG_INVALID');
    const query = parsed.data, principal = await authenticate(this.verifier, credential, query.scopeId);
    const reader = await this.openReader();
    try {
      const state = (row: ModelCatalogActivationRecord | null) => row ? Object.freeze({ state: row.state, revision: row.revision }) : null;
      const channels: ModelCatalogChannelView[] = [];
      for (const record of (await reader.channels()).filter(entry => query.channelId === undefined || entry.channelId === query.channelId)) {
        try { await this.authorizer.authorize('inspect', query.scopeId, { channelId: record.channelId, modelId: null }, principal, 'scope'); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && ['POLICY_DENIED', 'POLICY_APPROVAL_UNSUPPORTED'].includes(String(error.code)))) throw error;
          channels.push(Object.freeze({ channelId: record.channelId, access: 'denied' })); continue;
        }
        const models = [];
        for (const entry of await reader.models(record.channelId)) models.push(Object.freeze({ modelId: entry.modelId, revision: entry.revision, model: entry.model,
          activation: state(await reader.activation(query.scopeId, record.channelId, entry.modelId)) }));
        channels.push(Object.freeze({ channelId: record.channelId, access: 'allowed', revision: record.revision, providerVersion: record.providerVersion,
          catalogRevision: record.catalogRevision, channel: record.channel, activation: state(await reader.activation(query.scopeId, record.channelId, null)),
          models: Object.freeze(models) }));
      }
      return Object.freeze({ schemaVersion: 1, scopeId: query.scopeId, channels: Object.freeze(channels) });
    } finally { reader.close(); }
  }
}
