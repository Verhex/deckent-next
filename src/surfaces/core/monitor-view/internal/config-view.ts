import { t, type Locale } from '#platform/index.js';
import type { ConfigApplication } from '#engine/index.js';
import { renderConfigExplanation, renderConfigInspection, configValueWord } from '#surfaces/core/config/index.js';
import { span, type MonitorBlock } from './layout.js';
export type ConfigMonitorInspection = Awaited<ReturnType<ConfigApplication['inspect']>>;
/** Current project's config only; read projection carries the same source/binding/apply information as CLI and terminal. */
export function configMonitorBlocks(view: ConfigMonitorInspection, locale: Locale): readonly MonitorBlock[] {
  const headings = t('config.surface.columns', {}, locale).split('|');
  return [{ kind: 'line', line: [span(t('config.surface.title', { project: String(view.fields.find(field => field.key === 'projectName')?.value ?? '-') }, locale), 'strong')] },
    { kind: 'table', columns: headings.map((header, i) => ({ header, priority: i, min: i ? 7 : 20, max: i ? 18 : 40 })), empty: '-',
      rows: view.fields.map(field => {
        const rendered = renderConfigInspection({ ...view, fields: [field] }, locale, 80).split('\n').at(-1) ?? '';
        const source = { default: t('config.surface.source.default', {}, locale), global: t('config.surface.source.global', {}, locale), project: t('config.surface.source.project', {}, locale), env: t('config.surface.source.env', {}, locale) }[field.source];
        return { key: `config:${field.key}`, cells: [span(field.key), span(configValueWord(field.value, field.redacted, locale)),
          span(source), span(field.binding.state === 'bound' ? t('config.surface.bound', {}, locale) : t('config.surface.declared', {}, locale)),
          span(field.apply === 'live' ? t('config.surface.live', {}, locale) : t('config.surface.restart', {}, locale))], sort: { name: field.key }, signature: rendered,
          detail: () => renderConfigExplanation(field, locale).split('\n').map(line => [span(line)]) };
      }) }];
}
