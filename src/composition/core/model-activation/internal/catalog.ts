import { PROVIDER_CONNECT_REGISTRY, providerConnectModelPriced, openSqliteModelCatalogReader, openSqliteModelCatalogStore } from '#adapters/index.js';
import { admitConfiguredChatActivation, configuredBinding, configuredChatActivation, configuredDeclarations } from './admit.js';
import { inspectDeclaredModels } from '#composition/core/provider-catalog/index.js';
import { ModelCatalogError, modelActivationCommandSchema, modelCatalogCommandSchema, type ModelCatalogQuery, type ModelCatalogCommand, type ModelActivationCommand } from '#domain/index.js';
import { checkCatalogActivationFacts, verifyCatalogActivationChange, verifiedPrincipal, planCatalogStateCascade, ModelCatalogApplication, ModelCatalogPolicyAuthorization, type ModelCatalogAuthorizer, type ModelCatalogChannelView } from '#engine/index.js';
import type { ConfigLoadOptions } from '#platform/index.js';
import type { ModelInspectionSnapshot } from '#composition/core/model-inspection/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { inspectConfiguredModelActivation } from './inspect.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { activationAuthority, type ActivationAuthority } from './activation-authority.js';
import { catalogEvidence, activationReceiptOptions } from './catalog-evidence.js';

type Context = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
type Channel = Extract<ModelCatalogChannelView, { access: 'allowed' }>;
function catalogApplication(context: Context, authority?: ActivationAuthority, register = false) {
  const decide = new ModelCatalogPolicyAuthorization({ async load() { return context.document; } });
  const authorize: ModelCatalogAuthorizer['authorize'] = authority ? (...args) => authority.authorize(({ document }) =>
    new ModelCatalogPolicyAuthorization({ async load() { return document; } }).authorize(...args)) : decide.authorize.bind(decide);
  return new ModelCatalogApplication(verifiedPrincipal(context.principal), { authorize }, async () => {
    if (!authority && !register) throw new ModelCatalogError('MODEL_CATALOG_READ_ONLY');
    const writable = await (authority?.write() ?? context);
    return openSqliteModelCatalogStore(await writable.path(), writable.config.storage.sqlite, 'forbid');
  }, Date.now, async () => openSqliteModelCatalogReader(await context.path(), activationReceiptOptions(context)));
}
export async function planCatalogWrite(context: Context, authority: ActivationAuthority, command: Exclude<ModelCatalogCommand, { action: 'register' }>, readReplay = false) {
  const app = catalogApplication(context, authority), replay = await app.preflight(command, readReplay);
  const check = async (planned?: Channel, selected = command.modelId === null ? [] : [command.modelId]) => {
    if (planned && command.action === 'activate') await checkConfiguredCatalogFacts(context, command.scopeId, planned, selected, command.modelId === null);
  };
  return { replay, check, write: async (planned?: Channel, selected?: string[]) => { await check(planned, selected); return replay ?? app.apply(command); },
    authorizeResume: () => app.preflight(command) };
}
export async function checkConfiguredCatalogFacts(context: Context, scopeId: string, planned: Channel, selected: readonly string[], opensChannel: boolean) {
  const reader = await openSqliteModelCatalogReader(await context.path(), activationReceiptOptions(context));
  try { await checkCatalogActivationFacts(reader, scopeId, planned, selected, opensChannel && planned.activation?.state !== 'active'); }
  finally { reader.close(); }
}
/** Read-only listing (WORKER-CURRENCY-2). `modelUse: false` (connect, KG6 F7): the authorized catalog facts only, without the chat state that reads model use. */
export async function inspectConfiguredModelCatalog(projectRoot: string, query: ModelCatalogQuery, options: ConfigLoadOptions = {}, use: Readonly<{ modelUse?: false }> = {}, snapshot?: ModelInspectionSnapshot) {
  try {
    const context = await (snapshot?.context() ?? loadConfiguredScopeContext(projectRoot, query.scopeId, options, 'read')), { config } = context;
    const result = await catalogApplication(context).inspect(query);
    if (use.modelUse === false || !config.provider_catalog) return result;
    const declared = (snapshot?.declared ?? await inspectDeclaredModels(projectRoot, options)).catalog;
    if (!declared) return result;
    return { ...result, channels: await Promise.all(result.channels.map(async channel => {
      if (channel.access !== 'allowed') return channel;
      const provider = declared.providers.find(provider => provider.id === channel.channelId && provider.version === channel.providerVersion);
      return { ...channel, models: await Promise.all(channel.models.map(async entry => {
        const model = provider?.models.find(model => model.nativeId === entry.modelId);
        if (!model) return entry;
        const chat = await inspectConfiguredModelActivation(projectRoot, { schemaVersion: 1, scopeId: query.scopeId,
          reference: { providerId: provider!.id, providerVersion: provider!.version, modelId: model.id, modelVersion: model.version } }, options, {}, snapshot);
        const chatState = chat.activation?.state ?? null;
        return { ...entry, chatState, activationConflict: !(chatState === 'active' && (!channel.activation || !entry.activation)) && (chatState === 'active') !== (channel.activation?.state === 'active' && entry.activation?.state === 'active'),
          ...(chat.governedUse ? { governedUse: chat.governedUse } : {}) }; // workers never activated = /setup, not reconcile
      })) };
    })) };
  } catch (error) { throw queryFailure(error); }
}

/** Authorize required enabling writes before publication, and verify the original cascade on replay. */
export async function applyConfiguredModelCatalog(root: string, input: unknown, options: ConfigLoadOptions = {}) {
  try {
    const parsed = modelCatalogCommandSchema.safeParse(input);
    if (!parsed.success) throw new ModelCatalogError('MODEL_CATALOG_INVALID');
    const command = parsed.data, { scopeId } = command;
    const context = await loadConfiguredScopeContext(root, scopeId, options, command.action === 'register' ? 'write' : 'read');
    if (command.action === 'register') return await catalogApplication(context, undefined, true).apply(command);
    const authority = activationAuthority(root, scopeId, options, context), enabling = command.action === 'activate';
    const parent = await planCatalogWrite(context, authority, command, true);
    // The parent receipt is verified completely when it is obtained (stored, or returned by the writer), before any child.
    const verified = <T extends { readonly receipt: Parameters<typeof verifyCatalogActivationChange>[0] }>(result: T) => { verifyCatalogActivationChange(result.receipt, command); return result; };
    const off = !parent.replay && !enabling ? verified(await parent.write()) : null;
    const replay = parent.replay ? verified(parent.replay) : off?.replayed ? off : null;
    const channel = (await catalogApplication(context, authority).inspect({ schemaVersion: 1, scopeId, channelId: command.channelId }))
      .channels.find(row => row.access === 'allowed');
    if (!replay && enabling) await authority.witness('models.catalog.activate');
    const proof = catalogEvidence(context, authority, command);
    const basis = replay ? await proof.read() : null;
    const children: (typeof command | ModelActivationCommand)[] = replay && channel ? await proof.settled(replay, channel) : [];
    if (replay && basis !== null && proof.matches(basis, children)) return replay;
    const settled = new Set(children.map(child => child.commandId)), prepare = [];
    let selected: string[] = [];
    if (channel) {
      const declaration = async (current: Context) => (await configuredDeclarations(current))?.providers
        .find(provider => provider.id === channel.channelId && provider.version === channel.providerVersion);
      const kind = PROVIDER_CONNECT_REGISTRY.kinds.find(kind => kind.connect?.seed === channel.channelId);
      const plan = (id: string, modelId: string | null, expectedRevision: number) => {
        if (settled.has(id)) return;
        const childCommand = { schemaVersion: 1 as const, commandId: id, scopeId, action: 'activate' as const, channelId: channel.channelId, modelId, expectedRevision };
        children.push(childCommand);
        prepare.push(async () => {
          const planned = await planCatalogWrite(context, authority, childCommand);
          return async () => verifyCatalogActivationChange((await planned.write(channel, selected)).receipt, childCommand);
        });
      };
      const priced = kind ? channel.models.filter(row => providerConnectModelPriced(kind, row.model.nativeId)).map(row => row.modelId) : [];
      const at = replay?.receipt.admittedAtMs ?? Date.now();
      const declared = await declaration(context), cascade = planCatalogStateCascade(command, channel, declared, priced, at);
      selected = cascade.map(row => row.entry.modelId);
      const selectedDeclarations = (provider: typeof declared) => provider?.models.filter(model => selected.includes(model.nativeId)) ?? [];
      if (enabling) authority.pin(selectedDeclarations(declared), async current => selectedDeclarations(await declaration(current)));
      if (enabling && command.modelId !== null && channel.activation?.state !== 'active')
        plan(proof.child('channel', 'activate'), null, channel.activation?.revision ?? 0);
      for (const { entry, reference, activateWorker } of cascade) {
        if (activateWorker) plan(proof.child(entry.modelId, 'worker'), entry.modelId, 0);
        const id = proof.child(entry.modelId, 'chat');
        if (!reference || settled.has(id)) continue;
        const current = (await inspectConfiguredModelActivation(root, { schemaVersion: 1, scopeId, reference }, options, { modelUse: false })).activation;
        if (enabling ? current?.state === 'active' : current?.state !== 'active') continue;
        const binding = await configuredBinding(context).inspect(reference);
        if (binding.status !== 'declared') continue;
        const childCommand = modelActivationCommandSchema.parse({ schemaVersion: 1, commandId: id, scopeId, reference, expectedBinding: binding.binding,
          expectedRevision: current?.revision ?? 0, ...(enabling ? { action: 'activate', catalogRevision: binding.catalogRevision } : { action: 'deactivate' }) });
        if (off && !replay) { await admitConfiguredChatActivation(root, childCommand, options); continue; }
        const chat = configuredChatActivation(childCommand, context, authority);
        children.push(childCommand);
        prepare.push(async () => { await chat.preflight(); return chat.write; });
      }
    }
    if (off && !replay) return off;
    if (replay) {
      if (basis === null && !prepare.length) return replay;
      if (basis === null || !proof.matches(basis, children)) throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
      const current = channel && (command.modelId === null ? channel.activation : channel.models.find(row => row.modelId === command.modelId)?.activation);
      if (current?.revision !== replay.receipt.changes[0]?.revision || current?.state !== (enabling ? 'active' : 'inactive'))
        throw new ModelCatalogError('MODEL_CATALOG_REVISION_CONFLICT');
      await parent.authorizeResume();
      if (enabling) await authority.witness('models.catalog.activate');
    }
    const writes = [];
    for (const preflight of prepare) writes.push(await preflight());
    if (!replay && enabling) { await parent.check(channel, selected); await proof.record(children); }
    const result = replay ?? verified(await parent.write(channel, selected));
    for (const write of writes) await write();
    return result;
  } catch (error) { throw queryFailure(error); }
}
