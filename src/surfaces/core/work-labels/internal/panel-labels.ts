import { t, type Locale } from '#platform/index.js';
import type { PanelLabels } from '#surfaces/core/terminal-panels/index.js';
import { pickerLabels } from './work-labels.js';

/** Catalog words of the `/mode`, `/config`, `/mcp` (T3 L4), `/model` and `/provider` (T4) windows, EN and TR; the panels themselves never call the catalog. */
export function terminalPanelLabels(locale: Locale): PanelLabels {
  return {
    picker: pickerLabels(locale), position: t('terminal.window.position', {}, locale), loading: t('tui.panel.loading', {}, locale),
    mode: { title: t('tui.panel.mode.title', {}, locale), hints: t('tui.panel.mode.hints', {}, locale), current: t('tui.panel.current', {}, locale),
      stops: { standart: t('terminal.mode.stop.standart', {}, locale), 'ask-edits': t('terminal.mode.stop.ask-edits', {}, locale), 'full-auto': t('terminal.mode.stop.full-auto', {}, locale),
        'full-access': t('terminal.mode.stop.full-access', {}, locale) },
      effect: { standart: t('terminal.mode.effect.standart', {}, locale), 'ask-edits': t('tui.panel.mode.effect.askEdits', {}, locale), 'full-auto': t('terminal.mode.effect.full-auto', {}, locale),
        'full-access': t('terminal.mode.effect.full-access', {}, locale) },
      fullAccessGrant: t('terminal.mode.fullAccessGrant', {}, locale), fullAutoOff: t('tui.panel.mode.fullAutoOff', {}, locale), unsupported: t('terminal.mode.unsupported', {}, locale) },
    config: { hints: t('tui.panel.config.hints', {}, locale), scopes: { project: t('tui.panel.config.scope.project', {}, locale), global: t('tui.panel.config.scope.global', {}, locale) },
      general: t('tui.panel.config.general', {}, locale), current: t('tui.panel.current', {}, locale), expected: t('tui.panel.config.expected', {}, locale),
      freeEntry: t('tui.panel.config.freeEntry', {}, locale), unset: t('tui.panel.config.unset', {}, locale), entryTitle: t('tui.panel.config.entryTitle', {}, locale),
      entryHint: t('tui.panel.config.entryHint', {}, locale) },
    mcp: { title: t('tui.panel.mcp.title', {}, locale), hints: t('tui.panel.mcp.hints', {}, locale), add: t('tui.panel.mcp.add', {}, locale), addDetail: t('tui.panel.mcp.addDetail', {}, locale),
      none: t('tui.panel.mcp.empty', {}, locale),
      actions: { detail: t('tui.panel.mcp.action.detail', {}, locale), revoke: t('tui.panel.mcp.action.revoke', {}, locale), approve: t('tui.panel.mcp.action.approve', {}, locale),
        reconnect: t('tui.panel.mcp.action.reconnect', {}, locale), remove: t('tui.panel.mcp.action.remove', {}, locale) },
      step: t('tui.panel.mcp.step', {}, locale),
      steps: { transport: t('tui.panel.mcp.steps.transport', {}, locale), name: t('tui.panel.mcp.steps.name', {}, locale), command: t('tui.panel.mcp.steps.command', {}, locale),
        url: t('tui.panel.mcp.steps.url', {}, locale), args: t('tui.panel.mcp.steps.args', {}, locale), env: t('tui.panel.mcp.steps.env', {}, locale), headers: t('tui.panel.mcp.steps.headers', {}, locale),
        realm: t('tui.panel.mcp.steps.realm', {}, locale), scope: t('tui.panel.mcp.steps.scope', {}, locale) },
      entryHints: { name: t('tui.panel.mcp.entry.name', {}, locale), command: t('tui.panel.mcp.entry.command', {}, locale), url: t('tui.panel.mcp.entry.url', {}, locale),
        args: t('tui.panel.mcp.entry.args', {}, locale), env: t('tui.panel.mcp.entry.env', {}, locale), headers: t('tui.panel.mcp.entry.headers', {}, locale) },
      pairInvalid: t('tui.panel.mcp.pairInvalid', {}, locale), empty: t('tui.panel.mcp.required', {}, locale), trustKeys: t('tui.panel.mcp.trust.keys', {}, locale) },
    model: { hints: t('tui.panel.model.hints', {}, locale), session: t('tui.panel.model.session', {}, locale), sessionAndDefault: t('tui.panel.model.sessionAndDefault', {}, locale),
      pinnedMark: t('tui.panel.model.pinnedMark', {}, locale), configuredMark: t('tui.panel.model.configuredMark', {}, locale), pinned: t('tui.panel.model.pinned', {}, locale) },
    provider: { title: t('tui.panel.provider.title', {}, locale), hints: t('tui.panel.provider.hints', {}, locale),
      actions: { connect: t('tui.panel.provider.action.connect', {}, locale), replace: t('tui.panel.provider.action.replace', {}, locale),
        disconnect: t('tui.panel.provider.action.disconnect', {}, locale) },
      endpointTitle: t('tui.panel.provider.endpointTitle', {}, locale), endpointHint: t('tui.panel.provider.endpointHint', {}, locale),
      keyTitle: t('tui.panel.provider.keyTitle', {}, locale), keyHint: t('tui.panel.provider.keyHint', {}, locale), keyOptionalHint: t('tui.panel.provider.keyOptionalHint', {}, locale),
      keyRequired: t('tui.panel.provider.keyRequired', {}, locale), checking: t('tui.panel.provider.checking', {}, locale), resultHints: t('tui.panel.provider.resultHints', {}, locale),
      disconnectTitle: t('tui.panel.provider.disconnectTitle', {}, locale), disconnectKeys: t('tui.panel.provider.disconnectKeys', {}, locale),
      empty: t('tui.panel.provider.empty', {}, locale) },
  };
}
