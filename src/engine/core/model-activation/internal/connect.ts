import { admittedToolchains, compareToolchainVersions, extractToolchainVersion, type ToolchainAdmissionSource } from '#engine/core/toolchain-currency/index.js';
import { modelInvocationBillingAxis } from '#engine/core/provider-spend/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AUDIT_EVENT_SCHEMA_VERSION, MODEL_CONNECT_OPERATION_ID, endpointMayCarryKey, isAiPrincipal, modelConnectCommandSchema, parseProviderCatalog, parseProviderCatalogDocument, parseModelInvocationProfile, type AuditEvent, type JsonObject,
  type ModelActivationRecord, type ModelBindingDefinition, type ModelConnectCommand, type ModelConnectResult, type ModelConnectStepState, type ModelReference,
  type CatalogModel, type ProviderCatalog, type ProviderCatalogDocument, type VerifiedPrincipal } from '#domain/index.js';

export type ModelConnectLayer = 'project' | 'global';
/** What `models.connect` needs of one registry kind (the adapter's data, read through the port: engine never imports an adapter). */
export type ModelConnectKind = Readonly<{ id: string; available: boolean; endpoint: Readonly<{ default: string | null; editable: boolean }>;
  keyRequired: boolean; connect: Readonly<{ chatPath: string | null; seed: string | null; priceRequired?: boolean; personOnly?: boolean; preview?: boolean; catalogOnly?: boolean; headless?: boolean; pull?: 'available' | 'pick' }> | null }>;
/** `deliveryHeadroomBytes`: result-frame bytes a seeded profile keeps unused on its tightest surface, so later governed growth of the same profile
 * (cache TTL, a TLS CA, a longer catalog revision, version digits) still delivers (P1 DELIVERY-FIT 2026-10-09: an exact fit failed after `cache: '5m'`). */
export type ModelConnectDefaults = Readonly<{ requestMaxBytes: number; responseMaxBytes: number; timeoutMs: number; maxInFlight: number; maxOutputTokens: number; currency: string;
  deliveryHeadroomBytes: number }>;
/** A registered ledger catalog row (M4): the channel's provider version, the row's revision and its v3 entry (its `connect` terms price a model
 * the adapter's shipped tables do not list). */
export type ModelConnectCatalogRow = Readonly<{ providerVersion: number; modelRevision: number; model: CatalogModel }>;
export type ModelConnectBinding = Readonly<{ status: 'declared'; catalogRevision: string; definition: ModelBindingDefinition;
  binding: Readonly<{ encodingVersion: 1; algorithm: 'sha256'; digest: string }> }> | Readonly<{ status: 'not-configured' | 'not-declared' }>;
/** Every effect of the operation goes through an existing governed owner behind one of these ports (composition binds them). */
export interface ModelConnectPorts {
  kind(id: string): ModelConnectKind | null;
  readonly defaults: ModelConnectDefaults;
  /** The endpoint rule (https, plain http only to loopback): the canonical base, or null when refused. */
  endpoint(text: string): string | null;
  secretName(kind: string, base: string): string | null;
  seed(name: string): Promise<ProviderCatalogDocument>;
  /** M4: the installation's registered catalog row for this exact id on a channel (null: none, or not visible to this scope). */
  registered?(channelId: string, nativeId: string): Promise<ModelConnectCatalogRow | null>;
  available?(kind: string, endpoint: string): Promise<readonly string[] | null>;
  priced?(kind: string, nativeId: string, endpoint: string): boolean;
  workerActivate?(reference: ModelReference, commandId: string): Promise<boolean | void>;
  preflight?(scopeId: string, principal: VerifiedPrincipal, target?: Readonly<{ reference: ModelReference; nativeId: string }>): Promise<void>;
  /** Seedless kinds: a fresh bounded endpoint list must contain the selected exact id before any write. */
  discover?(kind: string, endpoint: string, nativeId: string): Promise<ProviderCatalogDocument>;
  /** The adapter part of the profile, validated by the adapter's own parser. `existing`: the adapter definition already written for this model on
   * the layer being written (null: a new profile), so the adapter keeps the person's own choices in it (CACHE-SLICE1: the cache TTL). */
  adapter(kind: string, input: Readonly<{ endpoint: string | null; credentialRef: string | null; nativeId: string; maxOutputTokens: number; currency: string; workspaceId?: string; existing?: JsonObject | null;
    catalog?: Readonly<{ channelId: string; modelRevision: number; model: CatalogModel }> | null }>): ConnectedAdapter | Promise<ConnectedAdapter>;
  principal(): Promise<VerifiedPrincipal>;
  /** The two authored layer documents and the merged configuration, read fresh. */
  layers(): Promise<Readonly<{ global: Record<string, unknown>; project: Record<string, unknown>; effective: Record<string, unknown> }>>;
  /** The governed config writer (policy, approval, audit): applied, or the pending approval that stopped it. */
  write(input: Readonly<{ keyPath: string; value: unknown; layer: ModelConnectLayer; commandId: string }>): Promise<null | Readonly<{ approvalId: string }>>;
  catalogHas(channelId: string, nativeId: string): Promise<boolean>;
  register(catalog: ProviderCatalogDocument, commandId: string): Promise<void>;
  binding(reference: ModelReference): Promise<ModelConnectBinding>;
  activation(reference: ModelReference): Promise<ModelActivationRecord | null>;
  activate(input: Readonly<{ commandId: string; reference: ModelReference; expectedRevision: number; catalogRevision: string; digest: string }>): Promise<void>;
  carryActivate?: ModelConnectPorts['activate'];
  /** Whether a profile's worst-case answer fits every result frame of this installation with `spareBytes` left over (activation refuses one that
   * does not fit with none). */
  delivers(profile: unknown, binding: Extract<ModelConnectBinding, { status: 'declared' }>, spareBytes: number): boolean;
  audit(event: AuditEvent): Promise<void>;
  policyRevision(): Promise<string>;
  keyStored(name: string): Promise<boolean | null>;
  service(): Promise<ModelConnectResult['service']>;
}
/** `billingAxis: subscription` only from a CLI kind's own adapter step (a trusted transport fact, never inferred from tariff data). */
export type ConnectedAdapter = Readonly<{ adapter: Readonly<{ id: string; version: number; definition: JsonObject }>; protocol: Readonly<{ family: string; version: string }>;
  tariff: 'published' | 'unmetered'; billingAxis?: 'subscription'; cli?: ModelConnectResult['cli'];
  /** The adapter's own concurrency bound (a CLI kind with one run dir: 1); absent = the registry default. */
  maxInFlight?: number }>;
export class ModelConnectError extends Error {
  constructor(readonly code: 'MODEL_CONNECT_INVALID' | 'MODEL_CONNECT_NOT_CONNECTABLE' | 'MODEL_CONNECT_ENDPOINT_FIXED' | 'MODEL_CONNECT_ENDPOINT_INVALID'
    | 'MODEL_CONNECT_MODEL_UNKNOWN' | 'MODEL_CONNECT_DECLARATION_CONFLICT' | 'MODEL_CONNECT_KEY_NAME_UNAVAILABLE' | 'MODEL_CONNECT_PRICE_REQUIRED'
    | 'MODEL_CONNECT_NO_AVAILABLE' | 'HEADLESS_PERSON_REQUIRED', readonly models: ModelConnectResult['models'] = []) { super(code); this.name = 'ModelConnectError'; }
}

const sameReference = (left: ModelReference, right: ModelReference) => left.providerId === right.providerId && left.providerVersion === right.providerVersion
  && left.modelId === right.modelId && left.modelVersion === right.modelVersion;
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
const step = (commandId: string, ...parts: readonly string[]) => [commandId, ...parts].join('.');
type Declared = ProviderCatalog['providers'][number]['models'][number];
type Target = Readonly<{ reference: ModelReference; nativeId: string; maxOutputTokens: number; contextWindow: number | null; seed: ProviderCatalogDocument | null;
  declare: Readonly<{ provider: Readonly<{ id: string; version: number }>; model: Declared }> | null;
  catalog: Readonly<{ channelId: string; modelRevision: number; model: CatalogModel }> | null }>;

const withoutCapabilities = (model: Declared) => ({ ...model, protocols: model.protocols.map(protocol => ({ ...protocol, capabilities: [] })) });
const capabilitiesAdded = (before: Declared, after: Declared) => isDeepStrictEqual(withoutCapabilities(before), withoutCapabilities(after))
  && before.protocols.every((protocol, index) => protocol.capabilities.every(capability => after.protocols[index]!.capabilities.some(row => isDeepStrictEqual(row, capability))));
/** The catalog with the model declared; null when it already declares exactly this model (a different declaration is a typed conflict). */
export function declareConnectedModel(current: ProviderCatalog | null, declare: NonNullable<Target['declare']>): ProviderCatalog | null {
  const providers = (current?.providers ?? []).map(provider => ({ ...provider, models: [...provider.models] }));
  const provider = providers.find(item => item.id === declare.provider.id && item.version === declare.provider.version);
  const existing = provider?.models.find(model => model.id === declare.model.id && model.version === declare.model.version);
  const normal = (model: Declared) => parseProviderCatalog({ schemaVersion: 1, revision: 'x', providers: [{ ...declare.provider, models: [model] }] }).providers[0]!.models[0];
  if (existing && isDeepStrictEqual(normal(existing), normal(declare.model))) return null;
  // BeUser AYSE-16: a reconnect that only adds capabilities the server now proves (e.g. tool calls) updates the declaration; any other difference stays a conflict.
  if (existing && !capabilitiesAdded(normal(existing)!, normal(declare.model)!)) throw new ModelConnectError('MODEL_CONNECT_DECLARATION_CONFLICT');
  if (existing) provider!.models[provider!.models.indexOf(existing)] = declare.model; else if (provider) provider.models.push(declare.model); else providers.push({ ...declare.provider, models: [declare.model] });
  // The revision names the content (deterministic: a re-run plans the same document).
  return parseProviderCatalog({ schemaVersion: 1, revision: `connect-${createHash('sha256').update(canonical(providers)).digest('hex').slice(0, 16)}`, providers });
}

/**
 * `models.connect` (T4-B D2, owner 2026-10-08): register the seed in the ledger catalog when missing, declare the model on the layer that authors
 * the catalog, carry this scope's activations that stay valid to the new revision, write the invocation profile (every layer that authors profiles,
 * the user layer first: a project snapshot stays a subset of it), activate, and record one `model-connect` audit event. Each write is its owner's
 * governed path with its own decision and record; a write waiting for approval stops the run, and the same command id continues after the approval
 * (every step first checks what is in place). It handles secret NAMES only.
 */
export class ModelConnectApplication {
  constructor(private readonly ports: ModelConnectPorts, private readonly now: () => number = Date.now) {}

  async connect(input: unknown): Promise<ModelConnectResult> {
    const parsed = modelConnectCommandSchema.safeParse(input);
    if (!parsed.success) throw new ModelConnectError('MODEL_CONNECT_INVALID');
    const command = parsed.data, ports = this.ports, kind = ports.kind(command.connection);
    if (!kind?.available || !kind.connect) throw new ModelConnectError('MODEL_CONNECT_NOT_CONNECTABLE');
    if (!kind.endpoint.editable && command.endpoint !== null) throw new ModelConnectError('MODEL_CONNECT_ENDPOINT_FIXED');
    // S3-3: a person's own CLI login is connected by that person only. S3-5: where its isolation realm is usable — the adapter step refuses
    // typed before any spawn or write otherwise, on every installation (no preview switch, no unisolated fallback).
    const principal = await ports.principal();
    if (kind.connect.personOnly && isAiPrincipal(principal)) throw new ModelConnectError('HEADLESS_PERSON_REQUIRED');
    if (kind.connect.catalogOnly && !ports.workerActivate) throw new ModelConnectError('MODEL_CONNECT_NOT_CONNECTABLE');
    // Codex headless (owner 2026-10-31): a worker kind with a headless step also writes the declaration, profile and chat activation (its CLI login
    // and consent choices are allowed); the worker image gate and worker activation stay its own.
    const profiled = !kind.connect.catalogOnly || kind.connect.headless === true;
    if (kind.connect.catalogOnly && (command.workspaceId || (!profiled && (command.cli || command.delegate)))) throw new ModelConnectError('MODEL_CONNECT_INVALID');
    // A CLI kind has no address and no key: its adapter step names the executable and the login directory instead.
    const chatPath = kind.connect.chatPath, address = command.endpoint ?? kind.endpoint.default, base = chatPath === null || address === null ? null : ports.endpoint(address);
    if (base === null && chatPath !== null) throw new ModelConnectError('MODEL_CONNECT_ENDPOINT_INVALID');
    const endpoint = base === null ? null : `${base}${chatPath}`, secure = endpoint !== null && endpointMayCarryKey(endpoint), keyName = base === null ? null : ports.secretName(kind.id, base);
    if (kind.keyRequired && secure && keyName === null) throw new ModelConnectError('MODEL_CONNECT_KEY_NAME_UNAVAILABLE');
    // A key is only ever named over https (`endpointMayCarryKey`, G2-7); a plain-http local server is reached without one (the adapters refuse a cleartext credential).
    const credentialRef = secure ? keyName : null, { scopeId } = command;
    if (isAiPrincipal(principal)) {
      if (!ports.preflight) throw new ModelConnectError('MODEL_CONNECT_NOT_CONNECTABLE');
      await ports.preflight(scopeId, principal);
    }
    let layers = await ports.layers();
    const effective = (): ProviderCatalog | null => layers.effective['provider_catalog'] === undefined ? null : parseProviderCatalog(layers.effective['provider_catalog']);
    const models: NonNullable<ModelConnectResult['models']>[number][] = [];
    const commands: ModelConnectCommand[] = [];
    let workerIds: readonly string[] | null = null, worker: ModelConnectResult['worker'];
    if ('pull' in command.model) {
      if (kind.connect.pull === 'pick') throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
      const seed = kind.connect.seed ? await ports.seed(kind.connect.seed) : null;
      // Owner 2026-10-31: a headless worker kind connects without a worker image; the image list gates only its worker activation.
      const listed = ports.available ? await ports.available(kind.id, base ?? '') : null, live = kind.connect.headless ? null : listed; if (kind.connect.headless) workerIds = listed;
      // BeUser M-01: a headless CLI pull connects the models with an admitted CLI version; the others are listed, never a refusal of the whole pull.
      const ready = (provider: { channel?: { kind?: string } | null }, model: { minCliVersion?: string | null }) => (kind.connect!.catalogOnly === true && !kind.connect!.headless) || provider.channel?.kind !== 'native-cli' || Boolean(model.minCliVersion); // a headless CLI model needs its admitted CLI version
      for (const provider of seed?.providers ?? []) for (const model of provider.models) if (model.lifecycle.state === 'active' && !ready(provider, model)) models.push({ nativeId: model.nativeId, state: 'notInCatalog', code: 'MODEL_CONNECT_MODEL_UNKNOWN' });
      const candidates = seed ? seed.providers.flatMap(provider => provider.models.filter(model => model.lifecycle.state === 'active' && ready(provider, model)).map(model => model.nativeId)) : live ?? [];
      for (const nativeId of candidates) {
        const state = live && !live.includes(nativeId) ? 'notOnKey' : ports.priced && !ports.priced(kind.id, nativeId, base ?? '') ? 'unpriced' : null;
        if (state) models.push({ nativeId, state }); else commands.push({ ...command, model: { nativeId } });
      }
      for (const nativeId of live ?? []) if (!candidates.includes(nativeId)) models.push({ nativeId, state: 'notInCatalog' });
    } else { // Mert M-35: a single-model catalog-only connect passes the same worker-image gate as the pull form (the port refuses without one)
      const listed = kind.connect.catalogOnly && ports.available ? await ports.available(kind.id, base ?? '') : null, nativeId = 'nativeId' in command.model ? command.model.nativeId : command.model.reference.modelId;
      if (kind.connect.headless) workerIds = listed; else if (listed && !listed.includes(nativeId)) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN'); commands.push(command); }
    const targets = await Promise.all(commands.map(item => this.target(kind, item, effective(), base ?? '')));
    const target = targets[0];
    if (!target) throw new ModelConnectError('MODEL_CONNECT_NO_AVAILABLE', models);
    if (isAiPrincipal(principal)) for (const target of targets) await ports.preflight!(scopeId, principal, target);
    const steps: { catalog: ModelConnectStepState; declaration: ModelConnectStepState; profile: ModelConnectStepState; activation: ModelConnectStepState; carried: number } =
      { catalog: 'skipped', declaration: 'skipped', profile: 'present', activation: 'present', carried: 0 };
    let tariff: ModelConnectResult['tariff'] = 'unmetered', cli: ModelConnectResult['cli'];
    const notCarried: { reference: ModelReference; code: string }[] = [], carriedModels: ModelReference[] = [];
    const result = (status: ModelConnectResult['status'], approval: ModelConnectResult['approval'] = null, keyStored: boolean | null = null,
      service: ModelConnectResult['service'] = null): ModelConnectResult => Object.freeze({ schemaVersion: 1, operation: MODEL_CONNECT_OPERATION_ID, commandId: command.commandId,
      scopeId, connection: command.connection, status, reference: target.reference, ...('pull' in command.model ? { models: [...models] } : {}), credentialRef, keyStored, steps: Object.freeze({ ...steps }), notCarried: Object.freeze([...notCarried]), carriedModels: Object.freeze([...carriedModels]), tariff, ...(cli ? { cli } : {}), ...(worker ? { worker } : {}), approval, service });
    const write = async (keyPath: string, value: unknown, layer: ModelConnectLayer, id: string) => {
      const pending = await ports.write({ keyPath, value, layer, commandId: id });
      layers = await ports.layers();
      return pending ? result('approval-pending', { approvalId: pending.approvalId, keyPath, layer }) : null;
    };
    // Validate every tariff before the first write. One catalog and declaration change for the entire connection.
    const adapters = !profiled ? [] : await Promise.all(targets.map(target => ports.adapter(kind.id, { endpoint, credentialRef, nativeId: target.nativeId,
      maxOutputTokens: target.maxOutputTokens, currency: ports.defaults.currency, catalog: target.catalog, ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}), existing: null })));
    tariff = adapters.some(adapter => adapter.tariff === 'published') ? 'published' : 'unmetered'; cli = adapters[0]?.cli;
    const seeds = [...new Map(targets.filter(target => target.seed !== null).map(target => [target.seed!.revision, target.seed!])).values()];
    if (seeds.length) {
      const providers = new Map<string, ProviderCatalogDocument['providers'][number]>();
      for (const seed of seeds) for (const provider of seed.providers) {
        const previous = providers.get(provider.id);
        providers.set(provider.id, previous ? { ...provider, models: [...new Map([...previous.models, ...provider.models].map(model => [model.nativeId, model])).values()] } : provider);
      }
      const merged = seeds.length === 1 ? seeds[0]! : parseProviderCatalogDocument({ ...seeds[0], revision: `connect-${createHash('sha256').update(canonical([...providers.values()])).digest('hex').slice(0, 16)}`, providers: [...providers.values()] });
      if (await Promise.all(merged.providers.flatMap(provider => provider.models.map(model => ports.catalogHas(provider.id, model.nativeId)))).then(rows => rows.every(Boolean))) steps.catalog = 'present';
      else { await ports.register(merged, step(command.commandId, 'catalog')); steps.catalog = 'written'; }
    }
    const where = { global: layers.global['provider_catalog'] !== undefined, project: layers.project['provider_catalog'] !== undefined };
    const layer: ModelConnectLayer = where.project || !where.global ? 'project' : 'global';
    let next = layers[layer]['provider_catalog'] === undefined ? null : parseProviderCatalog(layers[layer]['provider_catalog']);
    let changed = false;
    for (const target of targets) if (profiled && target.declare) { const declared = declareConnectedModel(next, target.declare); if (declared) { next = declared; changed = true; } }
    if (changed) {
      const carry = await this.carryable(effective(), targets.map(target => target.reference));
      const stopped = await write('provider_catalog', next, layer, step(command.commandId, 'declaration'));
      if (stopped) return stopped;
      steps.declaration = 'written';
      for (const [index, item] of carry.entries()) {
        try {
          const binding = await ports.binding(item.reference);
          if (binding.status !== 'declared' || binding.binding.digest !== item.digest) { notCarried.push({ reference: item.reference, code: 'MODEL_ACTIVATION_CATALOG_CONFLICT' }); continue; }
          await (ports.carryActivate ?? ports.activate)({ commandId: step(command.commandId, 'carry', String(index)), reference: item.reference, expectedRevision: item.revision,
            catalogRevision: binding.catalogRevision, digest: binding.binding.digest });
          steps.carried++; carriedModels.push(item.reference);
        } catch (error) { notCarried.push({ reference: item.reference, code: String((error as { code?: unknown })?.code ?? 'MODEL_ACTIVATION_FAILED') }); }
      }
    } else if (profiled && targets.some(target => target.declare)) steps.declaration = 'present';
    const authored = { global: layers.global['provider_invocation_profiles'] !== undefined, project: layers.project['provider_invocation_profiles'] !== undefined };
    const profileLayers: ModelConnectLayer[] = !profiled ? [] : authored.global && authored.project ? ['global', 'project'] : authored.global ? ['global'] : ['project'];
    const planned = new Map(profileLayers.map(layer => [layer, [...(((layers[layer]['provider_invocation_profiles'] as { profiles?: Record<string, unknown>[] } | undefined)?.profiles) ?? [])]]));
    for (const [index, target] of (!profiled ? [] : targets).entries()) {
    const adapterInput = { endpoint, credentialRef, nativeId: target.nativeId, maxOutputTokens: target.maxOutputTokens, currency: ports.defaults.currency, catalog: target.catalog, ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}) };
    const adapter = adapters[index]!;
    const binding = await ports.binding(target.reference);
    if (binding.status !== 'declared') throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    // 3. The scope's invocation profile: endpoint preset, the key NAME, tariff, limits, binding digest.
    const profileId = [command.connection, target.reference.providerId, target.reference.modelId, String(target.reference.modelVersion)].join('.');
    const build = (version: number, responseMaxBytes: number, shaped: ConnectedAdapter, contextWindow: unknown, known: Record<string, unknown> | undefined) => {
      const value = { schemaVersion: 1, id: profileId, version, scopeId, reference: target.reference,
      bindingDigest: binding.binding.digest, protocol: shaped.protocol, adapter: shaped.adapter, allocation: { id: profileId, maxCalls: null, maxInFlight: shaped.maxInFlight ?? ports.defaults.maxInFlight },
      limits: { requestMaxBytes: ports.defaults.requestMaxBytes, responseMaxBytes, timeoutMs: ports.defaults.timeoutMs },
      ...(contextWindow === null || contextWindow === undefined ? {} : { contextWindowTokens: contextWindow }) };
      // Reconnect preserves authored v1 and an explicit v2 path; new profiles take the validated transport's actual axis.
      return known?.['schemaVersion'] === 1 && !shaped.billingAxis ? value : { ...value, schemaVersion: 2,
        billingAxis: shaped.billingAxis ?? modelInvocationBillingAxis(parseModelInvocationProfile(known ?? value)) };
    };
    const mine = (item: Record<string, unknown>) => item['scopeId'] === scopeId && (item['id'] === profileId || isDeepStrictEqual(item['reference'], target.reference));
    const layerProfiles = (layer: ModelConnectLayer) => planned.get(layer)!;
    for (const layer of profileLayers) {
      const profiles = layerProfiles(layer);
      const existing = profiles.find(mine), version = typeof existing?.['version'] === 'number' ? existing['version'] : 1;
      // An existing profile keeps what the person chose in its definition (CACHE-SLICE1: no silent cache migration on a re-run). A layer without
      // its own copy takes the other authored layer's (the user layer first), so a project copy stays equal to the user-layer profile.
      const known = existing ?? profileLayers.map(item => layerProfiles(item).find(mine)).find(Boolean);
      // Reconnecting an exact reference has no seed metadata: keep the authored window, falling back to the seed for a missing value.
      const contextWindow = known?.['contextWindowTokens'] ?? target.contextWindow;
      const previous = (known?.['adapter'] as { definition?: unknown } | undefined)?.definition;
      const shaped = known ? await ports.adapter(kind.id, { ...adapterInput, existing: previous && typeof previous === 'object' ? previous as JsonObject : {} }) : adapter;
      cli = shaped.cli ?? cli;
      // Sized on the profile as this layer writes it (its kept definition, its next version), with the registry's headroom left over.
      const responseMaxBytes = this.deliverable(bytes => ports.delivers(build(existing ? version + 1 : 1, bytes, shaped, contextWindow, known), binding, ports.defaults.deliveryHeadroomBytes));
      if (existing && isDeepStrictEqual(existing, build(version, responseMaxBytes, shaped, contextWindow, known))) continue;
      planned.set(layer, [...profiles.filter(item => !mine(item)), build(existing ? version + 1 : 1, responseMaxBytes, shaped, contextWindow, known)]);
    }
    }
    for (const layer of profileLayers) {
      const profiles = planned.get(layer)!;
      if (isDeepStrictEqual(profiles, (layers[layer]['provider_invocation_profiles'] as { profiles?: unknown } | undefined)?.profiles ?? [])) continue;
      const stopped = await write('provider_invocation_profiles', { schemaVersion: 1, profiles }, layer, step(command.commandId, 'profile', layer));
      if (stopped) return stopped;
      steps.profile = 'written';
    }
    for (const [index, target] of targets.entries()) {
    if (profiled) {
    const binding = await ports.binding(target.reference);
    if (binding.status !== 'declared') throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    // 4. The chat activation at the current revision (after the profile: activation checks the profile's delivery).
    const activation = await ports.activation(target.reference);
    if (!(activation?.state === 'active' && activation.catalogRevision === binding.catalogRevision && activation.binding.digest === binding.binding.digest)) {
      // Without an admitted worker image a headless worker kind takes the chat activation only (the combined one would also switch the worker model on).
      await (kind.connect.headless && !workerIds?.includes(target.nativeId) ? ports.carryActivate ?? ports.activate : ports.activate)({ commandId: step(command.commandId, 'activate', String(index)), reference: target.reference, expectedRevision: activation?.revision ?? 0,
        catalogRevision: binding.catalogRevision, digest: binding.binding.digest });
      steps.activation = 'written';
    }
    }
    if (kind.connect.headless && !workerIds?.includes(target.nativeId)) worker = 'image-required'; // the image gates only the worker activation, and the result says so
    else if (await ports.workerActivate?.(target.reference, step(command.commandId, 'worker', String(index)))) { steps.activation = 'written'; if (kind.connect.headless) worker ??= 'written'; } else if (kind.connect.headless) worker ??= 'present';
    models.push({ nativeId: target.nativeId, reference: target.reference, state: 'connected' });
    }
    if (!profiled) steps.profile = 'skipped';
    // 5. One record of the connection (names only), then the key's presence and the running service's state for the person.
    await ports.audit({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
      policyRevision: await ports.policyRevision(), atMs: this.now(), subject: { kind: 'model-connect', commandId: command.commandId, connection: command.connection,
        reference: target.reference, credentialRef, steps: { ...steps }, notCarried: notCarried.map(item => item.reference) } });
    return result('connected', null, credentialRef ? await ports.keyStored(credentialRef) : null, await ports.service());
  }

  /**
   * Exact seed/discovered id, or an already declared reference. Discovery is a port: no network or endpoint fact is guessed in the engine.
   * M4: a seeded kind also finds an exact id the installation registered on the seed's channel (`models catalog register --file`); its row is
   * handed to the adapter, whose shipped tables stay first. A seed entry keeps its own identity and declaration (unchanged bytes).
   */
  private async target(kind: ModelConnectKind, command: ModelConnectCommand, catalog: ProviderCatalog | null, base: string): Promise<Target> {
    const fallback = this.ports.defaults.maxOutputTokens;
    const registered = async (channelId: string, version: number | null, nativeId: string) => {
      const row = this.ports.registered ? await this.ports.registered(channelId, nativeId) : null;
      return row && (version === null || row.providerVersion === version) ? row : null;
    };
    const facts = (model: unknown) => model as { maxOutputTokens?: number | null; contextWindow?: number | null };
    if ('nativeId' in command.model) {
      const seedName = kind.connect?.seed, nativeId = command.model.nativeId;
      if (!seedName && !this.ports.discover) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
      const seed = seedName ? await this.ports.seed(seedName) : await this.ports.discover!(kind.id, base, nativeId);
      for (const provider of seed.providers) {
        const model = provider.models.find(item => item.nativeId === nativeId);
        const row = seedName ? await registered(provider.id, model ? provider.version : null, nativeId) : null;
        const fromRow = row && { channelId: provider.id, modelRevision: row.modelRevision, model: row.model };
        if (model) {
          return { reference: { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version }, nativeId, seed,
            maxOutputTokens: facts(model).maxOutputTokens ?? fallback, contextWindow: facts(model).contextWindow ?? null, catalog: fromRow,
            declare: { provider: { id: provider.id, version: provider.version }, model: { id: model.id, version: model.version, nativeId, protocols: model.protocols } } };
        }
        if (row) {
          // Already in the ledger catalog: nothing to register; the declaration is the row's own identity and protocols.
          return { reference: { providerId: provider.id, providerVersion: row.providerVersion, modelId: row.model.id, modelVersion: row.model.version }, nativeId, seed: null,
            maxOutputTokens: facts(row.model).maxOutputTokens ?? fallback, contextWindow: facts(row.model).contextWindow ?? null, catalog: fromRow,
            declare: { provider: { id: provider.id, version: row.providerVersion }, model: { id: row.model.id, version: row.model.version, nativeId, protocols: row.model.protocols } } };
        }
      }
      throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    }
    if (!('reference' in command.model)) throw new ModelConnectError('MODEL_CONNECT_INVALID');
    const reference = command.model.reference;
    const model = catalog?.providers.find(provider => provider.id === reference.providerId && provider.version === reference.providerVersion)
      ?.models.find(item => item.id === reference.modelId && item.version === reference.modelVersion);
    if (!model) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    const row = await registered(reference.providerId, reference.providerVersion, model.nativeId);
    return { reference, nativeId: model.nativeId, maxOutputTokens: fallback, contextWindow: null, declare: null, seed: null,
      catalog: row && { channelId: reference.providerId, modelRevision: row.modelRevision, model: row.model } };
  }
  /** This scope's other models active under the catalog revision being replaced (re-activated afterwards when their binding is unchanged). */
  private async carryable(before: ProviderCatalog | null, skip: readonly ModelReference[]) {
    const carry: { reference: ModelReference; revision: number; digest: string }[] = [];
    for (const provider of before?.providers ?? []) for (const model of provider.models) {
      const reference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version };
      if (skip.some(item => sameReference(reference, item))) continue;
      const activation = await this.ports.activation(reference).catch(() => null);
      if (activation?.state === 'active' && activation.catalogRevision === before!.revision) carry.push({ reference, revision: activation.revision, digest: activation.binding.digest });
    }
    return carry;
  }
  /** The registry's response limit, narrowed to the largest one every result frame of this installation delivers with the registry's headroom to spare
   * (unchanged when none fits: activation then refuses it). */
  private deliverable(fits: (bytes: number) => boolean): number {
    let high = this.ports.defaults.responseMaxBytes;
    if (fits(high)) return high;
    let low = 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(middle)) low = middle; else high = middle - 1; }
    return fits(low) ? low : this.ports.defaults.responseMaxBytes;
  }
}

/** Worker-only connect uses the admitted image's measured CLI pin; no published Cursor version is invented. */
export function workerConnectionModelIds(seed: ProviderCatalogDocument, source: ToolchainAdmissionSource): readonly string[] {
  const pins = admittedToolchains(source);
  return seed.providers.flatMap(provider => provider.models.filter(model => pins.some(pin => {
    if (pin.provider !== provider.channel.cli) return false;
    const observed = extractToolchainVersion(pin.provider, pin.cliVersion);
    return observed !== null && (model.minCliVersion === null || compareToolchainVersions(observed, model.minCliVersion) >= 0);
  })).map(model => model.nativeId));
}
