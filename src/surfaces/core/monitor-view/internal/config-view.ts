import { t, type Locale } from '#platform/index.js';
import type { ConfigApplication } from '#engine/index.js';
import { renderConfigExplanation, renderConfigInspection, configValueWord } from '#surfaces/core/config/index.js';
import { span, type MonitorBlock, type MonitorColumn, type MonitorRow } from './layout.js';
export type ConfigMonitorInspection = Awaited<ReturnType<ConfigApplication['inspect']>>;
type Field = ConfigMonitorInspection['fields'][number];
type Section = 'general' | 'work' | 'service' | 'security' | 'storage' | 'interface' | 'other';
const SECTIONS: readonly Section[] = ['general', 'work', 'service', 'security', 'storage', 'interface', 'other'];
export interface ConfigViewOptions { readonly all: boolean; readonly warn: string }

/** Section and short human name of every config field the monitor knows (PB-MON-UX); a field added later shows under "other" with its description. */
function fieldWords(locale: Locale): Readonly<Record<string, readonly [Section, string]>> {
  return {
    projectName: ['general', t('monitor.config.name.projectName', {}, locale)], language: ['general', t('monitor.config.name.language', {}, locale)],
    output_mode: ['general', t('monitor.config.name.output_mode', {}, locale)], company: ['general', t('monitor.config.name.company', {}, locale)],
    schema_version: ['general', t('monitor.config.name.schema_version', {}, locale)],
    max_workers: ['work', t('monitor.config.name.max_workers', {}, locale)], admission: ['work', t('monitor.config.name.admission', {}, locale)],
    execution: ['work', t('monitor.config.name.execution', {}, locale)], targetQueue: ['work', t('monitor.config.name.targetQueue', {}, locale)],
    runRuntime: ['work', t('monitor.config.name.runRuntime', {}, locale)], toolchains: ['work', t('monitor.config.name.toolchains', {}, locale)],
    resourceObservation: ['work', t('monitor.config.name.resourceObservation', {}, locale)], artifacts: ['work', t('monitor.config.name.artifacts', {}, locale)],
    service: ['service', t('monitor.config.name.service', {}, locale)], cancellation: ['service', t('monitor.config.name.cancellation', {}, locale)],
    cancellationRuntime: ['service', t('monitor.config.name.cancellationRuntime', {}, locale)],
    reconciliationRuntime: ['service', t('monitor.config.name.reconciliationRuntime', {}, locale)],
    approvals: ['security', t('monitor.config.name.approvals', {}, locale)], audit: ['security', t('monitor.config.name.audit', {}, locale)],
    enforce_principal_assurance: ['security', t('monitor.config.name.enforce_principal_assurance', {}, locale)],
    layout: ['storage', t('monitor.config.name.layout', {}, locale)], storage: ['storage', t('monitor.config.name.storage', {}, locale)],
    backup: ['storage', t('monitor.config.name.backup', {}, locale)], configFile: ['storage', t('monitor.config.name.configFile', {}, locale)],
    installation: ['storage', t('monitor.config.name.installation', {}, locale)],
    cli: ['interface', t('monitor.config.name.cli', {}, locale)], mcp: ['interface', t('monitor.config.name.mcp', {}, locale)],
    inspection: ['interface', t('monitor.config.name.inspection', {}, locale)],
  };
}
function sectionName(section: Section, locale: Locale): string {
  const names: Record<Section, string> = { general: t('monitor.config.section.general', {}, locale), work: t('monitor.config.section.work', {}, locale),
    service: t('monitor.config.section.service', {}, locale), security: t('monitor.config.section.security', {}, locale), storage: t('monitor.config.section.storage', {}, locale),
    interface: t('monitor.config.section.interface', {}, locale), other: t('monitor.config.section.other', {}, locale) };
  return names[section];
}
/** The config field keys this view names (tests prove every declared field has a section and a name). */
export const configMonitorFieldKeys = (): readonly string[] => Object.keys(fieldWords('en'));

const col = (header: string, priority: number, min: number, max: number): MonitorColumn => ({ header, priority, min, max });
/**
 * The monitor's Config tab (PB-MON-UX): the current project's settings grouped into named sections, each row a human name with its key.
 * By default only settings that differ from the default (any non-default source); `all` shows every setting. A setting declared but read by
 * no component is flagged. Rows and details come from the same `inspect` truth as the CLI and terminal `/config`.
 */
export function configMonitorBlocks(view: ConfigMonitorInspection, locale: Locale, options: ConfigViewOptions = { all: false, warn: '!' }): readonly MonitorBlock[] {
  const words = fieldWords(locale), sectionOf = (field: Field): Section => words[field.key]?.[0] ?? 'other';
  const changed = view.fields.filter(field => field.source !== 'default'), shown = options.all ? view.fields : changed;
  const unread = view.fields.filter(field => field.binding.state !== 'bound').length;
  const source = (field: Field) => ({ default: t('monitor.config.source.default', {}, locale), global: t('monitor.config.source.global', {}, locale),
    project: t('monitor.config.source.project', {}, locale), env: t('monitor.config.source.env', {}, locale) })[field.source];
  const ordered = [...shown].sort((a, b) => SECTIONS.indexOf(sectionOf(a)) - SECTIONS.indexOf(sectionOf(b)) || a.key.localeCompare(b.key));
  const sections = new Map(view.fields.map(field => [`config:${field.key}`, sectionName(sectionOf(field), locale)]));
  const rows = ordered.map((field): MonitorRow => {
    const rendered = renderConfigInspection({ ...view, fields: [field] }, locale, 80).split('\n').at(-1) ?? '';
    const bound = field.binding.state === 'bound';
    return { key: `config:${field.key}`, cells: [span(`${words[field.key]?.[1] ?? field.description} (${field.key})`, bound ? undefined : 'warning'),
      span(configValueWord(field.value, field.redacted, locale), field.source === 'default' ? 'muted' : undefined), span(source(field), 'muted'),
      bound ? span(field.apply === 'live' ? t('monitor.config.apply.live', {}, locale) : t('monitor.config.apply.restart', {}, locale))
        : span(`${options.warn} ${t('monitor.config.unreadFlag', {}, locale)}`, 'warning')],
    facets: { kind: sections.get(`config:${field.key}`)!.toLowerCase() }, sort: { name: field.key }, signature: rendered,
    detail: () => renderConfigExplanation(field, locale).split('\n').map(line => [span(line)]) };
  });
  return [
    { kind: 'line', line: [span(t('monitor.config.title', { project: String(view.fields.find(field => field.key === 'projectName')?.value ?? '-') }, locale), 'sectionHeader')] },
    { kind: 'line', line: [span(options.all ? t('monitor.config.all', { total: view.fields.length }, locale)
      : t('monitor.config.changed', { shown: changed.length, total: view.fields.length }, locale), 'muted')] },
    ...(unread ? [{ kind: 'line' as const, line: [span(`${options.warn} ${t('monitor.config.unread', { count: unread }, locale)}`, 'warning')] }] : []),
    { kind: 'table', empty: t('monitor.config.none', {}, locale), group: row => sections.get(row.key) ?? '',
      columns: [col(t('monitor.config.col.setting', {}, locale), 0, 20, 56), col(t('monitor.config.col.value', {}, locale), 1, 8, 40),
        col(t('monitor.config.col.source', {}, locale), 3, 7, 18), col(t('monitor.config.col.apply', {}, locale), 2, 8, 20)], rows },
  ];
}
