import { t, type Locale } from '#platform/index.js';
import type { AssistantRenderLabels } from '#surfaces/core/terminal-render/index.js';
import type { ComposerLabels } from '#surfaces/core/terminal-composer/index.js';
import type { ConversationSessionLabels } from '#surfaces/core/terminal/index.js';

/** Catalog strings of the rendered answer (terminal.render.*): narration, footer, tool lines, context, compaction. */
export function terminalRenderLabels(locale: Locale): AssistantRenderLabels {
  return {
    assistant: t('terminal.workline.roleAssistant', {}, locale), thinking: t('terminal.render.thinking', {}, locale),
    thought: t('terminal.render.thought', {}, locale), elapsed: t('terminal.render.elapsed', {}, locale),
    tokens: t('terminal.render.tokens', {}, locale), reasoningTokens: t('terminal.render.reasoningTokens', {}, locale),
    truncated: t('terminal.render.truncated', {}, locale), cancelled: t('terminal.render.cancelled', {}, locale),
    failed: t('terminal.render.failed', {}, locale), code: t('terminal.render.code', {}, locale),
    moreAbove: t('terminal.render.moreAbove', {}, locale), queued: t('terminal.render.queued', {}, locale),
    tool: t('terminal.render.tool', {}, locale), toolRunning: t('terminal.render.toolRunning', {}, locale),
    context: t('terminal.render.context', {}, locale), compacted: t('terminal.render.compacted', {}, locale),
    toolStatus: { error: t('terminal.render.toolStatus.error', {}, locale), denied: t('terminal.render.toolStatus.denied', {}, locale),
      'approval-required': t('terminal.render.toolStatus.approvalRequired', {}, locale),
      'approval-expired': t('terminal.render.toolStatus.approvalExpired', {}, locale),
      'invalid-arguments': t('terminal.render.toolStatus.invalidArguments', {}, locale),
      duplicate: t('terminal.render.toolStatus.duplicate', {}, locale), cancelled: t('terminal.render.toolStatus.cancelled', {}, locale) },
  };
}

/** Catalog strings of the composer (terminal.composer.*) and the slash popup (terminal.slash.*). */
export function terminalComposerLabels(locale: Locale): ComposerLabels {
  return { pasteChip: t('terminal.composer.pasteChip', {}, locale), search: t('terminal.composer.search', {}, locale),
    exitArmed: t('terminal.composer.exitArmed', {}, locale), shortcuts: t('terminal.composer.shortcuts', {}, locale),
    slash: { 'terminal.slash.status': t('terminal.slash.status', {}, locale), 'terminal.slash.workers': t('terminal.slash.workers', {}, locale),
      'terminal.slash.watchWorkers': t('terminal.slash.watchWorkers', {}, locale), 'terminal.slash.watchRuns': t('terminal.slash.watchRuns', {}, locale),
      'terminal.slash.watchStop': t('terminal.slash.watchStop', {}, locale), 'terminal.slash.run': t('terminal.slash.run', {}, locale),
      'terminal.slash.runArgument': t('terminal.slash.runArgument', {}, locale), 'terminal.slash.runs': t('terminal.slash.runs', {}, locale),
      'terminal.slash.serviceRestart': t('terminal.slash.serviceRestart', {}, locale), 'terminal.slash.exit': t('terminal.slash.exit', {}, locale),
      'terminal.slash.help': t('terminal.slash.help', {}, locale), 'terminal.slash.transcript': t('terminal.slash.transcript', {}, locale),
      'terminal.slash.approvals': t('terminal.slash.approvals', {}, locale), 'terminal.slash.cancel': t('terminal.slash.cancel', {}, locale),
      'terminal.slash.context': t('terminal.slash.context', {}, locale), 'terminal.slash.resume': t('terminal.slash.resume', {}, locale),
      'terminal.slash.resumeArgument': t('terminal.slash.resumeArgument', {}, locale), 'terminal.slash.new': t('terminal.slash.new', {}, locale) } };
}

/** Catalog strings of `/resume`, `/context` and `/new` (terminal.session.*). */
export function terminalSessionLabels(locale: Locale): ConversationSessionLabels {
  return { entry: t('terminal.session.entry', {}, locale), none: t('terminal.session.none', {}, locale), notFound: t('terminal.session.notFound', {}, locale),
    unavailable: t('terminal.session.unavailable', {}, locale), saveFailed: t('terminal.session.saveFailed', {}, locale),
    resumed: t('terminal.session.resumed', {}, locale), started: t('terminal.session.started', {}, locale),
    context: t('terminal.session.context', {}, locale), contextNone: t('terminal.session.contextNone', {}, locale) };
}
