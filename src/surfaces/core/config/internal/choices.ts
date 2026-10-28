import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_VALUE_CHOICES, configChoiceDeclaration, configEntryAllowed, configNumberText, configStepper, type ConfigChoiceSource, type ConfigStepper } from '#platform/index.js';
import { t, type Locale } from '#platform/index.js';
import type { ConfigFieldView } from '#engine/index.js';
import { configValueWord } from './render.js';

export type ConfigValueChoice = Readonly<{ id: string; label: string; value: unknown; detail?: string; blocked?: string }>;
/** What cut a source's discovery short: its time limit, or a size bound with entries left unread. */
export type ConfigChoiceCut = 'time' | 'size';
/** A source's choices; `partial` names the cut when one ended the discovery early (the ones found are still offered). Still an array for list readers. */
export interface ConfigChoiceList extends ReadonlyArray<ConfigValueChoice> { readonly partial?: ConfigChoiceCut | false }
/** Read-only, principal-scoped reference discovery. Implementations belong to trusted composition. */
export interface ConfigChoiceSourcePort {
  list(source: ConfigChoiceSource, keyPath: string, context?: Readonly<{ path: string }>): Promise<ConfigChoiceList>;
  browse?(directory: string): Promise<readonly import('./records.js').ConfigFileChoice[]>;
  readDocument?(path: string): Promise<unknown>;
  /** BeUser D-03: refuses a work target the work path would refuse (typed WORK_TARGET_*), before the record is written. */
  /** Refuses an unusable target; BeUser DR2-05/06: reports the open results a move of the work source strands (`now`) and the queue's refusal of the chosen branch. */
  checkWorkTarget?(workTargets: unknown): Promise<Readonly<{ open?: number; now?: string; branch?: Readonly<Record<string, string>> }> | null | void>;
}
export type ConfigValueModel = Readonly<{ choices: readonly ConfigValueChoice[]; free: boolean; hidden: boolean; readOnly: string | null;
  stepper: ConfigStepper | null; generated: boolean; notice: string | null; partial: Readonly<{ reason: ConfigChoiceCut; found: number }> | null }>;
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
  let sourceState: string | null = null, partial: ConfigValueModel['partial'] = null;
  let values: readonly ConfigValueChoice[] = closed.map((value, index) => ({ id: String(index), value,
    label: value === null ? (field.key === 'service.idleShutdown.afterMs' ? t('config.select.never', {}, locale) : t('config.select.none', {}, locale)) : configValueWord(value, false, locale) }));
  if (stepper && declaration?.kind === 'numeric') {
    const presets = [...new Set([...declaration.presets, ...(typeof field.defaultValue === 'number' ? [field.defaultValue] : []), stepper.current])]
      .filter(n => n >= stepper.min && n <= stepper.max);
    values = [...values, ...presets.map((value, index) => ({ id: `n${index}`, value, label: configNumberText(value, stepper.unit) }))];
  }
  if (declaration?.kind === 'reference') {
    let discovered: ConfigChoiceList = [];
    try { discovered = declaration.source === 'project-names' ? [...new Set([basename(root), basename(root).replace(/[._-]+/gu, ' ')])].map((value, index) => ({ id: `p${index}`, value, label: value }))
      : await sources?.list(declaration.source, field.key) ?? [];
    } catch (error) {
      // J2d: no installation in this folder is "nothing to offer" (as before J2d), not an unavailable source.
      if ((error as { code?: unknown } | null)?.code !== 'CLI_INSTALLATION_MISSING') sourceState = t('config.select.unavailable', {}, locale);
    }
    // CONFIG-PARTIAL-NOTICE/-CLI: a list cut short (time limit or size bound) says which, with how to set a value it did not reach; the cut stays data.
    if (discovered.partial) partial = { reason: discovered.partial, found: discovered.length };
    if (discovered.partial === 'time') sourceState ??= discovered.length ? t('config.select.partial', { count: discovered.length, key: field.key }, locale) : t('config.select.partialNone', { key: field.key }, locale);
    if (discovered.partial === 'size') sourceState ??= discovered.length ? t('config.select.partialSize', { count: discovered.length, key: field.key }, locale) : t('config.select.partialSizeNone', { key: field.key }, locale);
    if (!discovered.length) sourceState ??= t('config.select.empty', {}, locale);
    values = [...values, ...discovered];
    if (declaration.multiple) values = arrayChoices(values, field.value, locale);
  }
  if (declaration?.kind === 'entry') {
    values = declaration.presets.map((value, index) => ({ id: `e${index}`, value, label: value }));
    if (declaration.multiple) values = arrayChoices(values, field.value, locale);
  }
  if (generated) { const value = `${basename(root).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 64)}-${randomUUID()}`; values = [{ id: 'generated', value, label: t('config.select.generated', {}, locale), detail: value }]; }
  return { choices: field.redacted ? [] : values, free: configEntryAllowed(field.key, field.redacted), hidden, readOnly: readOnly ?? (sourceState && values.length === 0 ? sourceState : null), stepper, generated, notice: sourceState, partial };
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
