import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { OWNER_BASELINE_DEFAULT_FAMILIES } from '#domain/index.js';
import { delegationWords, delegationLines, mcpCapabilityWords, mcpCapabilityPreviewLines, type DelegationHandlers, type McpCapabilityHandlers } from '#surfaces/core/work-labels/index.js';
import type { TerminalLaunchContext } from './context.js';

import type { PolicyPanelPort } from '#surfaces/core/terminal-panels/index.js';
/** alpha.64 (owner S6): the one /policy row of the AI actor's v20 proposal rules; on/off through the governed template upgrade (no second write path). */
const AI_PROPOSALS = ':ai-proposals';
type AiState = 'on' | 'off' | 'partial' | 'unavailable';
/** The governed current first-run upgrade (`deckent policy upgrade --template current`, and this row): the engine's result, which a surface only words. */
export interface PolicyUpgradeView { readonly status: string; readonly revision: string; readonly summary: string | null; readonly missing: readonly string[]; readonly reason: string | null; readonly conflicts?: readonly string[];
  /** A scoped (`only`) read: the rules it would add and the current delta's rules held now. */ readonly rules?: readonly { readonly id: string }[]; readonly held?: readonly string[] }
export type PolicyTemplateUpgradePort = (root: string, scopeId: string, input: { readonly mode: 'preview' | 'apply' | 'rollback'; readonly expect?: string; readonly reason: string; readonly only?: 'ai-proposals' },
  options: { readonly env: NodeJS.ProcessEnv }) => Promise<PolicyUpgradeView>;
const aiState = (view: PolicyUpgradeView): AiState => view.status === 'unavailable' || !view.held ? 'unavailable' : view.status === 'current' ? view.held.length ? 'on' : 'unavailable' : view.held.length ? 'partial' : 'off';
export function policyPanelPort(root: string, host: McpCapabilityHandlers, options: ConfigLoadOptions, locale: Locale, delegation?: DelegationHandlers, baseline?: TerminalLaunchContext['openOwnerBaselineInstallation'],
  upgrade?: PolicyTemplateUpgradePort): PolicyPanelPort {
  const words = mcpCapabilityWords(locale), delegated = delegationWords(locale), env = { env: options.env ?? process.env };
  const reason = t('policy.aiProposals.reason', {}, locale), state = (value: AiState) => value === 'on' ? t('policy.aiProposals.state.on', {}, locale)
    : value === 'off' ? t('policy.aiProposals.state.off', {}, locale) : value === 'partial' ? t('policy.aiProposals.state.partial', {}, locale) : t('policy.aiProposals.state.unavailable', {}, locale);
  /** The scoped read: which v20 rules the policy holds and which `--apply --only ai-proposals` would add. */
  const proposals = (scopeId: string) => upgrade!(root, scopeId, { mode: 'preview', reason, only: 'ai-proposals' }, env);
  const lacking = (view: PolicyUpgradeView) => view.missing.map(item => item === 'policy-administer' ? t('cli.policy.upgrade.missing.policyAdminister', {}, locale)
    : item === 'approval-decide' ? t('cli.policy.upgrade.missing.approvalDecide', {}, locale) : item === 'lockout' ? t('cli.policy.upgrade.missing.lockout', {}, locale) : t('cli.policy.upgrade.missing.delegation', {}, locale));
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
      const ai = upgrade ? aiState(await proposals(scopeId).catch((): PolicyUpgradeView => ({ status: 'unavailable', revision: '', summary: null, missing: [], reason: null }))) : null;
      return { groups: [...view.groups.map(state => ({ id: state.group.id, label: words.label(state.group.labelKey, state.group.id),
        widerEarlier: state.managed === 'wider-earlier', detail: `${words.state[state.managed]} / ${words.effective[state.effective]}`,
        note: [words.label(state.group.noteKey, state.group.id), ...(state.group.availability === 'opt-in' ? [t('policy.mcp.optIn', {}, locale)] : []), t('policy.mcp.revokeLimit', {}, locale)].join('\n') })),
        ...(ai ? [{ id: AI_PROPOSALS, label: t('policy.aiProposals.label', {}, locale), detail: state(ai), note: t('policy.aiProposals.note', {}, locale) }] : [])] };
    },
    async preview(scopeId, groupId, action) {
      // The row's card: turning on adds only the v20 rules (`--apply --only ai-proposals`); turning off is `--rollback`, which has no preview: the card names the rules it removes.
      if (upgrade && groupId === AI_PROPOSALS) {
        const view = await proposals(scopeId), on = action !== 'revoke', ids = on ? (view.rules ?? []).map(rule => rule.id) : view.held ?? [];
        const applicable = ids.length > 0 && (!on || view.status === 'preview' && !view.missing.length);
        const head = !ids.length ? t('policy.aiProposals.nothing', { state: state(aiState(view)) }, locale) : on ? t('policy.aiProposals.onCard', { ids: ids.join(', ') }, locale) : t('policy.aiProposals.offCard', { ids: ids.join(', ') }, locale);
        return { scopeId, groupId, action, digest: view.revision, applicable, lines: [head, ...(on && ids.length && view.missing.length ? [t('cli.policy.upgrade.wouldRefuse', {}, locale), ...lacking(view)] : [])].map(text => ({ label: '', text })) };
      }
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
      if (upgrade && preview.groupId === AI_PROPOSALS) {
        const view = preview.action === 'revoke' ? await upgrade(root, preview.scopeId, { mode: 'rollback', reason }, env)
          : await upgrade(root, preview.scopeId, { mode: 'apply', reason, expect: preview.digest, only: 'ai-proposals' }, env);
        const done = view.status === 'upgraded' || view.status === 'rolled-back';
        const text = view.status === 'upgraded' ? t('policy.aiProposals.turnedOn', {}, locale) : view.status === 'rolled-back' ? t('policy.aiProposals.turnedOff', { ids: view.reason ?? '-' }, locale)
          : view.status === 'conflict' ? t('cli.policy.upgrade.conflict', { revision: view.revision }, locale) : view.status === 'refused' ? [t('cli.policy.upgrade.refused', {}, locale), ...lacking(view)].join('\n')
          : view.status === 'unavailable' && view.reason === 'history-unavailable' ? t('cli.policy.upgrade.historyMissing', { scope: preview.scopeId }, locale) : t('policy.aiProposals.nothing', { state: '-' }, locale);
        return [{ level: done ? 'info' as const : 'warning' as const, text }];
      }
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
