import { MESSAGE_REGISTRY, t, type Locale } from '#platform/index.js';
import type { AssistantRenderLabels } from '#surfaces/core/terminal-render/index.js';
import type { ComposerLabels } from '#surfaces/core/terminal-composer/index.js';
import type { ConversationSessionLabels } from '#surfaces/core/terminal/index.js';
import { SLASH_GROUPS, SLASH_HELP_TITLE_KEY, WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal-kit/index.js';

/** Catalog strings of the rendered answer (terminal.render.*): narration, footer, tool lines, context, compaction. */
export function terminalRenderLabels(locale: Locale): AssistantRenderLabels {
  return {
    locale,
    hiddenCount: t('terminal.safety.hiddenCount', {}, locale),
    credentialLikeCount: t('terminal.safety.credentialLikeCount', {}, locale),
    assistant: t('terminal.workline.roleAssistant', {}, locale), thinking: t('terminal.render.thinking', {}, locale),
    toolCleanup: { 'group-ended': t('terminal.render.toolCleanup.groupEnded', {}, locale), unverified: t('terminal.render.toolCleanup.unverified', {}, locale) },
    waiting: { model: t('terminal.render.waiting.model', {}, locale), compaction: t('terminal.render.waiting.compaction', {}, locale) },
    cancelledDuring: { compaction: t('terminal.render.cancelledDuring.compaction', {}, locale), model: t('terminal.render.cancelledDuring.model', {}, locale),
      tool: t('terminal.render.cancelledDuring.tool', {}, locale) },
    compactionCancelled: t('terminal.render.compactionCancelled', {}, locale),
    providerRejection: { 'credential-rejected': t('terminal.render.providerRejection.credentialRejected', {}, locale),
      'access-denied': t('terminal.render.providerRejection.accessDenied', {}, locale), 'spend-limit': t('terminal.render.providerRejection.spendLimit', {}, locale),
      'rate-limit': t('terminal.render.providerRejection.rateLimit', {}, locale), 'limit-reached': t('terminal.render.providerRejection.limitReached', {}, locale) },
    cancelHint: t('terminal.render.cancelHint', {}, locale),
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
    toolDeclined: t('terminal.render.toolStatus.declined', {}, locale),
  };
}

/** Catalog strings of the composer (terminal.composer.*) and the slash popup (terminal.slash.*). */
export function terminalComposerLabels(locale: Locale): ComposerLabels {
  // Registry descriptions/hints contain no interpolation, matching the CLI help catalog lookup.
  const catalog = MESSAGE_REGISTRY.catalogs[locale === 'tr' ? 'tr' : 'en'];
  return { pasteChip: t('terminal.composer.pasteChip', {}, locale), search: t('terminal.composer.search', {}, locale),
    exitArmed: t('terminal.composer.exitArmed', {}, locale), shortcuts: t('terminal.composer.shortcuts', {}, locale),
    placeholder: t('terminal.workline.placeholder', {}, locale),
    slash: Object.fromEntries([...WORKLINE_SLASH_COMMANDS.flatMap(command => [command.descriptionKey, ...(command.argumentKey ? [command.argumentKey] : [])]), ...SLASH_GROUPS.map(group => group.labelKey), SLASH_HELP_TITLE_KEY]
      .map(key => [key, catalog[key] ?? key])) };
}

/** Catalog strings of `/resume`, `/context` and `/clear` (terminal.session.*). */
export function terminalSessionLabels(locale: Locale): ConversationSessionLabels {
  return { locale, entry: t('terminal.session.entry', {}, locale), hiddenCount: t('terminal.safety.hiddenCount', {}, locale), none: t('terminal.session.none', {}, locale), notFound: t('terminal.session.notFound', {}, locale),
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
