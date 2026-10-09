import { isDeepStrictEqual } from 'node:util';
import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { CachePanelPort } from '#surfaces/core/terminal-panels/index.js';
import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { TerminalLaunchContext, TerminalProfileProtocolPlan } from './context.js';

const terminalConfigWrite = async (...args: Parameters<typeof import('#surfaces/core/config/index.js').terminalConfigWrite>) =>
  (await import('#surfaces/core/config/index.js')).terminalConfigWrite(...args);
type Host = Required<Pick<TerminalLaunchContext, 'planProfileProtocol'>> & Pick<ConfigCommandContext, 'configApplication' | 'resolveConfigPrincipal' | 'describeRuntimeService'>;

/** The preview is mandatory. Cancel writes nothing; policy/approval/audit stay with the existing config writer. */
export function protocolPanelPort(root: string, scopeId: string, host: Host, options: ConfigLoadOptions, locale: Locale): CachePanelPort {
  let preview: TerminalProfileProtocolPlan | null = null;
  return {
    async inspect() {
      const plan = await host.planProfileProtocol(root, scopeId, options); preview = plan;
      if (!plan.models.length && !plan.shared.length) return null;
      return { detail: t('tui.protocol.detail', { count: plan.models.length }, locale),
        lines: [{ label: '', text: t('tui.protocol.what', {}, locale) },
          ...plan.models.map(({ detail }) => ({ label: detail.modelId, text: t('tui.protocol.route', { from: detail.from, to: detail.to }, locale) })),
          { label: '', text: t('tui.protocol.kept', {}, locale), tone: 'muted' as const },
          ...(plan.shared.length ? [{ label: '', text: t('tui.protocol.shared', { count: plan.shared.length }, locale), tone: 'warning' as const }] : [])] };
    },
    async apply() {
      const plan = await host.planProfileProtocol(root, scopeId, options);
      if (!preview || !isDeepStrictEqual(preview, plan)) throw new Error(t('tui.protocol.changed', {}, locale));
      if (!plan.writes.length) throw new Error(t('tui.protocol.shared', { count: plan.shared.length }, locale));
      const lines: string[] = [];
      for (const write of plan.writes) {
        const result = await terminalConfigWrite(root, { action: 'set', keyPath: 'provider_invocation_profiles', value: write.value, layer: write.layer, expect: write.expect }, host, options, locale);
        lines.push(...result.lines);
        if (result.status === 'approval-pending') return { ...result, lines };
      }
      return { status: 'applied', lines: [t('tui.protocol.applied', { count: plan.models.length }, locale), ...lines], approvalId: null };
    },
  };
}
