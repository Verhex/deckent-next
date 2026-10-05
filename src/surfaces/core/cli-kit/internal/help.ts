import { t, resolveLocale, LOCALES, MESSAGE_REGISTRY, type Locale, type MessageKey } from '#platform/index.js';
import { CLI_CATALOG, HELP_GROUPS, type CliCommandName, type CliCommandSpec, type CliInstallationContract } from './command-catalog.js';

interface CliHelpSpec extends CliCommandSpec {
  readonly path?: readonly string[];
  readonly parent?: CliHelpSpec;
}
export interface RegisteredCliCommand<C> extends CliHelpSpec {
  readonly path: readonly string[];
  readonly run: (argv: readonly string[], context: C) => Promise<void>;
}
/** Bind the one catalog to actual dispatch handlers. No second command/help inventory. */
export function registerCliCommands<C>(handlers: Readonly<Record<CliCommandName, RegisteredCliCommand<C>['run']>>): readonly RegisteredCliCommand<C>[] {
  const visit = (spec: CliCommandSpec, parent: RegisteredCliCommand<C> | undefined, run: RegisteredCliCommand<C>['run']): RegisteredCliCommand<C>[] => {
    const path = [...(parent?.path ?? []), spec.name];
    const entry = { ...spec, path, run, ...(parent ? { parent } : {}) };
    return [entry, ...(spec.children ?? []).flatMap(child => visit(child, entry, run))];
  };
  return CLI_CATALOG.flatMap(spec => visit(spec, undefined, handlers[spec.name]));
}

/** The installation contract of the deepest registered command naming argv's leading non-flag words (as the command parsers read positionals,
 * e.g. `policy --json vocabulary`), inherited from its family when undeclared. It only skips the preflight; the handler still validates argv. */
export function cliInstallationContract<C>(argv: readonly string[], commands: readonly RegisteredCliCommand<C>[]): CliInstallationContract | undefined {
  const words = argv.filter(value => !value.startsWith('-'));
  let command: CliHelpSpec | undefined = commands.reduce<RegisteredCliCommand<C> | undefined>((found, item) =>
    item.path.length > (found?.path.length ?? 0) && item.path.every((name, index) => words[index] === name) ? item : found, undefined);
  while (command && command.installation === undefined) command = command.parent;
  return command?.installation;
}

/** Catalog newlines are intentional boundaries; author flowing prose as one source line.
 * Keep syntax groups and inline commands whole; en/tr have no double-width glyphs. */
export function wrapHelp(text: string, width = 80): string {
  return text.split('\n').flatMap(line => {
    if ([...line].length <= width) return [line.trimEnd()];
    const indent = line.match(/^\s*/)?.[0] ?? '';
    const rows: string[][] = [[]];
    const length = (words: readonly string[]) => [...indent, ...words.join(' ')].length;
    const wordCount = (words: readonly string[]) => words.join(' ').trim().split(/[\s|]+/).length;
    for (const token of line.trim().match(/(?:\[[^\]]*\]|--[\w-]+ +<[^>]*>|<[^>]*>|`[^`]*`|\S)+/g) ?? []) {
      const current = rows.at(-1)!;
      if (current.length && length([...current, token]) > width) rows.push([token]);
      else current.push(token);
    }
    const last = rows.at(-1)!, previous = rows.at(-2);
    while (previous && wordCount(last) <= 3 && wordCount(previous.slice(0, -1)) > 3
      && length([previous.at(-1)!, ...last]) <= width) last.unshift(previous.pop()!);
    return rows.map(words => indent + words.join(' '));
  }).join('\n');
}

/** Catalog-owned messages contain no interpolation; their keys are validated in both locales. */
function message(key: MessageKey, locale: Locale): string { return MESSAGE_REGISTRY.catalogs[locale][key]!; }

export function renderTopHelp(locale: Locale = resolveLocale(), all = false, catalog: readonly CliCommandSpec[] = CLI_CATALOG): string {
  return [t('cli.help', { name: 'deckent' }, locale), ...HELP_GROUPS.flatMap(group => {
    const commands = catalog.filter(item => item.group === group);
    return !commands.length || (group === 'developer' && !all) ? [] : [message(`cli.help.group.${group}`, locale) + ':',
      ...commands.map(command => `  ${command.name.padEnd(12)}${message(command.summary, locale)}`)];
  }), t('cli.help.common', {}, locale), t('cli.help.examples', {}, locale), t('cli.help.details', {}, locale), t('cli.help.default', {}, locale)].join('\n');
}

export function renderCommandHelp(command: CliHelpSpec, locale: Locale): string {
  const examples = MESSAGE_REGISTRY.catalogs[locale][`${command.detail}.examples`];
  const family = command.parent;
  const overview = family ? [`deckent ${command.path!.join(' ')}`, message(command.summary, locale), '',
    t('cli.help.familySynopsis', { command: family.path!.join(' ') }, locale), message(family.summary, locale), ''] : [];
  return wrapHelp([...overview, message(command.detail, locale).replace(/ ?\[--(?:json|no-color|lang (?:en\|tr|<locale>))\]/g, '').replace(/\n +(?=\n)/g, ''), ...(family ? [] : ['', message(command.summary, locale)]),
    ...(command.children?.length ? [t('cli.help.heading.commands', {}, locale), ...command.children.map(child => `  ${child.name.padEnd(22)}${message(child.summary, locale)}`)] : []),
    '', t('cli.help.common', {}, locale), t('cli.help.output', {}, locale), ...(examples ? [examples] : [])].join('\n'));
}

/** Recognize only a help request. Extra execution flags still reach the unchanged parser. */
export async function cliHelpRequest<C>(argv: readonly string[], commands: readonly RegisteredCliCommand<C>[], env: NodeJS.ProcessEnv = process.env, readLanguage?: () => Promise<Locale | undefined>): Promise<{ output: string; locale: Locale } | null> {
  const helpAt = argv.findIndex(value => value === '--help' || value === '-h');
  if (helpAt < 0) return null;
  const path = argv.slice(0, helpAt), tail = argv.slice(helpAt + 1);
  let language: string | undefined, all = false;
  for (let index = 0; index < tail.length; index++) {
    if (tail[index] === '--all' && path.length === 0 && !all) all = true;
    else if (tail[index] === '--lang' && language === undefined && tail[index + 1] && !tail[index + 1]!.startsWith('-')) language = tail[++index];
    else return null;
  }
  const command = commands.find(item => item.path.join('\0') === path.join('\0'))
    // Preserve the existing run/task help-only fallback, including unknown action names.
    ?? (path.length === 2 && (path[0] === 'run' || path[0] === 'task') ? commands.find(item => item.path.length === 1 && item.name === path[0]) : undefined);
  if (path.length && !command) return null;
  // Explicit/environment choices need no disk read. Config failures must never hide help or heal an installation.
  const overridden = [language, env['DECKENT_LANGUAGE'], env['DECKENT_LANG']]
    .some(value => LOCALES.some(locale => locale === value?.slice(0, 2).toLowerCase()));
  const configLanguage = overridden ? undefined : await readLanguage?.().catch(() => undefined);
  const locale = resolveLocale(language, env, configLanguage);
  return { output: command ? renderCommandHelp(command, locale) : renderTopHelp(locale, all), locale };
}
