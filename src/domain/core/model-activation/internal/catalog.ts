import { z } from 'zod';
import { counterSchema, createImmutableJsonObjectSchema, identitySchema } from '#domain/core/primitives/index.js';
import { PROVIDER_CATALOG_WIRE_LIMITS, ProviderCatalogError, catalogChannelSchema, catalogModelSchema, exactModelIdSchema,
  parseProviderCatalogDocument, type ProviderCatalogDocument } from '#domain/core/provider-catalog/index.js';
import { modelActivationActorSchema, modelActivationAuthorizationSchema } from './contract.js';

/**
 * Ledger model catalog (WORKER-CURRENCY-1, ledger v43, Jev 55471f68). Catalog facts are installation-wide rows keyed by
 * (channel id, exact model id); activation is per scope and hierarchical — a channel row (model id null) and a model row. Only an
 * active model of an active channel in the request scope is selectable. Writes go through one command with a receipt; authority is
 * the existing `model-activation` policy resource (register and activate need `activate`, deactivate needs `deactivate`).
 */
export const MODEL_CATALOG_SCHEMA_VERSION = 1;
export const MODEL_CATALOG_TARGET_PREFIX = 'deckent.model-catalog-target.v1\n';
export type ModelCatalogErrorCode = 'MODEL_CATALOG_INVALID' | 'MODEL_CATALOG_REVISION_CONFLICT' | 'MODEL_CATALOG_NOT_FOUND'
  | 'MODEL_CATALOG_NOT_ACTIVE' | 'MODEL_CATALOG_COMMAND_CONFLICT' | 'MODEL_CATALOG_CORRUPT' | 'MODEL_CATALOG_UNAVAILABLE'
  | 'MODEL_CATALOG_OUTCOME_UNKNOWN' | 'MODEL_CATALOG_ALIAS_CONFLICT';
export class ModelCatalogError extends Error {
  constructor(readonly code: ModelCatalogErrorCode) { super(code); this.name = 'ModelCatalogError'; }
}
const catalogDocumentSchema = z.unknown().transform((input, context): ProviderCatalogDocument => {
  try { return parseProviderCatalogDocument(input); }
  catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof ProviderCatalogError ? error.code : 'PROVIDER_CATALOG_INVALID' });
    return z.NEVER;
  }
});
const base = { schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION), commandId: identitySchema, scopeId: identitySchema };
export const modelCatalogTargetSchema = z.object({ channelId: identitySchema, modelId: exactModelIdSchema.nullable() }).strict().readonly();
export const modelCatalogCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('register'), catalog: catalogDocumentSchema }).strict(),
  z.object({ ...base, action: z.enum(['activate', 'deactivate']), channelId: identitySchema, modelId: exactModelIdSchema.nullable(),
    expectedRevision: counterSchema }).strict(),
]).readonly();
export const modelCatalogChannelRecordSchema = z.object({ schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION), channelId: identitySchema,
  revision: counterSchema.positive(), providerVersion: counterSchema.positive(), channel: catalogChannelSchema, catalogRevision: identitySchema,
}).strict().readonly();
export const modelCatalogModelRecordSchema = z.object({ schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION), channelId: identitySchema,
  modelId: exactModelIdSchema, revision: counterSchema.positive(), providerVersion: counterSchema.positive(), model: catalogModelSchema,
  catalogRevision: identitySchema }).strict().refine(record => record.model.nativeId === record.modelId).readonly();
export const modelCatalogActivationRecordSchema = z.object({ schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION), scopeId: identitySchema,
  channelId: identitySchema, modelId: exactModelIdSchema.nullable(), revision: counterSchema.positive(), state: z.enum(['active', 'inactive']),
}).strict().readonly();
const changeSchema = z.object({ kind: z.enum(['channel', 'model', 'activation']), channelId: identitySchema,
  modelId: exactModelIdSchema.nullable(), revision: counterSchema.positive() }).strict().readonly();
export const modelCatalogReceiptSchema = z.object({ schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION),
  command: modelCatalogCommandSchema, actor: modelActivationActorSchema,
  authorizations: z.array(z.object({ target: modelCatalogTargetSchema, action: z.enum(['activate', 'deactivate']),
    level: z.enum(['installation', 'scope']), authorization: modelActivationAuthorizationSchema }).strict().readonly()).min(1).readonly(),
  changes: z.array(changeSchema).readonly(), admittedAtMs: counterSchema,
}).strict().refine(receipt => receipt.authorizations.every(entry => entry.level === (receipt.command.action === 'register' ? 'installation' : 'scope'))).readonly();

export type ModelCatalogCommand = Readonly<z.infer<typeof modelCatalogCommandSchema>>;
export type ModelCatalogTarget = Readonly<z.infer<typeof modelCatalogTargetSchema>>;
export type ModelCatalogChannelRecord = Readonly<z.infer<typeof modelCatalogChannelRecordSchema>>;
export type ModelCatalogModelRecord = Readonly<z.infer<typeof modelCatalogModelRecordSchema>>;
export type ModelCatalogActivationRecord = Readonly<z.infer<typeof modelCatalogActivationRecordSchema>>;
export type ModelCatalogReceipt = Readonly<z.infer<typeof modelCatalogReceiptSchema>>;
export type ModelCatalogChange = z.infer<typeof changeSchema>;

const envelope = createImmutableJsonObjectSchema(PROVIDER_CATALOG_WIRE_LIMITS);
function strict<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, code: ModelCatalogErrorCode): T {
  const copied = envelope.safeParse(input);
  const parsed = copied.success ? schema.safeParse(copied.data) : null;
  if (!parsed?.success) throw new ModelCatalogError(code);
  return parsed.data;
}
export const parseModelCatalogCommand = (input: unknown): ModelCatalogCommand => strict(modelCatalogCommandSchema, input, 'MODEL_CATALOG_INVALID');
export const parseModelCatalogReceipt = (input: unknown): ModelCatalogReceipt => strict(modelCatalogReceiptSchema, input, 'MODEL_CATALOG_CORRUPT');
export const parseModelCatalogChannelRecord = (input: unknown): ModelCatalogChannelRecord => strict(modelCatalogChannelRecordSchema, input, 'MODEL_CATALOG_CORRUPT');
export const parseModelCatalogModelRecord = (input: unknown): ModelCatalogModelRecord => strict(modelCatalogModelRecordSchema, input, 'MODEL_CATALOG_CORRUPT');
export const parseModelCatalogActivationRecord = (input: unknown): ModelCatalogActivationRecord => strict(modelCatalogActivationRecordSchema, input, 'MODEL_CATALOG_CORRUPT');

/** Stable policy-target bytes for one channel (model null) or one (channel, exact model id). */
export function encodeModelCatalogTarget(input: unknown): string {
  const target = strict(modelCatalogTargetSchema, input, 'MODEL_CATALOG_INVALID');
  return `${MODEL_CATALOG_TARGET_PREFIX}${JSON.stringify({ channelId: target.channelId, modelId: target.modelId })}`;
}
/** The policy targets a command touches, in canonical order: every registered channel, or the one activation target. */
export function modelCatalogTargets(command: ModelCatalogCommand): readonly ModelCatalogTarget[] {
  if (command.action !== 'register') return Object.freeze([Object.freeze({ channelId: command.channelId, modelId: command.modelId })]);
  return Object.freeze(command.catalog.providers.map(provider => Object.freeze({ channelId: provider.id, modelId: null })));
}

/**
 * Invariants of one channel's FINAL state (Astra 2197 WC-R3): a register is partial — models it omits are preserved — so the document's own
 * checks are not enough. Across the channel alias list and every model's aliases: no alias repeats and none equals an exact id of any
 * model (preserved or written); CLI minimums only on a CLI channel. Refusal is typed; the caller's transaction then writes nothing.
 */
function assertMergedChannel(channel: ModelCatalogChannelRecord['channel'], models: readonly ModelCatalogModelRecord['model'][]): void {
  const exact = new Set(models.map(model => model.nativeId)), aliases = new Set<string>();
  for (const alias of [...channel.aliases, ...models.flatMap(model => model.aliases)]) {
    if (exact.has(alias) || aliases.has(alias)) throw new ModelCatalogError('MODEL_CATALOG_ALIAS_CONFLICT');
    aliases.add(alias);
  }
  if (channel.kind !== 'native-cli' && models.some(model => model.minCliVersion !== null)) throw new ModelCatalogError('MODEL_CATALOG_INVALID');
}
/** Catalog rows a register command writes: only new or changed facts get a new revision; absent rows are never deleted (retire instead). */
export function planModelCatalogRegistration(command: ModelCatalogCommand, current: {
  channel(channelId: string): ModelCatalogChannelRecord | null; models(channelId: string): readonly ModelCatalogModelRecord[];
}): { channels: ModelCatalogChannelRecord[]; models: ModelCatalogModelRecord[] } {
  if (command.action !== 'register') throw new ModelCatalogError('MODEL_CATALOG_INVALID');
  const catalogRevision = command.catalog.revision, channels: ModelCatalogChannelRecord[] = [], models: ModelCatalogModelRecord[] = [];
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  for (const provider of command.catalog.providers) {
    const prior = current.channel(provider.id);
    if (!prior || prior.providerVersion !== provider.version || !same(prior.channel, provider.channel)) {
      channels.push(parseModelCatalogChannelRecord({ schemaVersion: 1, channelId: provider.id, revision: (prior?.revision ?? 0) + 1,
        providerVersion: provider.version, channel: provider.channel, catalogRevision }));
    }
    const existing = new Map(current.models(provider.id).map(entry => [entry.modelId, entry]));
    const merged = new Map([...existing].map(([modelId, entry]) => [modelId, entry.model]));
    for (const model of provider.models) merged.set(model.nativeId, model);
    assertMergedChannel(provider.channel, [...merged.values()]);
    for (const model of provider.models) {
      const before = existing.get(model.nativeId) ?? null;
      if (before && before.providerVersion === provider.version && same(before.model, model)) continue;
      models.push(parseModelCatalogModelRecord({ schemaVersion: 1, channelId: provider.id, modelId: model.nativeId,
        revision: (before?.revision ?? 0) + 1, providerVersion: provider.version, model, catalogRevision }));
    }
  }
  return { channels, models };
}
/** Pure activation transition with optimistic revision; deactivating requires an active row. */
export function transitionModelCatalogActivation(current: ModelCatalogActivationRecord | null, command: ModelCatalogCommand): ModelCatalogActivationRecord {
  if (command.action === 'register') throw new ModelCatalogError('MODEL_CATALOG_INVALID');
  if ((current?.revision ?? 0) !== command.expectedRevision) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
  if (command.action === 'deactivate' && current?.state !== 'active') throw new ModelCatalogError('MODEL_CATALOG_NOT_ACTIVE');
  return parseModelCatalogActivationRecord({ schemaVersion: 1, scopeId: command.scopeId, channelId: command.channelId, modelId: command.modelId,
    revision: command.expectedRevision + 1, state: command.action === 'activate' ? 'active' : 'inactive' });
}
