import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { CachePanelPort, CachePanelView, PanelLine } from '#surfaces/core/terminal-panels/index.js';
import type { ConfigCommandContext } from '#surfaces/core/config/index.js';
import type { TerminalLaunchContext } from './context.js';
import DISPLAY from './cache-display.json' with { type: 'json' };

// The config surface reaches the terminal renderer; load it only when the write happens (startup graph stays light, as the `/model` default write).
const terminalConfigWrite = async (...args: Parameters<typeof import('#surfaces/core/config/index.js').terminalConfigWrite>) =>
  (await import('#surfaces/core/config/index.js')).terminalConfigWrite(...args);

type Host = Required<Pick<TerminalLaunchContext, 'planProfileCache'>> & Pick<ConfigCommandContext, 'configApplication' | 'resolveConfigPrincipal' | 'describeRuntimeService'>;
/** Display precision of a price ratio (data: `cache-display.json`). */
const ratio = (value: number, locale: Locale) => value.toLocaleString(locale === 'tr' ? 'tr-TR' : 'en-US', { maximumFractionDigits: DISPLAY.ratioFractionDigits });
/** Reuses within the TTL after which the write premium is paid back: each read saves (1 − read) of the input price, the write costs (write − 1) more. */
export function cachePaybackReuses(writeRatio: number, readRatio: number): number | null {
  if (readRatio >= 1) return null;
  return Math.max(1, Math.ceil((writeRatio - 1) / (1 - readRatio) - 1e-9));
}

/**
 * CACHE-SLICE1 `/model` and `/provider` cache window port (owner 2026-10-09): the existing profiles of this scope whose definition has no cache choice
 * (never one with an explicit `none`), each with its own tariff's cost note, and the one governed step that switches them to the 5-minute cache —
 * each authored layer's profile document through the `/config` writer (policy, approval, audit). The plan is read again at the answer.
 */
export function cachePanelPort(root: string, scopeId: string, host: Host, options: ConfigLoadOptions, locale: Locale): CachePanelPort {
  return {
    async inspect(): Promise<CachePanelView | null> {
      const plan = await host.planProfileCache(root, scopeId, options);
      if (plan.models.length === 0) return null;
      const lines: PanelLine[] = [{ label: '', text: t('tui.cache.what', { count: plan.models.length }, locale) },
        ...plan.models.map(model => {
          const reuses = cachePaybackReuses(model.writeRatio, model.readRatio);
          const values = { write: ratio(model.writeRatio, locale), read: ratio(model.readRatio, locale) };
          return { label: model.modelId, text: reuses === null ? t('tui.cache.costNever', values, locale) : t('tui.cache.cost', { ...values, reuses }, locale) };
        }),
        { label: '', text: t('tui.cache.note', {}, locale), tone: 'muted' },
        ...(plan.shared.length ? [{ label: '', text: t('tui.cache.shared', { count: plan.shared.length }, locale), tone: 'warning' as const }] : [])];
      return { detail: t('tui.cache.detail', { count: plan.models.length }, locale), lines };
    },
    async apply() {
      const plan = await host.planProfileCache(root, scopeId, options), lines: string[] = [];
      if (plan.writes.length === 0) return { status: 'applied', lines: [t('tui.cache.nothing', {}, locale)], approvalId: null };
      for (const write of plan.writes) {
        const outcome = await terminalConfigWrite(root, { action: 'set', keyPath: 'provider_invocation_profiles', value: write.value, layer: write.layer }, host, options, locale);
        lines.push(...outcome.lines);
        // A policy approval stops here; after it is allowed the same window offers the rest (the plan is read again).
        if (outcome.status === 'approval-pending') return { status: outcome.status, lines, approvalId: outcome.approvalId };
      }
      return { status: 'applied', lines: [t('tui.cache.enabled', { count: plan.models.length }, locale), ...lines], approvalId: null };
    },
  };
}
