import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { OWNER_BASELINE_DEFAULT_FAMILIES } from '#domain/index.js';
import { delegationWords, delegationLines, mcpCapabilityWords, mcpCapabilityPreviewLines, type DelegationHandlers, type McpCapabilityHandlers } from '#surfaces/core/work-labels/index.js';
import type { TerminalLaunchContext } from './context.js';
import type { PolicyPanelPort } from '#surfaces/core/terminal-panels/index.js';
export function policyPanelPort(root: string, host: McpCapabilityHandlers, options: ConfigLoadOptions, locale: Locale, delegation?: DelegationHandlers, baseline?: TerminalLaunchContext['openOwnerBaselineInstallation']): PolicyPanelPort {
  const words = mcpCapabilityWords(locale), delegated = delegationWords(locale);
  return {
    ...(baseline ? { async ownerBaseline(scopeId: string) {
      const result = await baseline(root, scopeId, { families: OWNER_BASELINE_DEFAULT_FAMILIES, apply: false });
      return { scopeId, groupId: ':owner-baseline', action: 'grant' as const, digest: result.expect ?? '', ownerBaseline: true, applicable: result.status === 'preview',
        lines: [{ label: '', text: t('cli.init.ownerBaseline.summary', { status: result.status, reason: result.reason ?? '-', scope: scopeId, who: `${result.principal.issuer}/${result.principal.subject}`, added: result.added.length, removed: result.removed.length, remaining: result.remaining }, locale) }, { label: '', text: t('cli.init.ownerBaseline.notice', {}, locale) }, ...result.cells.map(cell => ({ label: cell.kind,
          text: `${cell.actions.join(', ')} / ${cell.ids === 'all' ? '*' : cell.ids.join(', ')} / ${cell.scopes === 'all' ? '*' : cell.scopes.join(', ')}: ${cell.before} → ${cell.after}` }))] };
    } } : {}),
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
        widerEarlier: state.managed === 'wider-earlier', detail: `${words.state[state.managed]} / ${words.effective[state.effective]}`,
        note: [words.label(state.group.noteKey, state.group.id), ...(state.group.availability === 'opt-in' ? [t('policy.mcp.optIn', {}, locale)] : []), t('policy.mcp.revokeLimit', {}, locale)].join('\n') })) };
    },
    async preview(scopeId, groupId, action) {
      if (delegation && groupId.startsWith('decision:')) {
        const view = await delegation.inspect(root, { schemaVersion: 1, scopeId }, options), step = groupId.slice('decision:'.length);
        return { scopeId, groupId, action, digest: view.revision, delegation: true, applicable: view.steps.some(row => row.step.id === step && row.managed !== 'conflict'),
          lines: [t('policy.delegate.confirm', { step, action: delegated.action[action === 'narrow' ? 'grant' : action] }, locale),
            ...delegationLines({ ...view, steps: view.steps.filter(row => row.step.id === step) }, locale)].map(text => ({ label: '', text })) };
      }
      const view = await host.changeMcpCapabilities(root, { scopeId, groupId, action, mode: 'preview' }, options);
      return { scopeId, groupId, action, digest: view.digest, needsBaseline: Boolean(baseline && view.missing.includes('delegation')), applicable: view.status === 'preview' && !view.missing.length,
        lines: [words.result[view.status], ...mcpCapabilityPreviewLines(view, locale)].map(text => ({ label: '', text })) };
    },
    async apply(preview) {
      if (preview.ownerBaseline && baseline) {
        const result = await baseline(root, preview.scopeId, { families: OWNER_BASELINE_DEFAULT_FAMILIES, apply: true, expect: preview.digest });
        return [{ level: result.status === 'applied' || result.status === 'current' ? 'info' as const : 'warning' as const, text: t('cli.init.ownerBaseline.summary', { status: result.status, reason: result.reason ?? '-', scope: preview.scopeId, who: `${result.principal.issuer}/${result.principal.subject}`, added: result.added.length, removed: result.removed.length, remaining: result.remaining }, locale) }];
      }
      if (delegation && preview.delegation) {
        const result = await delegation.change(root, { schemaVersion: 1, scopeId: preview.scopeId, step: preview.groupId.slice('decision:'.length),
          action: preview.action === 'narrow' ? 'grant' : preview.action, expectedRevision: preview.digest }, async () => true, options);
        return [{ level: 'info' as const, text: delegated.result[result.status] }];
      }
      const view = await host.changeMcpCapabilities(root, { scopeId: preview.scopeId, groupId: preview.groupId, action: preview.action, mode: 'apply', expect: preview.digest }, options);
      const level = view.status === 'applied' || view.status === 'current' ? 'info' as const : 'warning' as const;
      return [words.result[view.status], ...view.missing.map(reason => words.missing[reason] ?? reason)].map(text => ({ level, text }));
    },
  };
}
