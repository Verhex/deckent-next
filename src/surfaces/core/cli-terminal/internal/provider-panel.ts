import { loadConfig, MESSAGE_REGISTRY, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { PanelLine, ProviderConnectOutcome, ProviderConnectRequest, ProviderPanelKind, ProviderPanelPort } from '#surfaces/core/terminal-panels/index.js';
import type { ProviderConnectKindView, ProviderConnectProbeView, TerminalLaunchContext } from './context.js';

/** The words of a kind: its catalog key comes with the adapter's data (an unknown key from newer data keeps the kind's id). */
function kindLabel(kind: ProviderConnectKindView | undefined, id: string, locale: Locale): string {
  return kind ? (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[kind.labelKey] ?? id : id;
}
/** The check's typed outcome in words (the secret lane's rejection kinds, then unreachable / unexpected). */
export function providerOutcomeWord(probe: ProviderConnectProbeView, locale: Locale): string {
  switch (probe.outcome) {
    case 'ok': return probe.key === 'verified' ? t('tui.provider.outcome.ok', {}, locale) : probe.key === 'none' ? t('tui.provider.outcome.okNoKey', {}, locale)
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

type Host = Pick<TerminalLaunchContext, 'providerConnect' | 'listSecretNames' | 'setSecret' | 'deleteSecret'>;
/**
 * The terminal `/provider` window's port (T4 PROVIDER-CONNECT). It lists the kinds the host's adapter data names, the key name each is kept
 * under (names only: values are never read back) and how many of this scope's invocation profiles name that key. Connect runs the free check
 * and, only when it passes, sends the key to the installation's secret store through the runtime service (`setSecret`: policy cell `secret`,
 * audited, never the value). The key is never echoed, logged, audited, put in a returned row or in the environment; no worker sees it. Binding
 * models to the key stays the governed catalog/profile path (open owner decision): the result names the next step instead.
 */
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
      let named: readonly string[] = [];
      try { named = await refs(); } catch (error) { notes.push(t('tui.provider.note.profilesUnread', { reason: errorText(error) }, locale)); }
      const kinds: ProviderPanelKind[] = connect.kinds.map(kind => {
        const keyName = kind.secretName, stored = keyName !== null && names !== null && names.includes(keyName), using = keyName ? named.filter(ref => ref === keyName).length : 0;
        const detail = !kind.available ? '' : keyName === null ? '-' : names === null ? t('tui.provider.state.unknown', { name: keyName }, locale)
          : stored ? t('tui.provider.state.stored', { name: keyName, count: using }, locale) : t('tui.provider.state.notConnected', {}, locale);
        return { id: kind.id, label: kindLabel(kind, kind.id, locale), detail, blocked: kind.available ? null : t('tui.provider.unavailable', {}, locale), keyName, keyStored: stored,
          endpointEditable: kind.endpointEditable, endpointDefault: kind.endpointDefault, keyRequired: kind.keyRequired };
      });
      if (!host.setSecret) notes.push(t('tui.provider.note.noStore', {}, locale));
      return { title: t('tui.panel.provider.title', {}, locale), kinds, notes };
    },
    endpoint(_kind, text) {
      const checked = connect.endpoint(text);
      return checked.ok ? null : endpointWord(checked.reason, locale);
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
      const check: PanelLine = { label: t('tui.provider.field.check', {}, locale), text: providerOutcomeWord(probe, locale), ...(probe.outcome === 'ok' ? {} : { tone: 'warning' as const }) };
      const where: PanelLine[] = request.endpoint ? [{ label: t('tui.provider.field.endpoint', {}, locale), text: request.endpoint }] : [];
      if (probe.outcome !== 'ok') return refused([check, ...where, { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.notStored', {}, locale) }]);
      const name = kind.secretName;
      let keyLine: PanelLine;
      let stored = false;
      if (request.key === null || name === null) keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.none', {}, locale) };
      else if (!host.setSecret) keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.note.noStore', {}, locale), tone: 'warning' };
      else {
        try {
          const change = await host.setSecret(root, { schemaVersion: 1, scopeId, name, value: request.key }, options);
          stored = true; backend = change.backend;
          keyLine = { label: t('tui.provider.field.key', {}, locale), text: t('tui.provider.key.stored', { name, backend: change.backend }, locale) };
        } catch (error) {
          // A store that cannot write (the environment backend), a policy refusal: the typed reason; nothing else was kept.
          keyLine = { label: t('tui.provider.field.key', {}, locale), text: `${t('tui.provider.key.notStored', {}, locale)} ${errorText(error)}`, tone: 'warning' };
        }
      }
      const using = name ? (await refs().catch(() => [] as readonly string[])).filter(ref => ref === name).length : 0;
      const next: PanelLine = { label: t('tui.provider.field.next', {}, locale), text: using > 0 ? t('tui.provider.next.bound', { count: using }, locale)
        : t('tui.provider.next.unbound', { name: name ?? '-', scope: scopeId }, locale), tone: 'muted' };
      const ok = stored || request.key === null;
      return { stored, title: ok ? t('tui.provider.result.ok', { kind: label }, locale) : t('tui.provider.result.refused', { kind: label }, locale), lines: [check, ...where, keyLine, next] };
    },
    async disconnect(id) {
      const kind = kindOf(id), name = kind?.secretName;
      if (!kind || !name || !host.deleteSecret) return [t('tui.provider.note.noStore', {}, locale)];
      const change = await host.deleteSecret(root, { schemaVersion: 1, scopeId, name }, options);
      const using = (await refs().catch(() => [] as readonly string[])).filter(ref => ref === name).length;
      return [change.removed ? t('tui.provider.disconnected', { name }, locale) : t('tui.provider.notStored', { name }, locale),
        ...(using > 0 ? [t('tui.provider.disconnectedBound', { count: using, name }, locale)] : [])];
    },
    get transparency(): readonly PanelLine[] {
      return [{ label: t('tui.provider.field.storage', {}, locale), text: t('tui.panel.provider.transparency', { backend }, locale), tone: 'muted' }];
    },
  };
}
