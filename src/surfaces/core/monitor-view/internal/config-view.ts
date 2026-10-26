import { t, type Locale } from '#platform/index.js';
import type { ConfigApplication } from '#engine/index.js';
import { renderConfigExplanation, renderConfigInspection, configValueWord } from '#surfaces/core/config/index.js';
import { span, type MonitorBlock, type MonitorColumn, type MonitorRow } from './layout.js';
export type ConfigMonitorInspection = Awaited<ReturnType<ConfigApplication['inspect']>>;
type Field = ConfigMonitorInspection['fields'][number];
type Section = 'general' | 'work' | 'service' | 'security' | 'storage' | 'interface';
const SECTIONS: readonly Section[] = ['general', 'work', 'service', 'security', 'storage', 'interface'];
export interface ConfigViewOptions { readonly all: boolean; readonly warn: string }

/** Reading order and short human name of every top-level config field (PB-MON-UX); a field added later sorts last under its own key. */
function fieldWords(locale: Locale): Readonly<Record<string, readonly [Section, string]>> {
  return {
    projectName: ['general', t('monitor.config.name.projectName', {}, locale)], language: ['general', t('monitor.config.name.language', {}, locale)],
    output_mode: ['general', t('monitor.config.name.output_mode', {}, locale)], company: ['general', t('monitor.config.name.company', {}, locale)],
    schema_version: ['general', t('monitor.config.name.schema_version', {}, locale)],
    max_workers: ['work', t('monitor.config.name.max_workers', {}, locale)], admission: ['work', t('monitor.config.name.admission', {}, locale)],
    execution: ['work', t('monitor.config.name.execution', {}, locale)], targetQueue: ['work', t('monitor.config.name.targetQueue', {}, locale)],
    runRuntime: ['work', t('monitor.config.name.runRuntime', {}, locale)], toolchains: ['work', t('monitor.config.name.toolchains', {}, locale)],
    models: ['work', t('monitor.config.name.models', {}, locale)], // C-MODELS: models.retirementWarningDays
    resourceObservation: ['work', t('monitor.config.name.resourceObservation', {}, locale)], artifacts: ['work', t('monitor.config.name.artifacts', {}, locale)],
    memoryAutomation: ['work', t('monitor.config.name.memoryAutomation', {}, locale)], // S4B-1: extraction / verification / context switches
    catalogEvolution: ['work', t('agentstats.config.name', {}, locale)], // S8-2: the protected catalog aggregator switch and registry overlay
    service: ['service', t('monitor.config.name.service', {}, locale)], cancellation: ['service', t('monitor.config.name.cancellation', {}, locale)],
    cancellationRuntime: ['service', t('monitor.config.name.cancellationRuntime', {}, locale)],
    reconciliationRuntime: ['service', t('monitor.config.name.reconciliationRuntime', {}, locale)],
    approvals: ['security', t('monitor.config.name.approvals', {}, locale)], audit: ['security', t('monitor.config.name.audit', {}, locale)],
    enforce_principal_assurance: ['security', t('monitor.config.name.enforce_principal_assurance', {}, locale)],
    policy: ['security', t('monitor.config.name.policy', {}, locale)], // alpha.56 U5-S2: protected policy availability (MCP opt-in groups)
    layout: ['storage', t('monitor.config.name.layout', {}, locale)], storage: ['storage', t('monitor.config.name.storage', {}, locale)],
    backup: ['storage', t('monitor.config.name.backup', {}, locale)], configFile: ['storage', t('monitor.config.name.configFile', {}, locale)],
    installation: ['storage', t('monitor.config.name.installation', {}, locale)],
    cli: ['interface', t('monitor.config.name.cli', {}, locale)], mcp: ['interface', t('monitor.config.name.mcp', {}, locale)],
    inspection: ['interface', t('monitor.config.name.inspection', {}, locale)],
  };
}
/** The config field keys this view names (tests prove every declared field has a section and a name). */
export const configMonitorFieldKeys = (): readonly string[] => Object.keys(fieldWords('en'));

const col = (header: string, priority: number, min: number, max: number): MonitorColumn => ({ header, priority, min, max });
/**
 * The monitor's Config tab (PB-MON-UX): the current project's settings under the human name of their section (the top-level field: `inspection`
 * → "Inspection and monitor"), sections in a fixed reading order, each row showing its full key. By default only settings that differ from the
 * default (any non-default source); `all` shows every setting. A setting declared but read by no component is flagged. Rows and details come
 * from the same `inspect` truth as the CLI and terminal `/config`.
 */
export function configMonitorBlocks(view: ConfigMonitorInspection, locale: Locale, options: ConfigViewOptions = { all: false, warn: '!' }): readonly MonitorBlock[] {
  const words = fieldWords(locale), top = (field: Field) => field.key.split('.')[0]!;
  const order = (field: Field) => { const known = words[top(field)]; return known ? SECTIONS.indexOf(known[0]) : SECTIONS.length; };
  // A section a later field adds without a name here still gets its own heading: its key.
  const heading = (field: Field) => words[top(field)]?.[1] ?? top(field);
  const changed = view.fields.filter(field => field.source !== 'default'), shown = options.all ? view.fields : changed;
  const unread = view.fields.filter(field => field.binding.state !== 'bound').length;
  const source = (field: Field) => ({ default: t('monitor.config.source.default', {}, locale), global: t('monitor.config.source.global', {}, locale),
    project: t('monitor.config.source.project', {}, locale), env: t('monitor.config.source.env', {}, locale) })[field.source];
  const ordered = [...shown].sort((a, b) => order(a) - order(b) || top(a).localeCompare(top(b)) || a.key.localeCompare(b.key));
  const sections = new Map(view.fields.map(field => [`config:${field.key}`, heading(field)]));
  const rows = ordered.map((field): MonitorRow => {
    const rendered = renderConfigInspection({ ...view, fields: [field] }, locale, 80).split('\n').at(-1) ?? '';
    const bound = field.binding.state === 'bound';
    return { key: `config:${field.key}`, cells: [span(field.key === top(field) && words[field.key] ? `${words[field.key]![1]} (${field.key})` : field.key, bound ? undefined : 'warning'),
      span(configValueWord(field.value, field.redacted, locale), field.source === 'default' ? 'muted' : undefined), span(source(field), 'muted'),
      bound ? span(field.apply === 'live' ? t('monitor.config.apply.live', {}, locale) : t('monitor.config.apply.restart', {}, locale))
        : span(`${options.warn} ${t('monitor.config.unreadFlag', {}, locale)}`, 'warning')],
    facets: { kind: heading(field).toLowerCase() }, sort: { name: field.key }, signature: rendered,
    detail: () => renderConfigExplanation(field, locale).split('\n').map(line => [span(line)]) };
  });
  return [
    { kind: 'line', line: [span(t('monitor.config.title', { project: String(view.fields.find(field => field.key === 'projectName')?.value ?? '-') }, locale), 'sectionHeader')] },
    { kind: 'line', line: [span(options.all ? t('monitor.config.all', { total: view.fields.length }, locale)
      : t('monitor.config.changed', { shown: changed.length, total: view.fields.length }, locale), 'muted')] },
    ...(unread ? [{ kind: 'line' as const, line: [span(`${options.warn} ${t('monitor.config.unread', { count: unread }, locale)}`, 'warning')] }] : []),
    { kind: 'table', empty: t('monitor.config.none', {}, locale), group: row => sections.get(row.key) ?? '',
      columns: [col(t('monitor.config.col.setting', {}, locale), 0, 20, 44), col(t('monitor.config.col.value', {}, locale), 1, 8, 36),
        col(t('monitor.config.col.source', {}, locale), 3, 7, 18), col(t('monitor.config.col.apply', {}, locale), 2, 8, 20)], rows },
  ];
}
