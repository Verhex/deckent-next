import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { delegationWords, delegationLines, mcpCapabilityWords, mcpCapabilityPreviewLines, type DelegationHandlers, type McpCapabilityHandlers } from '#surfaces/core/work-labels/index.js';
import type { PolicyPanelPort } from '#surfaces/core/terminal-panels/index.js';

export function policyPanelPort(root: string, host: McpCapabilityHandlers, options: ConfigLoadOptions, locale: Locale, delegation?: DelegationHandlers): PolicyPanelPort {
  const words = mcpCapabilityWords(locale), delegated = delegationWords(locale);
  return {
    scopes: () => host.listMcpCapabilityScopes(root, options),
    ...(delegation ? { async delegations(scopeId: string) {
      const view = await delegation.inspect(root, { schemaVersion: 1, scopeId }, options);
      return { groups: view.steps.map(row => ({ id: `decision:${row.step.id}`, label: delegated.step[row.step.id] ?? row.step.id,
        detail: `${delegated.managed[row.managed]} / ${delegated.effective[row.effective]}`,
        note: delegationLines(view, locale).join('\n') })) };
    } } : {}),
    async inspect(scopeId) {
      const view = await host.inspectMcpCapabilities(root, scopeId, options);
      return { groups: view.groups.map(state => ({ id: state.group.id, label: words.label(state.group.labelKey, state.group.id),
        detail: `${words.state[state.managed]} / ${words.effective[state.effective]}`,
        note: [words.label(state.group.noteKey, state.group.id), ...(state.group.availability === 'opt-in' ? [t('policy.mcp.optIn', {}, locale)] : []), t('policy.mcp.revokeLimit', {}, locale)].join('\n') })) };
    },
    async preview(scopeId, groupId, action) {
      if (delegation && groupId.startsWith('decision:')) {
        const view = await delegation.inspect(root, { schemaVersion: 1, scopeId }, options), step = groupId.slice('decision:'.length);
        return { scopeId, groupId, action, digest: view.revision, delegation: true, applicable: view.steps.some(row => row.step.id === step && row.managed !== 'conflict'),
          lines: [t('policy.delegate.confirm', { step, action: delegated.action[action] }, locale),
            ...delegationLines({ ...view, steps: view.steps.filter(row => row.step.id === step) }, locale)].map(text => ({ label: '', text })) };
      }
      const view = await host.changeMcpCapabilities(root, { scopeId, groupId, action, mode: 'preview' }, options);
      return { scopeId, groupId, action, digest: view.digest, applicable: view.status === 'preview' && !view.missing.length,
        lines: [words.result[view.status], ...mcpCapabilityPreviewLines(view, locale)].map(text => ({ label: '', text })) };
    },
    async apply(preview) {
      if (delegation && preview.delegation) {
        const result = await delegation.change(root, { schemaVersion: 1, scopeId: preview.scopeId, step: preview.groupId.slice('decision:'.length),
          action: preview.action, expectedRevision: preview.digest }, async () => true, options);
        return [{ level: 'info' as const, text: delegated.result[result.status] }];
      }
      const view = await host.changeMcpCapabilities(root, { scopeId: preview.scopeId, groupId: preview.groupId, action: preview.action, mode: 'apply', expect: preview.digest }, options);
      const level = view.status === 'applied' || view.status === 'current' ? 'info' as const : 'warning' as const;
      return [words.result[view.status], ...view.missing.map(reason => words.missing[reason] ?? reason)].map(text => ({ level, text }));
    },
  };
}
