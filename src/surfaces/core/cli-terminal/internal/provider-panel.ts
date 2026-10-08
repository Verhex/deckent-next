import { randomUUID } from 'node:crypto';
import { loadConfig, MESSAGE_REGISTRY, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { ModelConnectCommand, ModelConnectResult, ModelReference } from '#domain/index.js';
import { buildInferenceServingPlan, readInferenceServingProfile } from '#engine/index.js';
import type { PanelLine, ProviderConnectOutcome, ProviderConnectRequest, ProviderModelOutcome, ProviderModelRequest, ProviderPanelKind, ProviderPanelPort } from '#surfaces/core/terminal-panels/index.js';
import type { ProviderConnectKindView, ProviderConnectProbeView, TerminalLaunchContext } from './context.js';
import { scopeBudgeted } from './model-panel.js';

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

type Host = Pick<TerminalLaunchContext, 'providerConnect' | 'listSecretNames' | 'setSecret' | 'deleteSecret' | 'connectModel' | 'inspectDeclaredModels'>;
const SEED = 'seed:', DECLARED = 'ref:', LEGACY = 'legacy:';
const referenceKey = (reference: ModelReference) => `${reference.providerId}@${reference.providerVersion}/${reference.modelId}@${reference.modelVersion}`;
/** The connection's result as the window's rows: the model, what each governed step did, the key's name, spending and the service. */
function modelLines(result: ModelConnectResult, label: string, locale: Locale): PanelLine[] {
  const step = (state: string) => state === 'written' ? t('models.connect.step.written', {}, locale) : state === 'present' ? t('models.connect.step.present', {}, locale)
    : t('models.connect.step.skipped', {}, locale);
  return [{ label: t('tui.provider.model.field.model', {}, locale), text: label },
    { label: t('tui.provider.model.field.steps', {}, locale), text: t('models.connect.steps', { catalog: step(result.steps.catalog), declaration: step(result.steps.declaration),
      profile: step(result.steps.profile), activation: step(result.steps.activation), carried: result.steps.carried }, locale), tone: 'muted' },
    { label: t('tui.provider.field.key', {}, locale), text: result.credentialRef === null ? t('models.connect.keyNone', {}, locale) : result.keyStored === false
      ? t('models.connect.keyMissing', { name: result.credentialRef }, locale) : t('models.connect.key', { name: result.credentialRef }, locale),
    tone: result.keyStored === false ? 'warning' : 'muted' },
    // K5: which other models were carried to the new catalog revision, and which were not (with the typed reason); the system line stays a summary.
    ...(result.carriedModels.length ? [{ label: t('tui.provider.model.field.carried', {}, locale), tone: 'muted' as const,
      text: result.carriedModels.map(reference => reference.modelId).join(', ') }] : []),
    ...(result.notCarried.length ? [{ label: t('tui.provider.model.field.notCarried', {}, locale), tone: 'warning' as const, text: t('models.connect.notCarried', {
      models: result.notCarried.map(item => `${item.reference.modelId} (${item.code})`).join(', ') }, locale) }] : []),
    ...(result.tariff === 'unmetered' ? [{ label: t('tui.provider.model.field.spend', {}, locale), text: t('models.connect.unmetered', {}, locale), tone: 'warning' as const }] : []),
    ...(result.service === 'stale' ? [{ label: t('tui.provider.model.field.service', {}, locale), text: t('models.connect.restart', {}, locale), tone: 'warning' as const }] : []),
    ...(result.status === 'connected' ? [{ label: t('tui.provider.field.next', {}, locale), text: t('tui.provider.model.next', {}, locale), tone: 'success' as const }] : [])];
}
/**
 * The terminal `/provider` window's port (T4 PROVIDER-CONNECT). It lists the kinds the host's adapter data names, the key name each is kept
 * under (names only: values are never read back) and how many of this scope's invocation profiles name that key. Connect runs the free check
 * and, only when it passes, sends the key to the installation's secret store through the runtime service (`setSecret`: policy cell `secret`,
 * audited, never the value). The key is never echoed, logged, audited, put in a returned row or in the environment; no worker sees it. Binding
 * models to the key stays the governed catalog/profile path (open owner decision): the result names the next step instead.
 */
/** Model connections of this terminal waiting for an approval: the same choice continues under its command id (display state, never authority). */
const pendingConnections = new Map<string, string>(), PENDING_CONNECTIONS_KEPT = 32;
export function providerPanelPort(root: string, scopeId: string, host: Host & { providerConnect: NonNullable<Host['providerConnect']> }, options: ConfigLoadOptions, locale: Locale,
  errorText: (error: unknown) => string): ProviderPanelPort {
  const connect = host.providerConnect;
  let backend = '-';
  const kindOf = (id: string): ProviderConnectKindView | undefined => connect.kinds.find(kind => kind.id === id);
  const refs = async () => credentialRefs(await loadConfig(root, options) as Record<string, unknown>, scopeId);
  return {
    async inspect() {
      const notes: string[] = [];
      let names: readonly string[] | null = null;
      if (host.listSecretNames) {
        try { const listed = await host.listSecretNames(root, options); names = listed.names; backend = listed.backend; }
        catch (error) { notes.push(t('tui.provider.note.storeUnlisted', { reason: errorText(error) }, locale)); }
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
      let declared: readonly Readonly<{ id: string; label: string; detail: string; family: readonly string[] }>[] = [];
      if (host.inspectDeclaredModels && host.connectModel) {
        try {
          const inspection = await host.inspectDeclaredModels(root, options);
          if (inspection.status === 'declared') declared = inspection.catalog.providers.flatMap(provider => provider.models.map(model => {
            const key = referenceKey({ providerId: provider.id, providerVersion: provider.version, modelId: model.id, modelVersion: model.version });
            return { id: `${DECLARED}${key}`, label: model.id, detail: key, family: model.protocols.map(protocol => protocol.family) };
          }));
        } catch { declared = []; }
      }
      const modelsOf = async (kind: ProviderConnectKindView) => {
        if (!host.connectModel || !kind.connectFamily) return [];
        // Stage 1: a seed model without a verified price is listed but locked (connecting it is refused before anything is written).
        if (kind.seeded && connect.seedModels) return (await connect.seedModels(kind.id).catch(() => [])).map(model => ({ id: `${SEED}${model.nativeId}`, label: model.displayName, detail: model.nativeId,
          ...(model.priced === false ? { blocked: t('tui.provider.model.priceUnverified', {}, locale) } : {}) }));
        return declared.filter(model => model.family.includes(kind.connectFamily!)).map(({ id, label, detail }) => ({ id, label, detail }));
      };
      const models = new Map(await Promise.all(connect.kinds.map(async kind => [kind.id, await modelsOf(kind)] as const)));
      const kinds: ProviderPanelKind[] = connect.kinds.map(kind => {
        const keyName = kind.secretName, stored = keyName !== null && names !== null && names.includes(keyName), using = keyName ? named.filter(ref => ref === keyName).length : 0;
        const detail = !kind.available ? '' : keyName === null ? '-' : names === null ? t('tui.provider.state.unknown', { name: keyName }, locale)
          : stored ? t('tui.provider.state.stored', { name: keyName, count: using }, locale) : t('tui.provider.state.notConnected', {}, locale);
        // K6 (Jev 7e0348c4): a kind that stores a key but connects no model yet (OpenRouter) says so on its row; no model action is offered.
        const pending = kind.available && kind.connectFamily === null && keyName !== null ? t('tui.provider.state.modelsNextSlice', {}, locale) : null;
        return { id: kind.id, label: kindLabel(kind, kind.id, locale), detail, blocked: kind.available ? null : t('tui.provider.unavailable', {}, locale), keyName, keyStored: stored,
          endpointEditable: kind.endpointEditable, endpointDefault: kind.endpointDefault, keyRequired: kind.keyRequired, endpointChoices: choicesOf(kind),
          models: models.get(kind.id) ?? [], ...(pending ? { pendingNote: pending } : {}),
          // A vendor key must be stored before a model is bound to it (the generic row's name depends on the address chosen next: checked on connect).
          modelBlocked: kind.priceRequired ? t('tui.provider.model.priceRequired', {}, locale)
            : kind.keyRequired && keyName !== null && names !== null && !stored ? t('tui.provider.model.needsKey', {}, locale) : null };
      });
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
      // (a): a connected model cannot answer without this scope's budget; the window says so before anything is connected.
      try { if (!scopeBudgeted(await loadConfig(root, options) as Record<string, unknown>, scopeId)) notes.push(t('tui.budget.missing', { scope: scopeId }, locale)); }
      catch { /* the profiles note above already names an unreadable configuration */ }
      return { title: t('tui.panel.provider.title', {}, locale), kinds, notes };
    },
    endpoint(kind, text) {
      const checked = connect.endpoint(text);
      return checked.ok ? { ok: true, base: checked.base, check: `${checked.base}${kindOf(kind)?.probePath ?? ''}` } : { ok: false, reason: endpointWord(checked.reason, locale) };
    },
    async connect(request: ProviderConnectRequest): Promise<ProviderConnectOutcome> {
      const kind = kindOf(request.kind), label = kindLabel(kind, request.kind, locale);
      const refused = (lines: readonly PanelLine[]): ProviderConnectOutcome => ({ stored: false, title: t('tui.provider.result.refused', { kind: label }, locale), lines });
      if (!kind?.available) return refused([{ label: t('tui.provider.field.check', {}, locale), text: t('tui.provider.unavailable', {}, locale) }]);
      let probe: ProviderConnectProbeView;
      try { probe = await connect.probe({ kind: request.kind, endpoint: request.endpoint, key: request.key }); }
      catch (error) {
        const code = String((error as { code?: unknown })?.code), reason = String((error as { reason?: unknown })?.reason ?? '');
        return refused([{ label: t('tui.provider.field.check', {}, locale), text: code === 'PROVIDER_ENDPOINT_INVALID' ? endpointWord(reason, locale)
          : code === 'PROVIDER_KEY_REQUIRED' ? t('tui.panel.provider.keyRequired', {}, locale) : t('tui.provider.unavailable', {}, locale), tone: 'warning' }]);
      }
      const check: PanelLine = { label: t('tui.provider.field.check', {}, locale), text: providerOutcomeWord(probe, locale), tone: probe.outcome === 'ok' ? 'success' : 'warning' };
      const where: PanelLine[] = request.endpoint ? [{ label: t('tui.provider.field.endpoint', {}, locale), text: request.endpoint }] : [];
      if (probe.outcome !== 'ok') return refused([check, ...where, { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.notStored', {}, locale) }]);
      const name = connect.secretName?.(request.kind, request.endpoint) ?? kind.secretName;
      let keyLine: PanelLine;
      let stored = false;
      if (request.key === null || name === null) keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.none', {}, locale) };
      else if (!host.setSecret) keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.note.noStore', {}, locale), tone: 'warning' };
      else {
        try {
          const change = await host.setSecret(root, { schemaVersion: 1, scopeId, name, value: request.key }, options);
          stored = true; backend = change.backend;
          keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.stored', { name, backend: change.backend }, locale), tone: 'success' };
        } catch (error) {
          // A store that cannot write (the environment backend), a policy refusal: the typed reason; nothing else was kept.
          keyLine = { label: t('tui.provider.field.key', {}, locale), text: `${t('tui.provider.key.notStored', {}, locale)} ${errorText(error)}`, tone: 'warning' };
        }
      }
      const using = name ? (await refs().catch(() => [] as readonly string[])).filter(ref => ref === name).length : 0;
      const next: PanelLine = kind.connectFamily === null ? { label: t('tui.provider.field.next', {}, locale), text: t('tui.provider.state.modelsNextSlice', {}, locale), tone: 'muted' }
        : { label: t('tui.provider.field.next', {}, locale), text: using > 0 ? t('tui.provider.next.bound', { count: using }, locale)
        : t('tui.provider.next.unbound', { name: name ?? '-', scope: scopeId }, locale), tone: 'muted' };
      const ok = stored || request.key === null;
      return { stored, title: ok ? t('tui.provider.result.ok', { kind: label }, locale) : t('tui.provider.result.refused', { kind: label }, locale), lines: [check, ...where, keyLine, next] };
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
      const choice = request.model.startsWith(SEED) ? { nativeId: request.model.slice(SEED.length) } : (() => {
        const match = /^([^@/]+)@(\d+)\/([^@/]+)@(\d+)$/u.exec(request.model.slice(DECLARED.length));
        return match ? { reference: { providerId: match[1]!, providerVersion: Number(match[2]), modelId: match[3]!, modelVersion: Number(match[4]) } } : null;
      })();
      const shown = 'nativeId' in (choice ?? {}) ? (choice as { nativeId: string }).nativeId : request.model.slice(DECLARED.length);
      const refused = (text: string): ProviderModelOutcome => ({ connected: false, title: t('tui.provider.model.refused', { model: shown }, locale),
        lines: [{ label: t('tui.provider.model.field.model', {}, locale), text: `${label} · ${shown}` }, { label: t('tui.provider.field.check', {}, locale), text, tone: 'warning' }],
        summary: t('tui.provider.model.refused', { model: shown }, locale), approvalId: null });
      if (!choice) return refused(t('tui.provider.unavailable', {}, locale));
      // A connection waiting for approval continues under the same command id (its config approval names it); anything else is a new command.
      const pendingKey = JSON.stringify([request.kind, request.endpoint, request.model]);
      const command: ModelConnectCommand = { schemaVersion: 1, commandId: pendingConnections.get(pendingKey) ?? randomUUID(), scopeId, connection: request.kind,
        endpoint: request.endpoint, model: choice as ModelConnectCommand['model'] };
      let result: ModelConnectResult;
      try { result = await host.connectModel!(root, command, options); } catch (error) { pendingConnections.delete(pendingKey); return refused(errorText(error)); }
      if (result.status === 'approval-pending') pendingConnections.set(pendingKey, command.commandId); else pendingConnections.delete(pendingKey);
      while (pendingConnections.size > PENDING_CONNECTIONS_KEPT) pendingConnections.delete(pendingConnections.keys().next().value!);
      const lines = modelLines(result, `${label} · ${shown}`, locale);
      return result.status === 'connected'
        ? { connected: true, title: t('tui.provider.model.connected', { model: shown }, locale), lines, approvalId: null,
          summary: result.notCarried.length ? t('tui.provider.model.summaryNotCarried', { model: shown, count: result.notCarried.length }, locale)
            : t('tui.provider.model.summary', { model: shown }, locale) }
        : { connected: false, title: t('tui.provider.model.pending', { model: shown }, locale), lines, summary: t('tui.provider.model.summaryPending', { model: shown }, locale),
          approvalId: result.approval?.approvalId ?? null };
    } } : {}),
    get transparency(): readonly PanelLine[] {
      return [{ label: t('tui.provider.field.storage', {}, locale), text: custodyText(backend, locale), tone: 'muted' }];
    },
  };
}
