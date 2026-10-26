import type { PanelLine } from '#surfaces/core/terminal-panels/index.js';
import type { ModelConnectResult, McpCapabilityPreview, McpCapabilityRequest, McpCapabilityView } from '#domain/index.js';
import { t, type ConfigLoadOptions, type Locale, MESSAGE_REGISTRY } from '#platform/index.js';

export interface McpCapabilityHandlers {
  listMcpCapabilityScopes(root: string, options: ConfigLoadOptions): Promise<readonly string[]>;
  inspectMcpCapabilities(root: string, scopeId: string, options: ConfigLoadOptions): Promise<McpCapabilityView>;
  changeMcpCapabilities(root: string, input: McpCapabilityRequest, options: ConfigLoadOptions): Promise<McpCapabilityPreview>;
}
/** The complete preview is data, never the administration card's bounded/truncated summary. CLI and terminal show exactly these rows. */
export function mcpCapabilityPreviewLines(view: McpCapabilityPreview, locale: Locale): readonly string[] {
  const rows = view.rules.flatMap(rule => [
    `${view.action === 'grant' ? '+' : '-'} ${rule.id}`,
    t('policy.mcp.rule', { actions: rule.actions === 'all' ? '*' : rule.actions.join(', '), resource: rule.resource.kind,
      ids: rule.resource.ids === 'all' ? '*' : rule.resource.ids.join(', '), scopes: rule.scopes === 'all' ? t('policy.mcp.allScopes', {}, locale) : rule.scopes.join(', ') }, locale),
  ]);
  return [t('policy.mcp.actor', { actor: `${view.principal.issuer}/${view.principal.subject}`, scope: view.scopeId }, locale),
    ...rows, ...(view.remaining ? [t('policy.mcp.remaining', { count: view.remaining }, locale)] : []), t('policy.mcp.digest', { digest: view.digest }, locale),
    ...view.missing.map(reason => mcpCapabilityWords(locale).missing[reason] ?? reason)];
}

/** Registry labels resolve as catalog data; state messages have static i18n keys. Missing extension labels expose the selected id. */
export function mcpCapabilityWords(locale: Locale) {
  const catalog = MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>;
  return {
    label: (key: string, fallback: string) => catalog[key] ?? fallback,
    state: { 'wider-earlier': t('policy.mcp.state.wider-earlier', {}, locale), none: t('policy.mcp.state.none', {}, locale), partial: t('policy.mcp.state.partial', {}, locale),
      granted: t('policy.mcp.state.granted', {}, locale), conflict: t('policy.mcp.state.conflict', {}, locale) },
    effective: { denied: t('policy.mcp.effective.denied', {}, locale), partial: t('policy.mcp.effective.partial', {}, locale), allowed: t('policy.mcp.effective.allowed', {}, locale) },
    result: { preview: t('policy.mcp.result.preview', {}, locale), applied: t('policy.mcp.result.applied', {}, locale), current: t('policy.mcp.result.current', {}, locale),
      conflict: t('policy.mcp.result.conflict', {}, locale), refused: t('policy.mcp.result.refused', {}, locale) },
    missing: { 'policy-administer': t('policy.mcp.missing.policy-administer', {}, locale), 'approval-decide': t('policy.mcp.missing.approval-decide', {}, locale),
      delegation: t('policy.mcp.missing.delegation', {}, locale) } as Readonly<Record<string, string>>,
  };
}

export function modelConnectPullWords(locale: Locale) {
  return { connected: t('models.connect.pull.connected', { model: '{model}' }, locale), unpriced: t('models.connect.pull.unpriced', { model: '{model}' }, locale),
    notOnKey: t('models.connect.pull.notOnKey', { model: '{model}' }, locale), notInCatalog: t('models.connect.pull.notInCatalog', { model: '{model}' }, locale) };
}

/** The connection's result as the window's rows: the model, what each governed step did, the key's name, spending and the service. */
export function modelConnectLines(result: ModelConnectResult, label: string, locale: Locale): PanelLine[] {
  const step = (state: string) => state === 'written' ? t('models.connect.step.written', {}, locale) : state === 'present' ? t('models.connect.step.present', {}, locale)
    : t('models.connect.step.skipped', {}, locale);
  return [...(result.models ?? []).map(model => ({ label: '', text: modelConnectPullWords(locale)[model.state].replace('{model}', model.nativeId) })), { label: t('tui.provider.model.field.model', {}, locale), text: label },
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
];
}
