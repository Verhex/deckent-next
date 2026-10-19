import { t, type Locale } from '#platform/index.js';
import type { ConfigApplication, ConfigFieldView } from '#engine/index.js';
import { renderCliTable, type CliTableStyle } from '#surfaces/core/cli-human/index.js';
import { configValueWord, sourceWord, applyWord } from './render.js';
import type { configPanelPort } from './panel.js';

type ConfigInspection = Awaited<ReturnType<ConfigApplication['inspect']>>;
/** The `/config` window's port (one implementation for the terminal and `deckent config`). */
export type ConfigPanelPortView = ReturnType<typeof configPanelPort>;
/**
 * C-SETUP: opens the terminal's own `/config` window (terminal-panels `ConfigPanel`) on the person's terminal and resolves with the lines the
 * window left (its one-line summaries; an approval it opened). Bound by trusted composition after the TTY decision; the view loads lazily
 * there, so the CLI start never reaches Ink. Absent: `deckent config` stays the plain summary.
 */
export type ConfigPanelOpener = (port: ConfigPanelPortView, io: Readonly<{ stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream; env: NodeJS.ProcessEnv;
  locale: Locale; signal?: AbortSignal }>) => Promise<readonly string[]>;

const section = (key: string) => key.split('.')[0]!;

/**
 * Bare `deckent config` off a terminal (owner 2026-10-19): only the values that differ from the defaults (layer, environment), how many
 * groups and keys there are, and where the full view is. The full dump stays behind `config get --json`.
 */
export function renderConfigOverrides(view: ConfigInspection, locale: Locale, style: CliTableStyle): string {
  const project = view.fields.find(field => field.key === 'projectName')?.value;
  const overridden = view.fields.filter(field => field.source !== 'default');
  const groups = new Set(view.fields.map(field => section(field.key))).size;
  const lines = [t('config.surface.title', { project: typeof project === 'string' ? project : '-' }, locale)];
  if (overridden.length) {
    lines.push(t('clisetup.config.overrides', { count: overridden.length }, locale), renderCliTable(columns(locale),
      overridden.map(field => [field.key, configValueWord(field.value, field.redacted, locale), sourceWord(field.source, locale), applyWord(field.apply, locale)]), style));
  } else lines.push(t('clisetup.config.noOverrides', {}, locale));
  lines.push('', t('clisetup.config.groups', { groups, keys: view.fields.length }, locale), t('clisetup.config.everything', {}, locale));
  return lines.join('\n');
}
const columns = (locale: Locale) => t('clisetup.config.columns', {}, locale).split('|').map((header, index) => ({ header, shrink: index === 1 }));

/** Leaf rows of a displayed configuration (already redacted) under `prefix`: `key · value`, arrays and objects flattened to their leaves. */
export function configLeafRows(value: unknown, prefix: string): [string, string][] {
  if (Array.isArray(value)) return value.length ? value.flatMap((item, index) => configLeafRows(item, `${prefix}.${index}`)) : [[prefix, '[]']];
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length ? entries.flatMap(([name, child]) => configLeafRows(child, prefix ? `${prefix}.${name}` : name)) : [[prefix, '{}']];
  }
  return [[prefix, typeof value === 'string' ? value : JSON.stringify(value) ?? '-']];
}
/** `config get [group]` for a person: one row per leaf, cut to the terminal width (a pipe keeps whole values), and where the full value is. */
export function renderConfigLeaves(value: unknown, prefix: string, locale: Locale, style: CliTableStyle): string {
  const rows = configLeafRows(value, prefix);
  const [key, shown] = t('clisetup.config.leafColumns', {}, locale).split('|');
  return [renderCliTable([{ header: key! }, { header: shown!, shrink: true }], rows, style),
    ...(Number.isFinite(style.width) ? [t('clisetup.config.fullValue', {}, locale)] : [])].join('\n');
}

/** Bare `config explain`: every key by group with what it is, so a person finds the key to explain. */
export function renderConfigKeyList(fields: readonly ConfigFieldView[], describe: (field: ConfigFieldView) => string, locale: Locale, style: CliTableStyle): string {
  const [key, about] = t('clisetup.config.keyColumns', {}, locale).split('|');
  return [renderCliTable([{ header: key! }, { header: about!, shrink: true }], fields.map(field => [field.key, describe(field)]), style),
    t('clisetup.config.explainNext', {}, locale)].join('\n');
}

/** The allowed values of one key, in words, for `config set <key>` called without a value off a terminal (the refusal names them). */
export function configChoiceWords(choices: readonly Readonly<{ label: string; blocked?: string }>[], expected: string, locale: Locale): string {
  const open = choices.filter(choice => !choice.blocked).map(choice => choice.label);
  return open.length ? open.join(', ') : t('clisetup.config.expected', { expected }, locale);
}

/** The window narrowed to one key (`config set <key>` on a terminal): the same component and write port, with only that key listed. */
export function narrowConfigPanel(port: ConfigPanelPortView, keyPath: string): ConfigPanelPortView {
  return { ...port, async inspect() { const view = await port.inspect(); return { ...view, fields: view.fields.filter(field => field.key === keyPath) }; } };
}
