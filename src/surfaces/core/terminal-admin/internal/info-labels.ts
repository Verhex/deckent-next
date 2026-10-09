import { t, type Locale } from '#platform/index.js';
import type { InfoSurfaceLabels } from '#surfaces/core/terminal-window/index.js';

/** Every word the terminal's information windows take from the catalog (`terminal.info.*`), in one locale. */
export function terminalInfoLabels(locale: Locale): InfoSurfaceLabels {
  return { hints: t('terminal.info.hints', {}, locale), pickHints: t('terminal.info.pickHints', {}, locale), position: t('terminal.info.position', {}, locale), systemLabel: t('terminal.info.systemLabel', {}, locale),
    help: { note: t('terminal.info.help.note', {}, locale), summary: t('terminal.info.help.summary', {}, locale) },
    context: { locale, title: t('terminal.info.context.title', {}, locale),
      section: { window: t('terminal.info.context.section.window', {}, locale), split: t('terminal.info.context.section.split', {}, locale), summaries: t('terminal.info.context.section.summaries', {}, locale),
        suggestion: t('terminal.info.context.section.suggestion', {}, locale) },
      key: { fill: t('terminal.info.context.key.fill', {}, locale), used: t('terminal.info.context.key.used', {}, locale), auto: t('terminal.info.context.key.auto', {}, locale), messages: t('terminal.info.context.key.messages', {}, locale),
        count: t('terminal.info.context.key.count', {}, locale), last: t('terminal.info.context.key.last', {}, locale), largest: t('terminal.info.context.key.largest', {}, locale) },
      used: t('terminal.info.context.used', {}, locale), auto: t('terminal.info.context.auto', {}, locale), last: t('terminal.info.context.last', {}, locale), notMeasured: t('terminal.info.context.notMeasured', {}, locale),
      column: { part: t('terminal.info.context.column.part', {}, locale), share: t('terminal.info.context.column.share', {}, locale) },
      part: { system: t('terminal.info.context.part.system', {}, locale), user: t('terminal.info.context.part.user', {}, locale), assistant: t('terminal.info.context.part.assistant', {}, locale),
        tools: t('terminal.info.context.part.tools', {}, locale), attachments: t('terminal.info.context.part.attachments', {}, locale) },
      splitNote: t('terminal.info.context.splitNote', {}, locale), chip: { room: t('terminal.info.context.chip.room', {}, locale), filling: t('terminal.info.context.chip.filling', {}, locale) },
      summary: t('terminal.info.context.summary', {}, locale), summaryNone: t('terminal.info.context.summaryNone', {}, locale) } };
}
