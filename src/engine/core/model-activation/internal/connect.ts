import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AUDIT_EVENT_SCHEMA_VERSION, MODEL_CONNECT_OPERATION_ID, modelConnectCommandSchema, parseProviderCatalog, type AuditEvent, type JsonObject,
  type ModelActivationRecord, type ModelBindingDefinition, type ModelConnectCommand, type ModelConnectResult, type ModelConnectStepState, type ModelReference,
  type ProviderCatalog, type ProviderCatalogDocument, type VerifiedPrincipal } from '#domain/index.js';

export type ModelConnectLayer = 'project' | 'global';
/** What `models.connect` needs of one registry kind (the adapter's data, read through the port: engine never imports an adapter). */
export type ModelConnectKind = Readonly<{ id: string; available: boolean; endpoint: Readonly<{ default: string | null; editable: boolean }>;
  keyRequired: boolean; connect: Readonly<{ chatPath: string; seed: string | null }> | null }>;
export type ModelConnectDefaults = Readonly<{ requestMaxBytes: number; responseMaxBytes: number; timeoutMs: number; maxInFlight: number; maxOutputTokens: number; currency: string }>;
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
  /** The adapter part of the profile, validated by the adapter's own parser. */
  adapter(kind: string, input: Readonly<{ endpoint: string; credentialRef: string | null; nativeId: string; maxOutputTokens: number; currency: string }>):
    Readonly<{ adapter: Readonly<{ id: string; version: number; definition: JsonObject }>; protocol: Readonly<{ family: string; version: string }>; tariff: 'published' | 'unmetered' }>;
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
  /** Whether a profile's worst-case answer fits every result frame of this installation (activation refuses one that does not). */
  delivers(profile: unknown, binding: Extract<ModelConnectBinding, { status: 'declared' }>): boolean;
  audit(event: AuditEvent): Promise<void>;
  policyRevision(): Promise<string>;
  keyStored(name: string): Promise<boolean | null>;
  service(): Promise<ModelConnectResult['service']>;
}
export class ModelConnectError extends Error {
  constructor(readonly code: 'MODEL_CONNECT_INVALID' | 'MODEL_CONNECT_NOT_CONNECTABLE' | 'MODEL_CONNECT_ENDPOINT_FIXED' | 'MODEL_CONNECT_ENDPOINT_INVALID'
    | 'MODEL_CONNECT_MODEL_UNKNOWN' | 'MODEL_CONNECT_DECLARATION_CONFLICT' | 'MODEL_CONNECT_KEY_NAME_UNAVAILABLE') { super(code); this.name = 'ModelConnectError'; }
}

const sameReference = (left: ModelReference, right: ModelReference) => left.providerId === right.providerId && left.providerVersion === right.providerVersion
  && left.modelId === right.modelId && left.modelVersion === right.modelVersion;
const canonical = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
const step = (commandId: string, ...parts: readonly string[]) => [commandId, ...parts].join('.');
type Declared = ProviderCatalog['providers'][number]['models'][number];
type Target = Readonly<{ reference: ModelReference; nativeId: string; maxOutputTokens: number; contextWindow: number | null; seed: ProviderCatalogDocument | null;
  declare: Readonly<{ provider: Readonly<{ id: string; version: number }>; model: Declared }> | null }>;

/** The catalog with the model declared; null when it already declares exactly this model (a different declaration is a typed conflict). */
export function declareConnectedModel(current: ProviderCatalog | null, declare: NonNullable<Target['declare']>): ProviderCatalog | null {
  const providers = (current?.providers ?? []).map(provider => ({ ...provider, models: [...provider.models] }));
  const provider = providers.find(item => item.id === declare.provider.id && item.version === declare.provider.version);
  const existing = provider?.models.find(model => model.id === declare.model.id && model.version === declare.model.version);
  const normal = (model: Declared) => parseProviderCatalog({ schemaVersion: 1, revision: 'x', providers: [{ ...declare.provider, models: [model] }] }).providers[0]!.models[0];
  if (existing) { if (isDeepStrictEqual(normal(existing), normal(declare.model))) return null; throw new ModelConnectError('MODEL_CONNECT_DECLARATION_CONFLICT'); }
  if (provider) provider.models.push(declare.model); else providers.push({ ...declare.provider, models: [declare.model] });
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
    const address = command.endpoint ?? kind.endpoint.default, base = address === null ? null : ports.endpoint(address);
    if (base === null) throw new ModelConnectError('MODEL_CONNECT_ENDPOINT_INVALID');
    const endpoint = `${base}${kind.connect.chatPath}`, secure = new URL(endpoint).protocol === 'https:', keyName = ports.secretName(kind.id, base);
    if (kind.keyRequired && secure && keyName === null) throw new ModelConnectError('MODEL_CONNECT_KEY_NAME_UNAVAILABLE');
    // A key is only ever named over https; a plain-http local server is reached without one (the adapters refuse a cleartext credential).
    const credentialRef = secure ? keyName : null, { scopeId } = command;
    const principal = await ports.principal();
    let layers = await ports.layers();
    const effective = (): ProviderCatalog | null => layers.effective['provider_catalog'] === undefined ? null : parseProviderCatalog(layers.effective['provider_catalog']);
    const target = await this.target(kind, command, effective());
    const steps: { catalog: ModelConnectStepState; declaration: ModelConnectStepState; profile: ModelConnectStepState; activation: ModelConnectStepState; carried: number } =
      { catalog: 'skipped', declaration: 'skipped', profile: 'present', activation: 'present', carried: 0 };
    let tariff: ModelConnectResult['tariff'] = 'unmetered';
    const result = (status: ModelConnectResult['status'], approval: ModelConnectResult['approval'] = null, keyStored: boolean | null = null,
      service: ModelConnectResult['service'] = null): ModelConnectResult => Object.freeze({ schemaVersion: 1, operation: MODEL_CONNECT_OPERATION_ID, commandId: command.commandId,
      scopeId, connection: command.connection, status, reference: target.reference, credentialRef, keyStored, steps: Object.freeze({ ...steps }), tariff, approval, service });
    const write = async (keyPath: string, value: unknown, layer: ModelConnectLayer, id: string) => {
      const pending = await ports.write({ keyPath, value, layer, commandId: id });
      layers = await ports.layers();
      return pending ? result('approval-pending', { approvalId: pending.approvalId, keyPath, layer }) : null;
    };
    // 1. Ledger catalog facts (installation-wide, no restart).
    if (target.seed && target.declare) {
      if (await ports.catalogHas(target.declare.provider.id, target.nativeId)) steps.catalog = 'present';
      else { await ports.register(target.seed, step(command.commandId, 'catalog')); steps.catalog = 'written'; }
    }
    // 2. The declaration, where the catalog is authored (an authored layer replaces the one below; else the project).
    if (target.declare) {
      const where = { global: layers.global['provider_catalog'] !== undefined, project: layers.project['provider_catalog'] !== undefined };
      const layer: ModelConnectLayer = where.project || !where.global ? 'project' : 'global', current = layers[layer]['provider_catalog'];
      const next = declareConnectedModel(current === undefined ? null : parseProviderCatalog(current), target.declare);
      if (!next) steps.declaration = 'present';
      else {
        const before = effective(), carry = await this.carryable(before, target.reference);
        const stopped = await write('provider_catalog', next, layer, step(command.commandId, 'declaration'));
        if (stopped) return stopped;
        steps.declaration = 'written';
        for (const [index, item] of carry.entries()) {
          const binding = await ports.binding(item.reference);
          if (binding.status !== 'declared' || binding.binding.digest !== item.digest) continue;
          await ports.activate({ commandId: step(command.commandId, 'carry', String(index)), reference: item.reference, expectedRevision: item.revision,
            catalogRevision: binding.catalogRevision, digest: binding.binding.digest });
          steps.carried++;
        }
      }
    }
    const binding = await ports.binding(target.reference);
    if (binding.status !== 'declared') throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    // 3. The scope's invocation profile: endpoint preset, the key NAME, tariff, limits, binding digest.
    const adapter = ports.adapter(kind.id, { endpoint, credentialRef, nativeId: target.nativeId, maxOutputTokens: target.maxOutputTokens, currency: ports.defaults.currency });
    tariff = adapter.tariff;
    const profileId = [command.connection, target.reference.providerId, target.reference.modelId, String(target.reference.modelVersion)].join('.');
    const build = (version: number, responseMaxBytes: number) => ({ schemaVersion: 1, id: profileId, version, scopeId, reference: target.reference,
      bindingDigest: binding.binding.digest, protocol: adapter.protocol, adapter: adapter.adapter, allocation: { id: profileId, maxCalls: null, maxInFlight: ports.defaults.maxInFlight },
      limits: { requestMaxBytes: ports.defaults.requestMaxBytes, responseMaxBytes, timeoutMs: ports.defaults.timeoutMs },
      ...(target.contextWindow ? { contextWindowTokens: target.contextWindow } : {}) });
    const responseMaxBytes = this.deliverable(bytes => ports.delivers(build(1, bytes), binding));
    const authored = { global: layers.global['provider_invocation_profiles'] !== undefined, project: layers.project['provider_invocation_profiles'] !== undefined };
    const targets: ModelConnectLayer[] = authored.global && authored.project ? ['global', 'project'] : authored.global ? ['global'] : ['project'];
    for (const layer of targets) {
      const profiles = ((layers[layer]['provider_invocation_profiles'] as { profiles?: Record<string, unknown>[] } | undefined)?.profiles) ?? [];
      const mine = (item: Record<string, unknown>) => item['scopeId'] === scopeId && (item['id'] === profileId || isDeepStrictEqual(item['reference'], target.reference));
      const existing = profiles.find(mine), version = typeof existing?.['version'] === 'number' ? existing['version'] : 1;
      if (existing && isDeepStrictEqual(existing, build(version, responseMaxBytes))) continue;
      const stopped = await write('provider_invocation_profiles', { schemaVersion: 1, profiles: [...profiles.filter(item => !mine(item)), build(existing ? version + 1 : 1, responseMaxBytes)] },
        layer, step(command.commandId, 'profile', layer));
      if (stopped) return stopped;
      steps.profile = 'written';
    }
    // 4. The chat activation at the current revision (after the profile: activation checks the profile's delivery).
    const activation = await ports.activation(target.reference);
    if (!(activation?.state === 'active' && activation.catalogRevision === binding.catalogRevision && activation.binding.digest === binding.binding.digest)) {
      await ports.activate({ commandId: step(command.commandId, 'activate'), reference: target.reference, expectedRevision: activation?.revision ?? 0,
        catalogRevision: binding.catalogRevision, digest: binding.binding.digest });
      steps.activation = 'written';
    }
    // 5. One record of the connection (names only), then the key's presence and the running service's state for the person.
    await ports.audit({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId, principal: { issuer: principal.issuer, subject: principal.subject },
      policyRevision: await ports.policyRevision(), atMs: this.now(), subject: { kind: 'model-connect', commandId: command.commandId, connection: command.connection,
        reference: target.reference, credentialRef, steps: { ...steps } } });
    return result('connected', null, credentialRef ? await ports.keyStored(credentialRef) : null, await ports.service());
  }

  /** The command's model: a seed model by exact API id (declared from the seed), or a model the provider catalog already declares. */
  private async target(kind: ModelConnectKind, command: ModelConnectCommand, catalog: ProviderCatalog | null): Promise<Target> {
    const fallback = this.ports.defaults.maxOutputTokens;
    if ('nativeId' in command.model) {
      const seedName = kind.connect?.seed, nativeId = command.model.nativeId;
      if (!seedName) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
      const seed = await this.ports.seed(seedName);
      for (const provider of seed.providers) {
        const model = provider.models.find(item => item.nativeId === nativeId);
        if (!model) continue;
        const metadata = model as { maxOutputTokens?: number | null; contextWindow?: number | null };
        return { reference: { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version }, nativeId, seed,
          maxOutputTokens: metadata.maxOutputTokens ?? fallback, contextWindow: metadata.contextWindow ?? null,
          declare: { provider: { id: provider.id, version: provider.version }, model: { id: model.id, version: model.version, nativeId, protocols: model.protocols } } };
      }
      throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    }
    const reference = command.model.reference;
    const model = catalog?.providers.find(provider => provider.id === reference.providerId && provider.version === reference.providerVersion)
      ?.models.find(item => item.id === reference.modelId && item.version === reference.modelVersion);
    if (!model) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    return { reference, nativeId: model.nativeId, maxOutputTokens: fallback, contextWindow: null, declare: null, seed: null };
  }
  /** This scope's other models active under the catalog revision being replaced (re-activated afterwards when their binding is unchanged). */
  private async carryable(before: ProviderCatalog | null, skip: ModelReference) {
    const carry: { reference: ModelReference; revision: number; digest: string }[] = [];
    for (const provider of before?.providers ?? []) for (const model of provider.models) {
      const reference = { providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version };
      if (sameReference(reference, skip)) continue;
      const activation = await this.ports.activation(reference).catch(() => null);
      if (activation?.state === 'active' && activation.catalogRevision === before!.revision) carry.push({ reference, revision: activation.revision, digest: activation.binding.digest });
    }
    return carry;
  }
  /** The registry's response limit, narrowed to the largest one every result frame of this installation delivers (unchanged when none fits). */
  private deliverable(fits: (bytes: number) => boolean): number {
    let high = this.ports.defaults.responseMaxBytes;
    if (fits(high)) return high;
    let low = 1;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(middle)) low = middle; else high = middle - 1; }
    return fits(low) ? low : this.ports.defaults.responseMaxBytes;
  }
}
