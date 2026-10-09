import type { McpCapabilityPreview, McpCapabilityRequest, McpCapabilityView } from '#domain/index.js';
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
    ...rows, t('policy.mcp.digest', { digest: view.digest }, locale),
    ...view.missing.map(reason => mcpCapabilityWords(locale).missing[reason] ?? reason)];
}

/** Registry labels resolve as catalog data; state messages have static i18n keys. Missing extension labels expose the selected id. */
export function mcpCapabilityWords(locale: Locale) {
  const catalog = MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>;
  return {
    label: (key: string, fallback: string) => catalog[key] ?? fallback,
    state: { none: t('policy.mcp.state.none', {}, locale), partial: t('policy.mcp.state.partial', {}, locale),
      granted: t('policy.mcp.state.granted', {}, locale), conflict: t('policy.mcp.state.conflict', {}, locale) },
    effective: { denied: t('policy.mcp.effective.denied', {}, locale), partial: t('policy.mcp.effective.partial', {}, locale), allowed: t('policy.mcp.effective.allowed', {}, locale) },
    result: { preview: t('policy.mcp.result.preview', {}, locale), applied: t('policy.mcp.result.applied', {}, locale), current: t('policy.mcp.result.current', {}, locale),
      conflict: t('policy.mcp.result.conflict', {}, locale), refused: t('policy.mcp.result.refused', {}, locale) },
    missing: { 'policy-administer': t('policy.mcp.missing.policy-administer', {}, locale), 'approval-decide': t('policy.mcp.missing.approval-decide', {}, locale),
      delegation: t('policy.mcp.missing.delegation', {}, locale) } as Readonly<Record<string, string>>,
  };
}
