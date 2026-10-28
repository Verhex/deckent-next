import { modelConnectLines } from '#surfaces/core/work-labels/index.js';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, loadConfig, MESSAGE_REGISTRY, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ModelConnectCommand, ModelConnectResult, ModelReference } from '#domain/index.js';
import { buildInferenceServingPlan, readInferenceServingProfile } from '#engine/index.js';
import type { PanelLine, ProviderConnectOutcome, ProviderConnectRequest, ProviderModelOutcome, ProviderModelRequest, ProviderPanelKind, ProviderPanelPort, ProviderSecretGrantPort } from '#surfaces/core/terminal-panels/index.js';
import { workerChannelText } from '#surfaces/core/work-labels/index.js';
import type { ProviderConnectKindView, ProviderConnectProbeView, TerminalLaunchContext } from './context.js';
import { modelInvocabilityText } from '#surfaces/core/model-invocability/index.js';
import { providerDisplayName } from './provider-label.js';

/** The words of a kind: its catalog key comes with the adapter's data (an unknown key from newer data keeps the kind's id). */
function kindLabel(kind: ProviderConnectKindView | undefined, id: string, locale: Locale): string {
  return kind ? (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[kind.labelKey] ?? id : id;
}
/** The check's typed outcome in words (the secret lane's rejection kinds, then unreachable / unexpected). */
export function providerOutcomeWord(probe: ProviderConnectProbeView, locale: Locale): string {
  switch (probe.outcome) {
    // A provider without a free read (T4-B: Z.ai): nothing was sent.
    case 'ok': return probe.httpStatus === null && probe.key === 'unverified' ? t('tui.provider.outcome.okNoCheck', {}, locale) : probe.key === 'verified' ? t('tui.provider.outcome.ok', {}, locale) : probe.key === 'none' ? t('tui.provider.outcome.okNoKey', {}, locale)
      : t('tui.provider.outcome.okUnverified', {}, locale);
    case 'credential-rejected': return t('tui.provider.outcome.credentialRejected', {}, locale);
    case 'access-denied': return t('tui.provider.outcome.accessDenied', {}, locale);
    case 'spend-limit': return t('tui.provider.outcome.spendLimit', {}, locale);
    case 'rate-limit': return t('tui.provider.outcome.rateLimit', {}, locale);
    case 'limit-reached': return t('tui.provider.outcome.limitReached', {}, locale);
    case 'unreachable': return t('tui.provider.outcome.unreachable', {}, locale);
    default: return t('tui.provider.outcome.unexpected', { status: probe.httpStatus ?? '-' }, locale);
  }
}
function endpointWord(reason: string, locale: Locale): string {
  switch (reason) {
    case 'url-credentials': return t('tui.provider.endpoint.credentials', {}, locale);
    case 'url-query': return t('tui.provider.endpoint.query', {}, locale);
    case 'url-insecure-remote': return t('tui.provider.endpoint.insecureRemote', {}, locale);
    case 'url-scheme-refused': return t('tui.provider.endpoint.scheme', {}, locale);
    default: return t('tui.provider.endpoint.invalid', {}, locale);
  }
}
const credentialRefs = (config: Record<string, unknown>, scopeId: string): readonly string[] => {
  const profiles = (config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined)?.profiles ?? [];
  return profiles.flatMap(profile => {
    const value = profile as { scopeId?: unknown; adapter?: { definition?: { authentication?: { credentialRef?: unknown } } } };
    const ref = value.adapter?.definition?.authentication?.credentialRef;
    return value.scopeId === scopeId && typeof ref === 'string' ? [ref] : [];
  });
};

/**
 * Who can read a stored key, in the same words `doctor` uses for each Core backend (SECRET-AT-REST 1c); another backend (or one not read yet)
 * gets the general note, which the secret lane may replace (`tui.panel.provider.transparency`).
 */
function custodyText(backend: string, locale: Locale): string {
  if (backend === 'core.secret-store.env@1') return t('doctor.secretStore.custody.env', {}, locale).trim();
  if (backend === 'core.secret-store.file@1') return t('doctor.secretStore.custody.file', {}, locale).trim();
  if (backend === 'core.secret-store.encrypted-file@1') return t('doctor.secretStore.custody.encryptedFile', {}, locale).trim();
  return t('tui.panel.provider.transparency', { backend }, locale);
}

type Host = Pick<TerminalLaunchContext, 'siwc' | 'providerConnect' | 'listSecretNames' | 'setSecret' | 'deleteSecret' | 'connectModel' | 'inspectDeclaredModels' | 'inspectProviderSpendAccount' | 'inspectInvocableModels' | 'prepareMainSecret' | 'connectProviderSecret' | 'inspectModelCatalog'>
  & { observeSetup?: (root: string, options: ConfigLoadOptions) => Promise<{ observation: { families?: Readonly<Record<string, unknown>> } }> };
async function workerReadiness(host: Host, root: string, scopeId: string, options: ConfigLoadOptions, channelId: string, locale: Locale) { // BeUser D-05b
  const channel = (await host.inspectModelCatalog?.(root, { schemaVersion: 1, scopeId }, options).catch(() => null))?.channels.find(row => row.channelId === channelId);
  return channel?.access === 'allowed' && channel.channel.kind === 'native-cli' && channel.channel.cli ? workerChannelText(channel.channel.cli, channel.activation?.state === 'active',
    (await host.observeSetup?.(root, options).catch(() => null))?.observation.families ?? null, locale) : null;
}
const PULL = 'pull:available';
const SEED = 'seed:', DECLARED = 'ref:', LEGACY = 'legacy:';
const referenceKey = (reference: ModelReference) => `${reference.providerId}@${reference.providerVersion}/${reference.modelId}@${reference.modelVersion}`;
/**
 * The terminal `/provider` window's port (T4 PROVIDER-CONNECT). It lists the kinds the host's adapter data names, the key name each is kept
 * under (names only: values are never read back) and how many of this scope's invocation profiles name that key. Connect runs the free check
 * and, only when it passes, sends the key to the installation's secret store through the runtime service (`setSecret`: policy cell `secret`,
 * audited, never the value). The key is never echoed, logged, audited, put in a returned row or in the environment; no worker sees it. Binding
 * models to the key stays the governed catalog/profile path (open owner decision): the result names the next step instead.
 */
/** Model connections of this terminal waiting for an approval: the same choice continues under its command id (display state, never authority). */
const pendingConnections = new Map<string, string>(), PENDING_CONNECTIONS_KEPT = 32;
type DeclaredConnectionModel = Readonly<{ id: string; label: string; detail: string; family: readonly string[] }>;
async function connectionModelRows(kind: ProviderConnectKindView, connect: NonNullable<Host['providerConnect']>, enabled: boolean,
  declared: readonly DeclaredConnectionModel[], locale: Locale): Promise<ProviderPanelKind['models']> {
  if (!enabled || !kind.connectFamily) return [];
  if (kind.pull === 'available') return [{ id: PULL, label: t('tui.provider.pull', {}, locale), detail: '' }];
  if (kind.seeded && connect.seedModels) return (await connect.seedModels(kind.id).catch(() => [])).map(model => ({ id: `${SEED}${model.nativeId}`,
    label: model.displayName, detail: model.nativeId, ...(model.priced === false ? { blocked: kind.id === 'zai-cn-api'
      ? t('tui.provider.model.currencyUnsupported', {}, locale) : t('tui.provider.model.priceUnverified', {}, locale) } : {}) }));
  return declared.filter(model => model.family.includes(kind.connectFamily!)).map(({ id, label, detail }) => ({ id, label, detail }));
}
function discoveryPort(root: string, scopeId: string, connect: NonNullable<Host['providerConnect']>, options: ConfigLoadOptions, locale: Locale):
  Pick<ProviderPanelPort, 'listModels'> {
  if (!connect.discoverModels) return {};
  return { async listModels(kind, endpoint) {
    return (await connect.discoverModels!(root, scopeId, kind, endpoint, options)).map(model => ({ id: `${SEED}${model.nativeId}`,
      label: model.displayName, detail: model.nativeId, ...(model.priced ? {} : { blocked: t('tui.provider.model.priceRequired', {}, locale) }) }));
  } };
}
export function providerPanelPort(root: string, scopeId: string, host: Host & { providerConnect: NonNullable<Host['providerConnect']> }, options: ConfigLoadOptions, locale: Locale,
  errorText: (error: unknown) => string, secretGrant?: ProviderSecretGrantPort): ProviderPanelPort {
  const connect = host.providerConnect; let backend = '-';
  const kindOf = (id: string): ProviderConnectKindView | undefined => connect.kinds.find(kind => kind.id === id);
  const refs = async () => credentialRefs(await loadConfig(root, options) as Record<string, unknown>, scopeId);
  const pullModels = async (kind: ProviderConnectKindView, endpoint: string | null, lines: PanelLine[], workspaceRequired: boolean): Promise<readonly Readonly<{ id: string; name: string }>[] | undefined> => {
    if (!host.connectModel || kind.pull !== 'available' || !kind.connectFamily) return;
    try {
      const workspaces = workspaceRequired && connect.workspaces ? await connect.workspaces(root, scopeId, kind.id, endpoint, options) : [];
      if (workspaces.length > 1) return workspaces;
      if (workspaceRequired && !workspaces.length) { lines.push({ label: '', text: t('tui.workspace.required', {}, locale), tone: 'warning' }); return; }
      const result = await host.connectModel(root, { schemaVersion: 1, commandId: `provider-${randomUUID()}`, scopeId, connection: kind.id, endpoint,
        model: { pull: 'available' }, ...(workspaces[0] ? { workspaceId: workspaces[0].id } : {}) }, options);
      lines.push(...modelConnectLines(result, kindLabel(kind, kind.id, locale), locale).filter(row => row.text !== t('tui.provider.model.next', {}, locale)));
      const reading = await host.inspectInvocableModels?.(root, scopeId, options);
      const usable = reading?.models.find(row => row.availability.invocable && result.models?.some(model => model.reference && referenceKey(model.reference) === referenceKey(row.reference)));
      const worker = usable ? null : await workerReadiness(host, root, scopeId, options, result.reference.providerId, locale);
      if (worker) { lines.push({ label: '', text: worker }); return; }
      lines.push({ label: '', text: usable ? t('tui.provider.model.next', {}, locale) : t('tui.provider.pull.blocked', { reason: result.status === 'approval-pending' ? result.approval?.approvalId ?? '-' : result.budget?.state === 'missing' ? t('tui.budget.missing', { scope: scopeId }, locale) : t('tui.provider.unavailable', {}, locale) }, locale), tone: usable ? 'success' : 'warning' });
    } catch (error) { lines.push({ label: '', text: errorText(error), tone: 'warning' }); }
  };
  return {
    ...(host.siwc ? { siwc: { connection: host.siwc.connection, locale, execute: (request, presentation) => host.siwc!.execute(root, { ...request, scopeId }, options, presentation) } } : {}),
    ...(secretGrant ? { secretGrant } : {}),
    ...(host.prepareMainSecret ? { async prepareKey(kind: string, endpoint: string | null) {
      const custody = await host.prepareMainSecret!(root, scopeId, options);
      if (custody.state !== 'ready') throw ErrorRegistry.createError(custody.code ?? 'SECRET_STORE_UNAVAILABLE', {
        params: { backend: custody.backend ?? '-', path: custody.path ?? '' } });
      backend = custody.backend ?? '-';
      const grant = Boolean(host.connectProviderSecret && await secretGrant?.offer());
      const name = connect.secretName?.(kind, endpoint) ?? kindOf(kind)?.secretName ?? '-';
      return { grant, lines: [{ label: t('tui.provider.field.key', {}, locale), text: grant ? t('tui.provider.key.projectUse', { project: root }, locale) : t('tui.provider.key.adminGrant', { project: root, scope: scopeId, name }, locale) },
        { label: t('tui.provider.field.storage', {}, locale), text: custodyText(backend, locale), tone: 'muted' as const }] };
    } } : {}),
    async inspect() {
      const notes: string[] = [];
      let names: readonly string[] | null = null;
      if (host.listSecretNames) {
        try { const listed = await host.listSecretNames(root, options); names = listed.names; backend = listed.backend; }
        catch (error) { notes.push((error as { code?: unknown } | null)?.code === 'SECRET_STORE_UNSUPPORTED' ? t('tui.provider.note.storeEnv', {}, locale) : t('tui.provider.note.storeUnlisted', { reason: errorText(error) }, locale)); } // env store: plain, non-blocking (BeUser 3t)
      }
      let named: readonly string[] = [], served: string | null = null;
      try {
        const config = await loadConfig(root, options) as Record<string, unknown>;
        named = credentialRefs(config, scopeId);
        // The installation's own inference server (inference_serving), when configured: the first address offered (owner 2026-10-08, D3).
        try { const profile = readInferenceServingProfile(config); served = profile ? buildInferenceServingPlan(profile).openaiBaseUrl : null; } catch { served = null; }
      } catch (error) { notes.push(t('tui.provider.note.profilesUnread', { reason: errorText(error) }, locale)); }
      const catalog = MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>;
      /** The kind's address list: the configured server, the kind's known addresses (adapter data), the provider's default; one row per base. */
      const choicesOf = (kind: ProviderConnectKindView) => {
        if (!kind.endpointEditable) return [];
        const rows = [...(served ? [{ id: 'configured', label: t('tui.provider.endpoint.choice.configured', {}, locale), url: served }] : []),
          ...kind.endpointChoices.map(choice => ({ id: choice.id, label: catalog[choice.labelKey] ?? choice.id, url: choice.url })),
          ...(kind.endpointDefault ? [{ id: 'default', label: t('tui.provider.endpoint.choice.default', {}, locale), url: kind.endpointDefault }] : [])];
        const seen = new Set<string>();
        return rows.flatMap(row => {
          const checked = connect.endpoint(row.url);
          if (!checked.ok || seen.has(checked.base)) return [];
          seen.add(checked.base);
          return [{ ...row, url: checked.base }];
        });
      };
      // T4-B: what each kind can connect — its seed's models (exact ids), or the declared catalog models speaking its protocol family.
      let declared: readonly DeclaredConnectionModel[] = [];
      if (host.inspectDeclaredModels && host.connectModel) {
        try {
          const inspection = await host.inspectDeclaredModels(root, options);
          if (inspection.status === 'declared') declared = inspection.catalog.providers.flatMap(provider => provider.models.map(model => {
            const key = referenceKey({ providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version });
            return { id: `${DECLARED}${key}`, label: model.id, detail: key, family: model.protocols.map(protocol => protocol.family) };
          }));
        } catch { declared = []; }
      }
      const models = new Map(await Promise.all(connect.kinds.map(async kind => [kind.id,
        await connectionModelRows(kind, connect, Boolean(host.connectModel), declared, locale)] as const)));
      const reading = await host.inspectInvocableModels?.(root, scopeId, options);
      const kinds: ProviderPanelKind[] = await Promise.all(connect.kinds.map(async kind => {
        const keyName = kind.secretName, stored = keyName !== null && names !== null && names.includes(keyName), using = keyName ? named.filter(ref => ref === keyName).length : 0;
        // A keyless server's models are this kind's own (its seed provider, or the kind id plus the address digest): "connected", never "not connected".
        const linked = kind.keyRequired ? 0 : (reading?.models ?? []).filter(model => model.reference.providerId === kind.catalogProviderId || new RegExp(`^${kind.id}-[0-9a-f]{32}$`, 'u').test(model.reference.providerId)).length;
        const detail = !kind.available ? '' : keyName === null ? '-' : names === null ? t('tui.provider.state.unknown', { name: keyName }, locale)
          : stored ? t('tui.provider.state.stored', { name: keyName, count: using }, locale) : linked ? t('tui.provider.state.models', { count: linked }, locale) : t('tui.provider.state.notConnected', {}, locale);
        let grantBlocked: string | null = null, grantRequired = false;
        if (stored && host.connectProviderSecret && secretGrant?.check) { try { await secretGrant.check(keyName!); } catch (error) {
          grantBlocked = errorText(error); grantRequired = (error as { code?: unknown } | null)?.code === 'SECRET_GRANT_REQUIRED';
        } }
        // A key-only registry kind explains its unavailable model binding. OpenRouter v5 now lists its seeded models.
        const pending = kind.available && kind.connectFamily === null && keyName !== null ? t('tui.provider.state.modelsNextSlice', {}, locale) : null;
        return { id: kind.id, label: kindLabel(kind, kind.id, locale), detail, blocked: kind.available ? null : t('tui.provider.unavailable', {}, locale), keyName, keyStored: stored, grantRequired,
          endpointEditable: kind.endpointEditable, endpointDefault: kind.endpointDefault, keyRequired: kind.keyRequired, endpointChoices: choicesOf(kind),
          models: models.get(kind.id) ?? [], discoversModels: Boolean(kind.connectFamily && !kind.seeded && connect.discoverModels), ...(pending ? { pendingNote: pending } : {}),
          // A vendor key must be stored before a model is bound to it (the generic row's name depends on the address chosen next: checked on connect).
          modelBlocked: kind.keyRequired && keyName !== null ? grantBlocked ?? (!stored ? t('tui.provider.model.needsKey', {}, locale) : null) : null };
      }));
      // (c) A key kept under a name no row uses any more (T4-A's shared OpenAI-compatible slot): warned, removable, never used.
      for (const legacy of connect.legacyKeys ?? []) {
        if (names === null || !names.includes(legacy.secretName)) continue;
        const target = kindLabel(kindOf(legacy.moveTo), legacy.moveTo, locale);
        notes.push(t('tui.provider.legacy.note', { name: legacy.secretName, kind: target }, locale));
        kinds.push({ id: `${LEGACY}${legacy.secretName}`, label: t('tui.provider.legacy.label', { name: legacy.secretName }, locale), detail: t('tui.provider.legacy.detail', { kind: target }, locale),
          blocked: null, keyName: legacy.secretName, keyStored: true, endpointEditable: false, endpointDefault: null, keyRequired: true, endpointChoices: [], models: [], modelBlocked: null,
          legacy: true });
      }
      if (!host.setSecret) notes.push(t('tui.provider.note.noStore', {}, locale));
      if (reading?.models.some(model => model.availability.reason?.code === 'PROVIDER_SPEND_UNAVAILABLE')) notes.push(t('tui.budget.missing', { scope: scopeId }, locale));
      for (const model of reading?.models ?? []) notes.push(`${providerDisplayName(model.reference.providerId, connect, locale)} / ${model.nativeId}: ${modelInvocabilityText(model.availability, locale)}`);
      return { title: t('tui.panel.provider.title', {}, locale), kinds, notes, ...(reading ? { invocableModels: reading.models } : {}) };
    },
    endpoint(kind, text) {
      const checked = connect.endpoint(text);
      return checked.ok ? { ok: true, base: checked.base, check: `${checked.base}${kindOf(kind)?.probePath ?? ''}` } : { ok: false, reason: endpointWord(checked.reason, locale) };
    },
    ...discoveryPort(root, scopeId, connect, options, locale),
    async connect(request: ProviderConnectRequest): Promise<ProviderConnectOutcome> {
      const kind = kindOf(request.kind), label = kindLabel(kind, request.kind, locale);
      const refused = (lines: readonly PanelLine[]): ProviderConnectOutcome => ({ stored: false, title: t('tui.provider.result.refused', { kind: label }, locale), lines });
      if (!kind?.available) return refused([{ label: t('tui.provider.field.check', {}, locale), text: t('tui.provider.unavailable', {}, locale) }]);
      let probe: ProviderConnectProbeView;
      try { probe = await connect.probe({ kind: request.kind, endpoint: request.endpoint, key: request.key }); }
      catch (error) {
        const code = String((error as { code?: unknown })?.code), reason = String((error as { reason?: unknown })?.reason ?? ''), lines: PanelLine[] = [];
        if (code === 'PROVIDER_KIND_UNAVAILABLE' && !kind.secretName && kind.pull === 'available' && kind.connectFamily && host.connectModel) { await pullModels(kind, request.endpoint, lines, false); // BeUser M-01: a key-less CLI subscription's Connect is its model connection (its own check names the cause)
          return lines.some(row => row.tone === 'success') ? { stored: false, title: t('tui.provider.result.ok', { kind: label }, locale), lines } : refused(lines); }
        return refused([{ label: t('tui.provider.field.check', {}, locale), text: code === 'PROVIDER_ENDPOINT_INVALID' ? endpointWord(reason, locale) : code === 'PROVIDER_KEY_REQUIRED' ? t('tui.panel.provider.keyRequired', {}, locale)
          : code === 'PROVIDER_KEY_INSECURE' ? t('models.connect.keyInsecure', {}, locale) : ErrorRegistry.has(code) ? errorText(ErrorRegistry.createError(code)) : t('tui.provider.unavailable', {}, locale), tone: 'warning' }]); // BeUser M-01: the typed cause and its next step, never "Not available yet"
      }
      const check: PanelLine = { label: t('tui.provider.field.check', {}, locale), text: providerOutcomeWord(probe, locale), tone: probe.outcome === 'ok' ? 'success' : 'warning' };
      const where: PanelLine[] = request.endpoint ? [{ label: t('tui.provider.field.endpoint', {}, locale), text: request.endpoint }] : [];
      if (probe.outcome !== 'ok') return refused([check, ...where, { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.notStored', {}, locale) }]);
      const name = connect.secretName?.(request.kind, request.endpoint) ?? kind.secretName;
      let keyLine: PanelLine;
      let stored = false;
      if (request.key === null || name === null) keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.none', {}, locale) };
      else if (!host.setSecret && !host.connectProviderSecret) keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.note.noStore', {}, locale), tone: 'warning' };
      else {
        try {
          if (host.connectProviderSecret) {
            const result = await host.connectProviderSecret(root, { scopeId, name, value: request.key, grant: request.grant === true }, options);
            stored = result.key.state === 'stored'; backend = result.backend ?? backend;
            const failed = result.custody.state === 'refused' ? result.custody : result.key.state === 'refused' ? result.key : result.grant;
            const lines: PanelLine[] = [check, ...where, { label: t('tui.provider.field.key', {}, locale),
              text: stored ? t('tui.provider.key.stored', { name, backend }, locale) : t('tui.provider.key.notStored', {}, locale), tone: stored ? 'success' : 'warning' }];
            if (failed.code) lines.push({ label: t('tui.provider.field.next', {}, locale), text: failed.state === 'admin'
              ? t('tui.provider.key.adminGrant', { project: root, scope: scopeId, name }, locale)
              : errorText(ErrorRegistry.createError(failed.code, { params: { path: failed.path ?? '', name, project: root, scopeId, backend } })), tone: 'warning' });
            const title = !stored ? t('tui.provider.result.refused', { kind: label }, locale) : result.grant.state === 'granted'
              ? t('tui.provider.result.ok', { kind: label }, locale) : t('tui.provider.result.grantMissing', { kind: label }, locale);
            const workspaces = stored && result.grant.state === 'granted' ? await pullModels(kind, request.endpoint, lines, probe.workspaceRequired === true) : undefined;
            return { stored, title, lines, ...(workspaces ? { workspaces } : {}), ...(stored ? { keyName: name } : {}) };
          }
          const change = await host.setSecret!(root, { schemaVersion: 1, scopeId, name, value: request.key }, options);
          stored = true; backend = change.backend;
          keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.stored', { name, backend: change.backend }, locale), tone: 'success' };
        } catch (error) {
          // A store that cannot write (the environment backend), a policy refusal: the typed reason; nothing else was kept.
          keyLine = { label: t('tui.provider.field.key', {}, locale), text: `${t('tui.provider.key.notStored', {}, locale)} ${errorText(error)}`, tone: 'warning' };
        }
      }
      const ok = stored || request.key === null, pulled = ok && Boolean(host.connectModel) && kind.pull === 'available' && Boolean(kind.connectFamily);
      const lines: PanelLine[] = [check, ...where, keyLine];
      const workspaces = ok ? await pullModels(kind, request.endpoint, lines, probe.workspaceRequired === true) : undefined;
      // After the pull: a pull reports its own models and next step, so "no model uses the key yet" never contradicts it (FIX8c).
      const using = name ? (await refs().catch(() => [] as readonly string[])).filter(ref => ref === name).length : 0;
      const next = kind.connectFamily === null ? t('tui.provider.state.modelsNextSlice', {}, locale) : probe.workspaceRequired ? t('tui.workspace.required', {}, locale)
        : pulled ? null : using > 0 ? t('tui.provider.next.bound', { count: using }, locale) : t('tui.provider.next.unbound', { name: name ?? '-', scope: scopeId }, locale);
      if (next) lines.splice(2 + where.length, 0, { label: t('tui.provider.field.next', {}, locale), text: next, tone: 'muted' });
      return { ...(workspaces ? { workspaces } : {}), stored, title: ok ? t('tui.provider.result.ok', { kind: label }, locale) : t('tui.provider.result.refused', { kind: label }, locale), lines,
        ...(stored ? { keyName: name } : {}) };
    },
    async disconnect(id) {
      const legacy = id.startsWith(LEGACY) ? (connect.legacyKeys ?? []).find(item => `${LEGACY}${item.secretName}` === id) : undefined;
      const kind = kindOf(id), name = legacy?.secretName ?? kind?.secretName;
      if ((!kind && !legacy) || !name || !host.deleteSecret) return [t('tui.provider.note.noStore', {}, locale)];
      const change = await host.deleteSecret(root, { schemaVersion: 1, scopeId, name }, options);
      const using = (await refs().catch(() => [] as readonly string[])).filter(ref => ref === name).length;
      return [change.removed ? t('tui.provider.disconnected', { name }, locale) : t('tui.provider.notStored', { name }, locale),
        ...(using > 0 ? [t('tui.provider.disconnectedBound', { count: using, name }, locale)] : [])];
    },
    keyName(kind, endpoint) { return connect.secretName?.(kind, endpoint) ?? kindOf(kind)?.secretName ?? null; },
    ...(host.connectModel ? { async connectModel(request: ProviderModelRequest): Promise<ProviderModelOutcome> {
      const kind = kindOf(request.kind), label = kindLabel(kind, request.kind, locale);
      const choice = request.model === PULL ? { pull: 'available' as const } : request.model.startsWith(SEED) ? { nativeId: request.model.slice(SEED.length) } : (() => {
        const match = /^([^@/]+)@(\d+)\/([^@/]+)@(\d+)$/u.exec(request.model.slice(DECLARED.length));
        return match ? { reference: { providerId: match[1]!, providerVersion: Number(match[2]), modelId: match[3]!, modelVersion: Number(match[4]) } } : null;
      })();
      const shown = request.model === PULL ? t('tui.provider.pull', {}, locale) : 'nativeId' in (choice ?? {}) ? (choice as { nativeId: string }).nativeId : request.model.slice(DECLARED.length);
      const refused = (text: string): ProviderModelOutcome => ({ connected: false, title: t('tui.provider.model.refused', { model: shown }, locale),
        lines: [{ label: t('tui.provider.model.field.model', {}, locale), text: `${label} · ${shown}` }, { label: t('tui.provider.field.check', {}, locale), text, tone: 'warning' }],
        summary: t('tui.provider.model.refused', { model: shown }, locale), approvalId: null });
      if (!choice) return refused(t('tui.provider.unavailable', {}, locale));
      // A connection waiting for approval continues under the same command id (its config approval names it); anything else is a new command.
      const pendingKey = JSON.stringify([request.kind, request.endpoint, request.model]);
      const command: ModelConnectCommand = { schemaVersion: 1, commandId: pendingConnections.get(pendingKey) ?? randomUUID(), scopeId, connection: request.kind,
        endpoint: request.endpoint, ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}), model: choice as ModelConnectCommand['model'] };
      let result: ModelConnectResult;
      try { result = await host.connectModel!(root, command, options); } catch (error) {
        pendingConnections.delete(pendingKey);
        // PRE-8 v2: a main-vault key without a grant goes back to the window, which offers the first-use card.
        if ((error as { code?: unknown } | null)?.code === 'SECRET_GRANT_REQUIRED') throw error;
        return refused(request.model === PULL && ['MODEL_CONNECT_MODEL_UNKNOWN', 'MODEL_CONNECT_NO_AVAILABLE'].includes(String((error as { code?: unknown } | null)?.code)) ? `${t('tui.provider.pull.none', { kind: label }, locale)} ${errorText(error)}` : errorText(error)); // BeUser M-01: nothing to connect, then the typed cause; never an internal id
      }
      if (result.status === 'approval-pending') pendingConnections.set(pendingKey, command.commandId); else pendingConnections.delete(pendingKey);
      while (pendingConnections.size > PENDING_CONNECTIONS_KEPT) pendingConnections.delete(pendingConnections.keys().next().value!);
      const lines = modelConnectLines(result, `${label} · ${shown}`, locale);
      const reading = result.status === 'connected' ? await host.inspectInvocableModels?.(root, scopeId, options) : null;
      const candidates = reading?.models.filter(row => referenceKey(row.reference) === referenceKey(result.reference) || result.models?.some(model => model.reference && referenceKey(model.reference) === referenceKey(row.reference))) ?? [];
      const usable = candidates.some(row => row.availability.invocable);
      const unavailable = t('tui.provider.pull.blocked', { reason: candidates[0] ? modelInvocabilityText(candidates[0].availability, locale) : t('tui.provider.unavailable', {}, locale) }, locale);
      if (result.status === 'connected') lines.push({ label: '', text: usable ? t('tui.provider.model.next', {}, locale) : unavailable, tone: usable ? 'success' : 'warning' });
      return result.status === 'connected'
        ? { connected: true, title: t('tui.provider.model.connected', { model: shown }, locale), lines, approvalId: null,
          summary: !usable ? unavailable : result.notCarried.length ? t('tui.provider.model.summaryNotCarried', { model: shown, count: result.notCarried.length }, locale)
            : t('tui.provider.model.summary', { model: shown }, locale) }
        : { connected: false, title: t('tui.provider.model.pending', { model: shown }, locale), lines, summary: t('tui.provider.model.summaryPending', { model: shown }, locale),
          approvalId: result.approval?.approvalId ?? null };
    } } : {}),
    get transparency(): readonly PanelLine[] {
      return [{ label: t('tui.provider.field.storage', {}, locale), text: custodyText(backend, locale), tone: 'muted' }];
    },
  };
}
