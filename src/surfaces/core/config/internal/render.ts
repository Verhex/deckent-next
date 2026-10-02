import { t, terminalSafeText, MESSAGE_REGISTRY, type Locale } from '#platform/index.js';
import { cells, wrapCells } from '#surfaces/core/terminal-render/index.js';
import type { ConfigApplication, ConfigFieldView } from '#engine/index.js';

type ConfigInspection = Awaited<ReturnType<ConfigApplication['inspect']>>;

export function sourceWord(source: ConfigFieldView['source'], locale: Locale): string {
  const words = { default: t('config.surface.source.default', {}, locale), global: t('config.surface.source.global', {}, locale),
    project: t('config.surface.source.project', {}, locale), env: t('config.surface.source.env', {}, locale) };
  return words[source];
}
export function applyWord(apply: ConfigFieldView['apply'], locale: Locale): string {
  return apply === 'live' ? t('config.surface.live', {}, locale) : t('config.surface.restart', {}, locale);
}
const bindingWord = (field: ConfigFieldView, locale: Locale) => field.binding.state === 'bound' ? t('config.surface.bound', {}, locale) : t('config.surface.declared', {}, locale);
export function configValueWord(value: unknown, redacted: boolean, locale: Locale): string {
  if (redacted) return t('config.surface.redacted', {}, locale);
  if (Array.isArray(value)) return t('config.surface.array', { count: value.length }, locale);
  if (value && typeof value === 'object') return t('config.surface.object', { count: Object.keys(value).length }, locale);
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '-';
}
function row(values: readonly string[], widths: readonly number[]): string[] {
  const parts = values.map((value, i) => wrapCells(value.replace(/[\r\n\t]/g, ' '), widths[i]!));
  return Array.from({ length: Math.max(...parts.map(cell => cell.length)) }, (_, at) => parts.map((cell, i) => {
    const value = cell[at] ?? ''; return value + ' '.repeat(Math.max(0, widths[i]! - cells(value)));
  }).join(' ').trimEnd());
}
/** Registry order/groups are authoritative; no second key list. Full keys wrap rather than disappear. */
export function renderConfigInspection(view: ConfigInspection, locale: Locale, width = 80): string {
  const bounded = Math.max(40, Math.min(80, width)), project = view.fields.find(field => field.key === 'projectName')?.value ?? '-';
  const lines = [t('config.surface.title', { project: String(project) }, locale),
    t('config.surface.digest', { layer: sourceWord(view.layer, locale), digest: view.digest ?? '-' }, locale)];
  const labels = t('config.surface.columns', {}, locale).split('|');
  const widths = bounded >= 70 ? [Math.max(20, bounded - 49), 17, 9, 8, 11] : [bounded - 29, 10, 6, 5, 4];
  let group = '';
  for (const field of view.fields) {
    const next = field.key.split('.')[0]!;
    if (next !== group) { group = next; lines.push('', `[${group}]`, ...row(labels, widths)); }
    lines.push(...row([field.key, configValueWord(field.value, field.redacted, locale), sourceWord(field.source, locale), bindingWord(field, locale), applyWord(field.apply, locale)], widths));
  }
  return lines.flatMap(line => wrapCells(terminalSafeText(line), bounded)).join('\n');
}
export function renderConfigExplanation(field: ConfigFieldView, locale: Locale, width = 80): string {
  const binding = field.binding.state === 'bound' ? `${bindingWord(field, locale)}: ${field.binding.consumers.join(', ')}`
    : `${bindingWord(field, locale)}: ${field.binding.reason}`;
  return t('config.surface.explain', { key: field.key, description: (MESSAGE_REGISTRY.catalogs[locale] as Readonly<Record<string, string>>)[field.descriptionKey] ?? field.description,
    value: configValueWord(field.value, field.redacted, locale), defaultValue: configValueWord(field.defaultValue, field.redacted, locale),
    source: sourceWord(field.source, locale), binding, apply: applyWord(field.apply, locale), schema: schemaWord(field.schema, locale) }, locale)
    .split('\n').flatMap(line => wrapCells(terminalSafeText(line), Math.max(40, Math.min(80, width)))).join('\n');
}

function schemaWord(schema: unknown, locale: Locale): string {
  if (!schema || typeof schema !== 'object') return '-';
  const value = schema as Record<string, unknown>;
  const options = value['anyOf'] ?? value['oneOf'];
  if (Array.isArray(options)) return options.map(option => schemaWord(option, locale)).join(' | ');
  const description = [String(value['type'] ?? '-')];
  if (Object.hasOwn(value, 'const')) description.push(String(value['const']));
  if (Array.isArray(value['enum'])) description.push(value['enum'].map(item => String(item)).join(', '));
  for (const key of ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'] as const) if (value[key] !== undefined) description.push(t('config.surface.schemaMinimum', { value: String(value[key]) }, locale));
  for (const key of ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'] as const) if (value[key] !== undefined) description.push(t('config.surface.schemaMaximum', { value: String(value[key]) }, locale));
  return description.join('; ');
}
