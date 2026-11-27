import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { DeclaredModelsApplication, configuredInvocationProfiles, verifiedPrincipal, ModelActivationApplication, refuseRetiredModelActivation, ModelActivationPolicyAuthorization, ModelBindingApplication,
  assessModelInvocationProfileDeliveries } from '#engine/index.js';
import { ModelCatalogError, ModelActivationError, modelActivationCommandSchema, type ModelActivationCommand, type ModelReference } from '#domain/index.js';
import { openSqliteModelActivationReader, openSqliteModelActivationStore } from '#adapters/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { checkConfiguredCatalogFacts, inspectConfiguredModelCatalog, planCatalogWrite } from './catalog.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { configuredModelInvocationDeliverySurfaces } from '#composition/core/model-invocation/index.js';
import { activationAuthority, type ActivationAuthority } from './activation-authority.js';
import { activationReceiptOptions } from './catalog-evidence.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
const configuredCatalogSource = ({ config }: Context) => ({ async read() { return config['provider_catalog']; } });
export const configuredBinding = (context: Context) => new ModelBindingApplication(configuredCatalogSource(context));
export const configuredDeclarations = async (context: Context) => (await new DeclaredModelsApplication(configuredCatalogSource(context)).inspect()).catalog;
export function configuredChatActivation(command: ModelActivationCommand, context: Context, authority: ActivationAuthority) {
  const { principal, path } = context, { scopeId, reference } = command;
  const delivery = ({ config }: Context) => {
    const profiles = configuredInvocationProfiles(config).filter(profile => profile.scopeId === scopeId && isDeepStrictEqual(profile.reference, reference));
    return { profiles: { profiles }, surfaces: profiles.length ? configuredModelInvocationDeliverySurfaces(config) : [] };
  };
  const limits = delivery(context);
  const app = new ModelActivationApplication(verifiedPrincipal(principal), { authorize: (action, target, actor) =>
    authority.authorize(({ document }) => new ModelActivationPolicyAuthorization({ async load() { return document; } }).authorize(action, target, actor)) },
    configuredBinding(context), async () => {
      const writable = await authority.write();
      return openSqliteModelActivationStore(await writable.path(), writable.config.storage.sqlite, 'forbid');
    }, Date.now, { ...limits, assess: assessModelInvocationProfileDeliveries });
  if (command.action === 'activate') {
    authority.pin(limits, delivery);
    authority.pin({ status: 'declared', catalogRevision: command.catalogRevision, binding: command.expectedBinding }, async current => {
      const { status, catalogRevision, binding } = await configuredBinding(current).inspect(reference);
      return { status, catalogRevision, binding };
    });
  }
  return { preflight: () => app.preflight(command, async () => openSqliteModelActivationReader(await path(),
    activationReceiptOptions(context))), write: () => app.admit(command) };
}

/** Carry writes just the chat binding. It still needs the same witness as direct activation. */
export const admitConfiguredChatActivation = (root: string, input: ModelActivationCommand, options: ConfigLoadOptions = {}) =>
  admit(root, input, options, false);

/** One explicit model command coordinates the chat and worker owners. */
export const admitConfiguredModelActivation = (root: string, input: ModelActivationCommand, options: ConfigLoadOptions = {}) =>
  admit(root, input, options, true);

async function admit(root: string, input: ModelActivationCommand, options: ConfigLoadOptions, cascade: boolean) {
  try {
    const parsed = modelActivationCommandSchema.safeParse(input);
    if (!parsed.success) throw new ModelActivationError('MODEL_ACTIVATION_INVALID');
    const command = parsed.data, scopeId = command.scopeId;
    const context = await loadConfiguredScopeContext(root, scopeId, options, 'read'), authority = activationAuthority(root, scopeId, options, context);
    const app = configuredChatActivation(command, context, authority);
    const { replay, current } = await app.preflight();
    // As the base did, a replay (also one the writer returns) is shown only under inspect on the scope read again now, and a child write
    // still due stays behind that decision. A caller without it meets the activation witness first, as for a command with no receipt.
    const inspect = async (current: Context) => (await new ModelActivationPolicyAuthorization({ async load() { return current.document; } })
      .authorize('inspect', { scopeId, reference: command.reference }, current.principal)).ruleId;
    const visible = async <T extends { readonly replayed: boolean } | null>(result: T) => {
      if (!cascade || !result?.replayed) return result;
      const ruleId = await inspect(await loadConfiguredScopeContext(root, scopeId, options, 'read'))
        .catch(async (refusal: unknown) => { if (command.action === 'activate') await authority.witness('models.activate'); throw refusal; });
      authority.pin(ruleId, inspect);
      return result;
    };
    await visible(replay);
    if (replay && (!cascade || current?.revision !== replay.receipt.record.revision)) return replay;
    const off = command.action === 'deactivate' ? replay ?? await visible(await app.write()) : null;
    const { writes, conflict } = cascade ? await planWorkerWrites(root, scopeId, command.reference, command.commandId, command.action, options, context, authority, false)
      : { writes: [], conflict: false };
    if (command.action === 'activate' && (!replay || writes.length || conflict)) await authority.witness('models.activate');
    if (conflict) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
    const result = off ?? replay ?? await visible(await app.write());
    for (const write of writes) await write();
    return result;
  } catch (error) { throw queryFailure(error); }
}

async function planWorkerWrites(root: string, scopeId: string, reference: ModelReference, commandId: string, action: 'activate' | 'deactivate',
  options: ConfigLoadOptions, context: Context, authority: ActivationAuthority, workerOnly: boolean) {
  const listed = await inspectConfiguredModelCatalog(root, { schemaVersion: 1, scopeId, channelId: reference.providerId }, options, { modelUse: false });
  const channel = listed.channels.find(row => row.access === 'allowed' && row.providerVersion === reference.providerVersion);
  const declared = workerOnly ? null : await configuredDeclarations(context);
  const nativeId = declared?.providers.find(provider => provider.id === reference.providerId && provider.version === reference.providerVersion)
    ?.models.find(model => model.id === reference.modelId && model.version === reference.modelVersion)?.nativeId;
  const model = channel?.access === 'allowed' ? channel.models.find(row => workerOnly
    ? row.model.id === reference.modelId && row.model.version === reference.modelVersion : row.model.nativeId === nativeId) : undefined;
  if (channel?.access !== 'allowed' || !model) {
    if (workerOnly) throw new ModelCatalogError('MODEL_CATALOG_NOT_FOUND');
    return { writes: [], conflict: false };
  }
  const targets = action === 'activate' ? [null, model.modelId] : [model.modelId], writes: (() => Promise<unknown>)[] = [];
  let conflict = false;
  const prefix = workerOnly ? commandId : `model-state-${createHash('sha256').update(commandId).digest('hex')}`;
  if (action === 'activate') {
    refuseRetiredModelActivation(channel.models, model.modelId, Date.now());
    authority.pin(undefined, current => checkConfiguredCatalogFacts(current, scopeId, channel, [model.modelId], true));
  }
  for (const [index, modelId] of targets.entries()) {
    const current = modelId === null ? channel.activation : model.activation;
    if (current?.state === (action === 'activate' ? 'active' : 'inactive')) continue;
    const child = { schemaVersion: 1 as const, commandId: workerOnly ? `${prefix}.${index}` : `${prefix}-${index}`, scopeId, action,
      channelId: channel.channelId, modelId, expectedRevision: current?.revision ?? 0 };
    // A chat receipt replay with a newly missing child still requires a witness.
    const planned = await planCatalogWrite(context, authority, child);
    // A child receipt whose row no longer holds its change is noted; every child is still planned, so a later child's refusal keeps its place.
    if (action === 'activate' && planned.replay) { conflict = true; continue; }
    writes.push(() => planned.write(channel, [model.modelId]));
  }
  return { writes, conflict };
}

/** A named worker-only model has no chat declaration or whole-channel cascade. */
export async function activateConfiguredWorkerModel(root: string, scopeId: string, reference: ModelReference, commandId: string, options: ConfigLoadOptions = {},
  beforeWrite?: () => Promise<void>): Promise<boolean> {
  try {
    const context = await loadConfiguredScopeContext(root, scopeId, options, 'read'), authority = activationAuthority(root, scopeId, options, context);
    const { writes, conflict } = await planWorkerWrites(root, scopeId, reference, commandId, 'activate', options, context, authority, true);
    if (!writes.length && !conflict) return false;
    await authority.witness('models.activate');
    if (conflict) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
    // A caller's own check (a connect's wide check) runs right before each durable write.
    for (const write of writes) { await beforeWrite?.(); await write(); }
    return true;
  } catch (error) { throw queryFailure(error); }
}
