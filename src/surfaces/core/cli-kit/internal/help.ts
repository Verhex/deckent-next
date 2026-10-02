import { t, resolveLocale, MESSAGE_REGISTRY, type Locale, type MessageKey } from '#platform/index.js';
import { CLI_CATALOG, HELP_GROUPS, type CliCommandName, type CliCommandSpec } from './command-catalog.js';

export interface RegisteredCliCommand<C> extends CliCommandSpec {
  readonly path: readonly string[];
  readonly run: (argv: readonly string[], context: C) => Promise<void>;
}
/** Bind the one catalog to actual dispatch handlers. No second command/help inventory. */
export function registerCliCommands<C>(handlers: Readonly<Record<CliCommandName, RegisteredCliCommand<C>['run']>>): readonly RegisteredCliCommand<C>[] {
  const visit = (spec: CliCommandSpec, parent: readonly string[], run: RegisteredCliCommand<C>['run']): RegisteredCliCommand<C>[] => {
    const path = [...parent, spec.name];
    return [{ ...spec, path, run }, ...(spec.children ?? []).flatMap(child => visit(child, path, run))];
  };
  return CLI_CATALOG.flatMap(spec => visit(spec, [], handlers[spec.name]));
}

/** Help is plain text; en/tr have no double-width glyphs. Wrap without dropping words. */
export function wrapHelp(text: string, width = 80): string {
  return text.split('\n').flatMap(line => {
    if ([...line].length <= width) return [line.trimEnd()];
    const result: string[] = []; let current = '';
    const indent = line.match(/^\s*/)?.[0] ?? '';
    for (const word of line.trim().split(/\s+/)) {
      if (current && [...current, ' ', ...word].length > width) { result.push(current); current = indent + word; }
      else current += (current ? ' ' : indent) + word;
    }
    result.push(current); return result;
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

export function renderCommandHelp(command: CliCommandSpec, locale: Locale): string {
  return wrapHelp([message(command.detail, locale).replace(/ ?\[--(?:json|no-color|lang (?:en\|tr|<locale>))\]/g, '').replace(/\n +(?=\n)/g, ''), '', message(command.summary, locale),
    ...(command.children?.length ? [t('cli.help.heading.commands', {}, locale), ...command.children.map(child => `  ${child.name.padEnd(22)}${message(child.summary, locale)}`)] : []),
    '', t('cli.help.common', {}, locale), t('cli.help.output', {}, locale), t('cli.help.examples', {}, locale)].join('\n'));
}

/** Recognize only a help request. Extra execution flags still reach the unchanged parser. */
export function cliHelpRequest<C>(argv: readonly string[], commands: readonly RegisteredCliCommand<C>[], env?: NodeJS.ProcessEnv): { output: string; locale: Locale } | null {
  const helpAt = argv.findIndex(value => value === '--help' || value === '-h');
  if (helpAt < 0) return null;
  const path = argv.slice(0, helpAt), tail = argv.slice(helpAt + 1);
  let language: string | undefined, all = false;
  for (let index = 0; index < tail.length; index++) {
    if (tail[index] === '--all' && path.length === 0 && !all) all = true;
    else if (tail[index] === '--lang' && language === undefined && tail[index + 1] && !tail[index + 1]!.startsWith('-')) language = tail[++index];
    else return null;
  }
  const locale = resolveLocale(language, env);
  if (!path.length) return { output: renderTopHelp(locale, all), locale };
  const command = commands.find(item => item.path.join('\0') === path.join('\0'))
    // Preserve the existing run/task help-only fallback, including unknown action names.
    ?? (path.length === 2 && (path[0] === 'run' || path[0] === 'task') ? commands.find(item => item.path.length === 1 && item.name === path[0]) : undefined);
  return command ? { output: renderCommandHelp(command, locale), locale } : null;
}
