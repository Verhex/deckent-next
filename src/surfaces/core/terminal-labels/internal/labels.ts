import { t, type Locale } from '#platform/index.js';
import type { AssistantRenderLabels } from '#surfaces/core/terminal-render/index.js';
import type { ComposerLabels } from '#surfaces/core/terminal-composer/index.js';
import type { ConversationSessionLabels } from '#surfaces/core/terminal/index.js';

/** Catalog strings of the rendered answer (terminal.render.*): narration, footer, tool lines, context, compaction. */
export function terminalRenderLabels(locale: Locale): AssistantRenderLabels {
  return {
    hiddenCount: t('terminal.safety.hiddenCount', {}, locale),
    credentialLikeCount: t('terminal.safety.credentialLikeCount', {}, locale),
    assistant: t('terminal.workline.roleAssistant', {}, locale), thinking: t('terminal.render.thinking', {}, locale),
    toolCleanup: { 'group-ended': t('terminal.render.toolCleanup.groupEnded', {}, locale), unverified: t('terminal.render.toolCleanup.unverified', {}, locale) },
    waiting: { model: t('terminal.render.waiting.model', {}, locale), compaction: t('terminal.render.waiting.compaction', {}, locale) },
    cancelledDuring: { compaction: t('terminal.render.cancelledDuring.compaction', {}, locale), model: t('terminal.render.cancelledDuring.model', {}, locale),
      tool: t('terminal.render.cancelledDuring.tool', {}, locale) },
    compactionCancelled: t('terminal.render.compactionCancelled', {}, locale), cancelHint: t('terminal.render.cancelHint', {}, locale),
    toolSandboxNone: t('terminal.render.toolSandboxNone', {}, locale),
    toolSandboxDegraded: t('terminal.render.toolSandboxDegraded', {}, locale),
    toolSummary: { lines: t('terminal.render.toolSummary.lines', {}, locale), linesMore: t('terminal.render.toolSummary.linesMore', {}, locale), headings: t('terminal.render.toolSummary.headings', {}, locale), headingsMore: t('terminal.render.toolSummary.headingsMore', {}, locale), matches: t('terminal.render.toolSummary.matches', {}, locale), matchesMore: t('terminal.render.toolSummary.matchesMore', {}, locale), entries: t('terminal.render.toolSummary.entries', {}, locale) },
    toolTracked: t('terminal.render.toolTracked', {}, locale),
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
    placeholder: t('terminal.workline.placeholder', {}, locale),
    slash: { 'terminal.slash.status': t('terminal.slash.status', {}, locale), 'terminal.slash.workers': t('terminal.slash.workers', {}, locale),
      'terminal.slash.watchWorkers': t('terminal.slash.watchWorkers', {}, locale), 'terminal.slash.watchRuns': t('terminal.slash.watchRuns', {}, locale),
      'terminal.slash.watchStop': t('terminal.slash.watchStop', {}, locale), 'terminal.slash.run': t('terminal.slash.run', {}, locale),
      'terminal.slash.runArgument': t('terminal.slash.runArgument', {}, locale), 'terminal.slash.runs': t('terminal.slash.runs', {}, locale),
      'terminal.slash.serviceRestart': t('terminal.slash.serviceRestart', {}, locale), 'terminal.slash.exit': t('terminal.slash.exit', {}, locale),
      'terminal.slash.help': t('terminal.slash.help', {}, locale), 'terminal.slash.transcript': t('terminal.slash.transcript', {}, locale),
      'terminal.slash.approvals': t('terminal.slash.approvals', {}, locale), 'terminal.slash.cancel': t('terminal.slash.cancel', {}, locale),
      'terminal.slash.context': t('terminal.slash.context', {}, locale), 'terminal.slash.resume': t('terminal.slash.resume', {}, locale),
      'terminal.slash.resumeArgument': t('terminal.slash.resumeArgument', {}, locale), 'terminal.slash.clear': t('terminal.slash.clear', {}, locale),
      'terminal.slash.transcriptArgument': t('terminal.slash.transcriptArgument', {}, locale),
      'terminal.slash.cancelArgument': t('terminal.slash.cancelArgument', {}, locale),
      'terminal.slash.mode': t('terminal.slash.mode', {}, locale), 'terminal.slash.modeArgument': t('terminal.slash.modeArgument', {}, locale),
      'terminal.slash.reasoning': t('terminal.slash.reasoning', {}, locale), 'terminal.slash.scratch': t('terminal.slash.scratch', {}, locale),
      'terminal.slash.monitor': t('terminal.slash.monitor', {}, locale) } };
}

/** Catalog strings of `/resume`, `/context` and `/clear` (terminal.session.*). */
export function terminalSessionLabels(locale: Locale): ConversationSessionLabels {
  return { entry: t('terminal.session.entry', {}, locale), hiddenCount: t('terminal.safety.hiddenCount', {}, locale), none: t('terminal.session.none', {}, locale), notFound: t('terminal.session.notFound', {}, locale),
    unavailable: t('terminal.session.unavailable', {}, locale), saveFailed: t('terminal.session.saveFailed', {}, locale),
    exactRequired: t('terminal.session.exactRequired', {}, locale), listStale: t('terminal.session.listStale', {}, locale),
    resumed: t('terminal.session.resumed', {}, locale), started: t('terminal.session.started', {}, locale),
    context: t('terminal.session.context', {}, locale), contextNone: t('terminal.session.contextNone', {}, locale),
    history: { omitted: t('terminal.session.history.omitted', {}, locale), toolResults: t('terminal.session.history.toolResults', {}, locale),
      summarized: t('terminal.session.history.summarized', {}, locale) },
    view: { bar: t('terminal.context.bar', {}, locale), threshold: t('terminal.context.threshold', {}, locale), split: t('terminal.context.split', {}, locale),
      compacted: t('terminal.context.compacted', {}, locale), compactedNone: t('terminal.context.compactedNone', {}, locale), largest: t('terminal.context.largest', {}, locale),
      suggestNew: t('terminal.context.suggestNew', {}, locale), suggestTools: t('terminal.context.suggestTools', {}, locale) } };
}
