import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { mcpCapabilityWords, mcpCapabilityPreviewLines, type McpCapabilityHandlers } from '#surfaces/core/work-labels/index.js';
import type { PolicyPanelPort } from '#surfaces/core/terminal-panels/index.js';

export function policyPanelPort(root: string, host: McpCapabilityHandlers, options: ConfigLoadOptions, locale: Locale): PolicyPanelPort {
  const words = mcpCapabilityWords(locale);
  return {
    scopes: () => host.listMcpCapabilityScopes(root, options),
    async inspect(scopeId) {
      const view = await host.inspectMcpCapabilities(root, scopeId, options);
      return { groups: view.groups.map(state => ({ id: state.group.id, label: words.label(state.group.labelKey, state.group.id),
        detail: `${words.state[state.managed]} / ${words.effective[state.effective]}`,
        note: [words.label(state.group.noteKey, state.group.id), ...(state.group.proposed ? [t('policy.mcp.proposed', {}, locale)] : []), t('policy.mcp.revokeLimit', {}, locale)].join('\n') })) };
    },
    async preview(scopeId, groupId, action) {
      const view = await host.changeMcpCapabilities(root, { scopeId, groupId, action, mode: 'preview' }, options);
      return { scopeId, groupId, action, digest: view.digest, applicable: view.status === 'preview' && !view.missing.length,
        lines: [words.result[view.status], ...mcpCapabilityPreviewLines(view, locale)].map(text => ({ label: '', text })) };
    },
    async apply(preview) {
      const view = await host.changeMcpCapabilities(root, { scopeId: preview.scopeId, groupId: preview.groupId, action: preview.action, mode: 'apply', expect: preview.digest }, options);
      const level = view.status === 'applied' || view.status === 'current' ? 'info' as const : 'warning' as const;
      return [words.result[view.status], ...view.missing.map(reason => words.missing[reason] ?? reason)].map(text => ({ level, text }));
    },
  };
}
