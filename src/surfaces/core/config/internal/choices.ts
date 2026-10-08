import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_VALUE_CHOICES, configChoiceDeclaration, configEntryAllowed, configNumberText, configStepper, type ConfigChoiceSource, type ConfigStepper } from '#platform/index.js';
import { t, type Locale } from '#platform/index.js';
import type { ConfigFieldView } from '#engine/index.js';
import { configValueWord } from './render.js';

export type ConfigValueChoice = Readonly<{ id: string; label: string; value: unknown; detail?: string }>;
/** Read-only, principal-scoped reference discovery. Implementations belong to trusted composition. */
export interface ConfigChoiceSourcePort {
  list(source: ConfigChoiceSource, keyPath: string): Promise<readonly ConfigValueChoice[]>;
}
export type ConfigValueModel = Readonly<{ choices: readonly ConfigValueChoice[]; free: boolean; hidden: boolean; readOnly: string | null;
  stepper: ConfigStepper | null; generated: boolean; notice: string | null }>;
export function configSchemaChoices(schema: unknown): readonly unknown[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s['enum'])) return s['enum'];
  if (Object.hasOwn(s, 'const')) return [s['const']];
  if (s['type'] === 'boolean') return [true, false];
  if (s['type'] === 'null') return [null];
  const options = s['anyOf'] ?? s['oneOf'];
  return Array.isArray(options) ? options.flatMap(configSchemaChoices) : [];
}
export async function configValueModel(field: ConfigFieldView, root: string, locale: Locale, sources?: ConfigChoiceSourcePort): Promise<ConfigValueModel> {
  const declaration = configChoiceDeclaration(field.key), closed = configSchemaChoices(field.schema);
  const stepper = configStepper(field.schema, declaration, field.value), generated = declaration?.kind === 'generated';
  const documentChild = Object.entries(CONFIG_VALUE_CHOICES).some(([parent, rule]) => rule.kind === 'document' && field.key.startsWith(parent + '.') && declaration?.kind === 'document');
  const hidden = documentChild || declaration?.kind === 'hidden' || declaration?.kind === 'schema' && closed.length === 1;
  const readOnly = (declaration?.kind === 'document' || declaration?.kind === 'container') && !closed.includes(null) || !declaration && !configEntryAllowed(field.key, field.redacted) ? t('config.select.document', {}, locale) : null;
  let sourceState: string | null = null;
  let values: readonly ConfigValueChoice[] = closed.map((value, index) => ({ id: String(index), value,
    label: value === null ? (field.key === 'service.idleShutdown.afterMs' ? t('config.select.never', {}, locale) : t('config.select.none', {}, locale)) : configValueWord(value, false, locale) }));
  if (stepper && declaration?.kind === 'numeric') {
    const presets = [...new Set([...declaration.presets, ...(typeof field.defaultValue === 'number' ? [field.defaultValue] : []), stepper.current])]
      .filter(n => n >= stepper.min && n <= stepper.max);
    values = [...values, ...presets.map((value, index) => ({ id: `n${index}`, value, label: configNumberText(value, stepper.unit) }))];
  }
  if (declaration?.kind === 'reference') {
    let discovered: readonly ConfigValueChoice[] = [];
    try { discovered = declaration.source === 'project-names' ? [...new Set([basename(root), basename(root).replace(/[._-]+/gu, ' ')])].map((value, index) => ({ id: `p${index}`, value, label: value }))
      : await sources?.list(declaration.source, field.key) ?? [];
    } catch { sourceState = t('config.select.unavailable', {}, locale); }
    if (!discovered.length) sourceState ??= t('config.select.empty', {}, locale);
    values = [...values, ...discovered];
    if (declaration.multiple) values = arrayChoices(values, field.value, locale);
  }
  if (declaration?.kind === 'entry') {
    values = declaration.presets.map((value, index) => ({ id: `e${index}`, value, label: value }));
    if (declaration.multiple) values = arrayChoices(values, field.value, locale);
  }
  if (generated) { const value = `${basename(root).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 64)}-${randomUUID()}`; values = [{ id: 'generated', value, label: t('config.select.generated', {}, locale), detail: value }]; }
  return { choices: field.redacted ? [] : values, free: configEntryAllowed(field.key, field.redacted), hidden, readOnly: readOnly ?? (sourceState && values.length === 0 ? sourceState : null), stepper, generated, notice: sourceState };
}
function arrayChoices(choices: readonly ConfigValueChoice[], current: unknown, locale: Locale): ConfigValueChoice[] {
  const selected = Array.isArray(current) ? current : [];
  const merged = [...choices];
  for (const item of selected) if (typeof item === 'string' && !merged.some(choice => choice.value === item)) merged.push({ id: `kept${merged.length}`, label: item, value: item });
  return [{ id: 'empty', label: t('config.select.none', {}, locale), value: [] }, ...merged.map(choice => {
    const has = selected.includes(choice.value);
    return { ...choice, label: (has ? t('config.select.remove', { label: choice.label }, locale) : t('config.select.add', { label: choice.label }, locale)), value: has ? selected.filter(item => item !== choice.value) : [...selected, choice.value] };
  })];
}
