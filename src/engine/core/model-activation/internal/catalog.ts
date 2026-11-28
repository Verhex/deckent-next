import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { catalogModelRetired, retiredModelActivationRefusal, encodeModelCatalogTarget, ModelCatalogError, modelActivationActorSchema, modelActivationAuthorizationSchema, modelCatalogQuerySchema, modelCatalogTargets,
  parseModelCatalogCommand, parseModelCatalogReceipt, principalGrants, transitionModelCatalogActivation, type Policy, type ProviderCatalog, type ModelActivationAuthorization, type ModelCatalogActivationRecord, type ModelCatalogChannelRecord,
  type ModelCatalogCommand, type ModelCatalogModelRecord, type ModelCatalogReceipt, type ModelCatalogTarget, type ModelActivationReceipt, type VerifiedPrincipal } from '#domain/index.js';
import { ErrorRegistry, isAuthorizationRefusal, PERSON_AUTHORIZATION_REFUSALS } from '#platform/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import { sameModelActivationRequest } from './evidence.js';
import { catalogDay } from './worker-admission.js';

/** Trusted admission after authentication and policy; the store re-validates it inside its transaction. */
export interface ModelCatalogAdmission {
  readonly command: ModelCatalogCommand;
  readonly actor: ModelCatalogReceipt['actor'];
  readonly authorizations: ModelCatalogReceipt['authorizations'];
  readonly admittedAtMs: number;
  /** In memory only: models this register turns current again while an activation row is on, admitted under the person's witness. */
  readonly unretired?: readonly string[];
}
/** The key of one catalog model in `unretired`. */
export const catalogModelKey = (channelId: string, modelId: string) => JSON.stringify([channelId, modelId]);
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
  loadReceipt?(scopeId: string, commandId: string): Promise<ModelCatalogReceipt | null>;
  /** Bounded: whether an activation row of this model is active in any scope (the first match ends the read). */
  activeAnywhere?(channelId: string, modelId: string): Promise<boolean>;
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
    private readonly openStore: () => Promise<ModelCatalogStore>, private readonly now: () => number,
    private readonly openReader?: () => Promise<ModelCatalogReader>, private readonly witness?: (operation: string) => Promise<void>) {}
  /** Read-only listing (WORKER-CURRENCY-2); needs the reader port. */
  async inspect(input: unknown, credential?: unknown): Promise<ModelCatalogInspection> {
    if (!this.openReader) throw new ModelCatalogError('MODEL_CATALOG_UNAVAILABLE');
    return new ModelCatalogInspectionApplication(this.verifier, this.authorizer, this.openReader).inspect(input, credential);
  }
  private async identify(input: unknown, credential?: unknown) {
    const command = parseModelCatalogCommand(input), principal = await authenticate(this.verifier, credential, command.scopeId);
    const actor = modelActivationActorSchema.parse({ id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance });
    return { command, principal, actor };
  }
  private async authorize({ command, principal, actor }: Awaited<ReturnType<ModelCatalogApplication['identify']>>) {
    // Enabling (register, activate) needs `activate`; only narrowing (deactivate) is allowed with `deactivate`.
    const action = command.action === 'deactivate' ? 'deactivate' as const : 'activate' as const;
    // Registered facts are installation-wide (every scope's admission reads them); activation rows belong to the command's scope.
    const level = command.action === 'register' ? 'installation' as const : 'scope' as const;
    const authorizations = [];
    for (const target of modelCatalogTargets(command)) {
      authorizations.push(Object.freeze({ target, action, level,
        authorization: modelActivationAuthorizationSchema.parse(await this.authorizer.authorize(action, command.scopeId, target, principal, level)) }));
    }
    return { command, actor, authorizations: Object.freeze(authorizations), admittedAtMs: this.now() };
  }
  async preflight(input: unknown, readReplay = false): Promise<ModelCatalogResult | null> {
    const identity = await this.identify(input), { command, actor, principal } = identity;
    const inspectReplay = readReplay && command.action !== 'register';
    const inspect = () => this.authorizer.authorize('inspect', command.scopeId, modelCatalogTargets(command)[0]!, principal, 'scope');
    const write = await this.authorize(identity).then(admission => ({ admission }), async (refusal: unknown) => {
      if (!inspectReplay) throw refusal;
      await inspect().catch(() => { throw refusal; });
      return { refusal };
    });
    const reader = await this.openReader?.();
    if (!reader?.loadReceipt) { reader?.close(); throw new ModelCatalogError('MODEL_CATALOG_UNAVAILABLE'); }
    try {
      const receipt = await reader.loadReceipt(command.scopeId, command.commandId);
      if (receipt) {
        if (inspectReplay && 'admission' in write) await inspect();
        if (!sameModelCatalogRequest(receipt, command, actor)) throw new ModelCatalogError('MODEL_CATALOG_COMMAND_CONFLICT');
        return Object.freeze({ replayed: true, receipt });
      }
      if (!('admission' in write)) throw write.refusal;
      const { admittedAtMs } = write.admission;
      if (command.action !== 'register') {
        if (!await reader.channel(command.channelId)) throw new ModelCatalogError('MODEL_CATALOG_NOT_FOUND');
        if (command.modelId !== null) {
          const models = await reader.models(command.channelId);
          if (!models.some(entry => entry.modelId === command.modelId)) throw new ModelCatalogError('MODEL_CATALOG_NOT_FOUND');
          if (command.action === 'activate') refuseRetiredModelActivation(models, command.modelId, admittedAtMs);
        }
        const current = await reader.activation(command.scopeId, command.channelId, command.modelId);
        transitionModelCatalogActivation(current, command);
        if (command.action === 'activate' && command.modelId === null && current?.state !== 'active') {
          for (const entry of await reader.models(command.channelId)) {
            if (isRetiredCatalogModel(entry, admittedAtMs)) continue;
            const active = await reader.activation(command.scopeId, command.channelId, entry.modelId);
            if (active?.state === 'active') await this.authorizer.authorize('activate', command.scopeId,
              { channelId: command.channelId, modelId: entry.modelId }, principal, 'scope');
          }
        }
      }
      return null;
    } finally { reader.close(); }
  }
  async apply(input: unknown, credential?: unknown): Promise<ModelCatalogResult> {
    const admission = await this.authorize(await this.identify(input, credential)), { command, actor } = admission;
    // A register that turns a retired model current again while an activation row for it is on in any scope needs the person (after the
    // permission decision, as for a switch-on); a caller that cannot ask the witness is refused with it.
    const reader = command.action === 'register' ? await this.openReader?.() : undefined;
    let unretired: string[] = [];
    try { if (reader && command.action === 'register') unretired = await catalogRegisterUnretires(command, reader, admission.admittedAtMs); } finally { reader?.close(); }
    await witnessCatalogUnretires(unretired, this.witness);
    const store = await this.openStore();
    try {
      const result = await store.apply(unretired.length ? { ...admission, unretired } : admission);
      const receipt = parseModelCatalogReceipt(result.receipt);
      if (typeof result.replayed !== 'boolean' || !sameModelCatalogRequest(receipt, command, actor)) throw new ModelCatalogError('MODEL_CATALOG_CORRUPT');
      return Object.freeze({ replayed: result.replayed, receipt });
    } finally { store.close(); }
  }
}
/** Read only: the models a register would turn from retired to current while an activation row of them is on in any scope. A command
 * whose receipt exists is left to the writer's replay rules (no witness for a write that is not due); without a reader, the writer re-checks. */
async function catalogRegisterUnretires(command: Extract<ModelCatalogCommand, { action: 'register' }>, reader: ModelCatalogReader, nowMs: number) {
  const found: string[] = [];
  if (await reader.loadReceipt?.(command.scopeId, command.commandId)) return found;
  for (const provider of command.catalog.providers) {
    const stored = new Map((await reader.models(provider.id)).map(row => [row.modelId, row]));
    for (const model of provider.models) {
      const prior = stored.get(model.nativeId);
      if (prior && isRetiredCatalogModel(prior, nowMs) && !catalogModelRetired(model.lifecycle, catalogDay(nowMs))
        && await reader.activeAnywhere?.(provider.id, model.nativeId)) found.push(catalogModelKey(provider.id, model.nativeId));
    }
  }
  return found;
}
/** The person's witness for those models; a caller without a witness port is refused with the existing witness refusal. */
async function witnessCatalogUnretires(found: readonly string[], witness?: (operation: string) => Promise<void>) {
  if (!found.length) return;
  if (!witness) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'models.catalog.register' } });
  await witness('models.catalog.register');
}

/** A channel as one scope sees it (WORKER-CURRENCY-2): installation facts plus the scope's activation rows; `denied` without `inspect`. */
export type ModelCatalogChannelView = Readonly<{ channelId: string; access: 'denied' }> | Readonly<{ channelId: string; access: 'allowed';
  revision: number; providerVersion: number; catalogRevision: string; channel: ModelCatalogChannelRecord['channel'];
  activation: Readonly<{ state: 'active' | 'inactive'; revision: number }> | null;
  models: readonly Readonly<{ modelId: string; revision: number; model: ModelCatalogModelRecord['model'];
    activation: Readonly<{ state: 'active' | 'inactive'; revision: number }> | null; chatState?: 'active' | 'inactive' | null; activationConflict?: boolean;
    governedUse?: 'outside-installation' }>[] }>;
export interface ModelCatalogInspection { readonly schemaVersion: 1; readonly scopeId: string; readonly channels: readonly ModelCatalogChannelView[] }
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). Read-only catalog listing with the scope's activation state; each channel needs the scoped `inspect` decision on its target. */
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
          if (!(error instanceof Error && 'code' in error && isAuthorizationRefusal(error.code, { include: PERSON_AUTHORIZATION_REFUSALS }))) throw error;
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

export function isRetiredCatalogModel(entry: Pick<ModelCatalogModelRecord, 'model'>, nowMs: number): boolean {
  return catalogModelRetired(entry.model.lifecycle, catalogDay(nowMs));
}

/** A person's explicit activation of a retired model is refused with its retirement day and a recorded successor; deactivation stays allowed. */
export function refuseRetiredModelActivation(models: Parameters<typeof retiredModelActivationRefusal>[0], modelId: string, nowMs: number): void {
  const refusal = retiredModelActivationRefusal(models, modelId, catalogDay(nowMs));
  if (refusal) throw refusal;
}

/** The deciding grant's terms are independent of revisions to unrelated policy cells. */
export const modelActivationPolicyRule = (policy: Policy, principal: VerifiedPrincipal, id: string) =>
  principalGrants(policy, principal).find(grant => grant.id === id);

/** Only the channel's own facts and participating model rows make up an activation plan. */
export async function checkCatalogActivationFacts(reader: ModelCatalogReader, scopeId: string,
  planned: Extract<ModelCatalogChannelView, { access: 'allowed' }>, selected: readonly string[], opening: boolean): Promise<void> {
  const { channelId } = planned;
  const models = await reader.models(channelId), at = Date.now();
  const versions = (rows: readonly Pick<ModelCatalogModelRecord, 'modelId' | 'revision'>[]) =>
    rows.filter(row => selected.includes(row.modelId)).map(({ modelId, revision }) => ({ modelId, revision }));
  const sibling = (row: Pick<ModelCatalogModelRecord, 'modelId' | 'model'>) => !selected.includes(row.modelId) && !isRetiredCatalogModel(row, at);
  const active = opening ? (await Promise.all(models.filter(sibling).map(async row => ({
    modelId: row.modelId, revision: row.revision, activation: await reader.activation(scopeId, channelId, row.modelId),
  })))).filter(row => row.activation?.state === 'active').map(row => ({ ...row, activation: row.activation!.revision })) : [];
  const expected = planned.models.filter(row => opening && sibling(row) && row.activation?.state === 'active')
    .map(row => ({ modelId: row.modelId, revision: row.revision, activation: row.activation!.revision }));
  if ((await reader.channel(channelId))?.revision !== planned.revision
    || !isDeepStrictEqual(versions(models), versions(planned.models)) || !isDeepStrictEqual(active, expected)) {
    throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
  }
}

export function verifyCatalogActivationChange(receipt: ModelCatalogReceipt, command: Exclude<ModelCatalogCommand, { action: 'register' }>): void {
  const { channelId, modelId, expectedRevision } = command;
  // The stored authority entries name the command's own targets, action and level, as the writer's admission built them.
  const authorized = modelCatalogTargets(command).map(target => ({ target, action: command.action, level: 'scope' }));
  if (!isDeepStrictEqual(receipt.changes, [{ kind: 'activation', channelId, modelId, revision: expectedRevision + 1 }])
    || !isDeepStrictEqual(receipt.authorizations.map(({ target, action, level }) => ({ target, action, level })), authorized))
    throw new ModelCatalogError('MODEL_CATALOG_CORRUPT');
}

export const catalogChildCommandId = (commandId: string, id: string, stage: 'activate' | 'worker' | 'chat') =>
  `catalog-state-${createHash('sha256').update(JSON.stringify([commandId, id, stage])).digest('hex')}`;

/** Verify historical children against the parent actor and the deterministic identities of its original writes. */
export async function readCatalogCascadeReceipts(command: Exclude<ModelCatalogCommand, { action: 'register' }>,
  actor: ModelCatalogReceipt['actor'], modelIds: readonly string[], catalog: (id: string) => Promise<ModelCatalogReceipt | null>,
  chat: (id: string) => Promise<ModelActivationReceipt | null>) {
  const { action, scopeId, channelId, modelId, commandId } = command;
  const targets = modelId === null ? modelIds : [modelId], children = [];
  if (action === 'activate') for (const id of modelId === null ? targets : [null]) {
    const childId = id === null ? catalogChildCommandId(commandId, 'channel', 'activate') : catalogChildCommandId(commandId, id, 'worker');
    const receipt = await catalog(childId);
    if (!receipt) continue;
    const expected = { schemaVersion: 1 as const, commandId: childId, scopeId, action, channelId, modelId: id,
      expectedRevision: receipt.command.action === 'activate' ? receipt.command.expectedRevision : 0 };
    if (!sameModelCatalogRequest(receipt, expected, actor)) throw new ModelCatalogError('MODEL_CATALOG_COMMAND_CONFLICT');
    verifyCatalogActivationChange(receipt, expected);
    children.push(expected);
  }
  for (const id of targets) {
    const receipt = await chat(catalogChildCommandId(commandId, id, 'chat'));
    if (!receipt) continue;
    if (receipt.command.action !== action || !sameModelActivationRequest(receipt, receipt.command, actor))
      throw new ModelCatalogError('MODEL_CATALOG_COMMAND_CONFLICT');
    children.push(receipt.command);
  }
  return children;
}

/** Write-time channel cascade. Explicit inactive rows always win; a retired model is never turned on by it (law 6 amendment: only current,
 * priced models); catalog observation never calls this planner. */
export function planCatalogStateCascade(command: Exclude<ModelCatalogCommand, { action: 'register' }>, channel: Extract<ModelCatalogChannelView, { access: 'allowed' }>,
  declared: ProviderCatalog['providers'][number] | undefined, priced: readonly string[], nowMs: number) {
  return channel.models.flatMap(entry => {
    if (command.modelId !== null && command.modelId !== entry.modelId) return [];
    const named = command.modelId !== null, current = entry.model.lifecycle.state === 'active' && !catalogModelRetired(entry.model.lifecycle, catalogDay(nowMs));
    const fresh = entry.activation === null && current && priced.includes(entry.modelId);
    const enabled = command.action === 'activate' && (named || (current && entry.activation?.state === 'active') || fresh);
    if (command.action === 'activate' && !enabled) return [];
    const model = declared?.models.find(model => model.nativeId === entry.modelId);
    return [{ entry, enabled, activateWorker: !named && fresh && enabled,
      reference: model ? { providerId: declared!.id, providerVersion: declared!.version, modelId: model.id, modelVersion: model.version } : null }];
  });
}
