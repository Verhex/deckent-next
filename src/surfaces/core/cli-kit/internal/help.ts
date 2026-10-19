import { t, resolveLocale, LOCALES, MESSAGE_REGISTRY, ErrorRegistry, type ExitCode, type Locale, type MessageKey } from '#platform/index.js';
import { CLI_CATALOG, HELP_GROUPS, type CliCommandName, type CliCommandSpec, type CliInstallationContract } from './command-catalog.js';

interface CliHelpSpec extends CliCommandSpec {
  readonly path?: readonly string[];
  readonly parent?: CliHelpSpec;
}
export interface RegisteredCliCommand<C> extends CliHelpSpec {
  readonly path: readonly string[];
  /** A handler may return a non-zero exit code for a completed command whose result is not ok (e.g. a failed audit verification). */
  readonly run: (argv: readonly string[], context: C) => Promise<void | ExitCode>;
}
/** The context fields catalog dispatch reads: the language of a refusal (an already resolved host locale wins over the environment). */
export interface CliDispatchContext { readonly env?: NodeJS.ProcessEnv; readonly locale?: Locale; readonly onLocale?: (locale: Locale) => void }

/** Children a family dispatches and shows now; a `planned` name is reserved only. */
const live = (spec: CliCommandSpec) => (spec.children ?? []).filter(child => !child.planned);
const COMMON_VALUE_FLAGS = ['--lang', '--scope'];
const CLI_NAME = 'deckent';
/**
 * The catalog's decision for one family call without an action, before its handler runs (owner 2026-10-19 "boş komut yok"): the family's
 * read default runs once its required flags are present, or the missing argument is reported. A call with an action word reaches the
 * handler unchanged (its own parser refuses an unknown one); `cli-grouped-help.test.ts` keeps handler actions equal to the catalog.
 * Words are argv positionals after flags; the values of `--lang`, `--scope` and the family's required flags are not words.
 */
export function catalogDispatch(spec: CliCommandSpec, argv: readonly string[]): { readonly argv: readonly string[] } | { readonly missing: readonly string[] } {
  const rest = argv.slice(1), children = live(spec), bare = spec.bare;
  const valued = [...COMMON_VALUE_FLAGS, ...(bare !== 'handler' ? bare?.requires ?? [] : []).map(flag => flag.split(' ')[0]!)];
  for (let index = 0; index < rest.length; index++) {
    if (!rest[index]!.startsWith('-')) return { argv };
    if (valued.includes(rest[index]!)) index++;
  }
  if (bare === 'handler' || (!bare && !children.length)) return { argv };
  const missing = (bare?.requires ?? []).filter(flag => !rest.includes(flag.split(' ')[0]!));
  if (missing.length) return { missing };
  if (bare?.read) return { argv: [argv[0]!, bare.read, ...rest] };
  return children.length ? { missing: ['<action>'] } : { argv };
}

function refuse(spec: CliCommandSpec, argv: readonly string[], missing: readonly string[], context: CliDispatchContext | undefined): Error {
  const flag = argv.indexOf('--lang'), env = context?.env ?? process.env;
  const locale = flag >= 0 || !context?.locale ? resolveLocale(flag >= 0 ? argv[flag + 1] : undefined, env) : context.locale;
  context?.onLocale?.(locale);
  const actions = live(spec).map(child => child.children?.length ? `${child.name} ${live(child).map(item => item.name).join('|')}` : child.name);
  return ErrorRegistry.createError('CLI_USAGE', { params: { command: `${CLI_NAME} ${spec.name}`, usage: [
    t('cli.help.bare.missing', { argument: missing.map(item => placeholders(item, locale)).join(', ') }, locale),
    ...(actions.length ? [t('cli.help.bare.actions', { actions: actions.join(' | ') }, locale)] : []),
    t('cli.help.bare.details', { command: spec.name }, locale)].join('\n') } });
}

/** Bind the one catalog to actual dispatch handlers. No second command/help inventory: the catalog decides which action reaches a handler. */
export function registerCliCommands<C extends CliDispatchContext>(handlers: Readonly<Record<CliCommandName, RegisteredCliCommand<C>['run']>>): readonly RegisteredCliCommand<C>[] {
  const visit = (spec: CliCommandSpec, parent: RegisteredCliCommand<C> | undefined, run: RegisteredCliCommand<C>['run']): RegisteredCliCommand<C>[] => {
    const path = [...(parent?.path ?? []), spec.name];
    const entry = { ...spec, path, run, ...(parent ? { parent } : {}) };
    return [entry, ...live(spec).flatMap(child => visit(child, entry, run))];
  };
  return CLI_CATALOG.flatMap(spec => {
    const handler = handlers[spec.name];
    const run: RegisteredCliCommand<C>['run'] = (argv, context) => {
      const decision = catalogDispatch(spec, argv);
      if ('missing' in decision) throw refuse(spec, argv, decision.missing, context);
      return handler(decision.argv, context);
    };
    return visit(spec, undefined, run);
  });
}

/** The installation contract of the deepest registered command naming argv's leading positionals, read as the kernel parser reads them (flags dropped,
 * the common `--lang <locale>` value skipped: `policy --json vocabulary`, `policy --lang tr vocabulary`), inherited from its family when undeclared.
 * It only skips the preflight; the handler still validates argv (an unknown option or extra word is CLI_USAGE before any installation read). */
export function cliInstallationContract<C>(argv: readonly string[], commands: readonly RegisteredCliCommand<C>[]): CliInstallationContract | undefined {
  const words: string[] = [];
  for (let index = 0; index < argv.length; index++) { if (argv[index] === '--lang') index++; else if (!argv[index]!.startsWith('-')) words.push(argv[index]!); }
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

/** The action column of a family: at least 22 columns, and always one name plus two spaces so a long action never runs into its summary. */
const childColumn = (children: readonly { readonly name: string }[]) => Math.max(22, ...children.map(child => child.name.length + 2));
/** Catalog-owned messages contain no interpolation; their keys are validated in both locales. */
function message(key: MessageKey, locale: Locale): string { return MESSAGE_REGISTRY.catalogs[locale][key]!; }
/** CLI syntax keeps flags verbatim; `<word>` placeholders are shown in the reader's language when the help family names them. */
function placeholders(syntax: string, locale: Locale): string {
  return syntax.replace(/<([a-z]+)/g, (whole, word: string) => {
    const text = MESSAGE_REGISTRY.catalogs[locale][`cli.help.placeholder.${word}`];
    return text ? `<${text}` : whole;
  });
}
/** A row whose text continues under its own column (a hanging indent), so wrapping never collapses the alignment;
 * a short last line takes words from the line above (no orphans of three words or fewer). */
function hanging(lead: string, text: string, width = 80): string[] {
  const rows: string[][] = [[]], room = width - lead.length;
  for (const word of text.split(' ')) {
    const current = rows.at(-1)!;
    if (current.length && [...current.join(' '), ' ', ...word].length > room) rows.push([word]); else current.push(word);
  }
  const last = rows.at(-1)!, previous = rows.at(-2);
  while (previous && last.length <= 3 && previous.length > 4 && [...[previous.at(-1)!, ...last].join(' ')].length <= room) last.unshift(previous.pop()!);
  return rows.map((words, index) => (index ? ' '.repeat(lead.length) : lead) + words.join(' '));
}
/** Action alternatives as whole items (`a | b | catalog list|register`), wrapped between items only. */
function alternatives(items: readonly string[], indent = '      ', width = 80): string[] {
  const rows: string[] = [];
  let current = '';
  items.forEach((item, index) => {
    const piece = item + (index < items.length - 1 ? ' |' : '');
    if (current && [...indent, ...current, ' ', ...piece].length > width) { rows.push(indent + current); current = piece; }
    else current = current ? `${current} ${piece}` : piece;
  });
  return [...rows, indent + current];
}
const actionNames = (spec: CliCommandSpec) => live(spec).map(child => child.children?.length ? `${child.name} ${live(child).map(item => item.name).join('|')}` : child.name);
const bareNote = (spec: CliCommandSpec, locale: Locale) => spec.bare && spec.bare !== 'handler' && spec.bare.read
  ? ' ' + t('cli.help.top.withoutAction', { action: spec.bare.read }, locale) : '';

/** The main help: surfaces, every command with its actions and argument synopsis, then options (owner 2026-10-19: 100–150 lines).
 * `_all` is retired (no hidden tier); it stays only while `cli/internal/entry.ts` still passes it (delta L-HELP-catalog.md §1). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retired parameter kept for the unchanged caller until the lead's join.
export function renderTopHelp(locale: Locale = resolveLocale(), _all = false, catalog: readonly CliCommandSpec[] = CLI_CATALOG): string {
  return [t('cli.help', { name: 'deckent' }, locale), '', message('cli.help.top.surfaces', locale), '', message('cli.help.top.commands', locale),
    ...HELP_GROUPS.flatMap(group => {
      const commands = catalog.filter(item => item.group === group && !item.planned);
      return commands.length ? ['', message(`cli.help.group.${group}`, locale) + ':', ...commands.flatMap(command => [
        ...hanging(`  ${command.name.padEnd(12)}`, message(command.summary, locale) + bareNote(command, locale)),
        ...(live(command).length ? alternatives(actionNames(command)) : []),
        ...(command.args ? [wrapHelp(`      ${placeholders(command.args, locale)}`)] : []),
      ])] : [];
    }), '', message('cli.help.top.options', locale), '', message('cli.help.top.footer', locale)].join('\n');
}

export function renderCommandHelp(command: CliHelpSpec, locale: Locale): string {
  const examples = MESSAGE_REGISTRY.catalogs[locale][`${command.detail}.examples`];
  const family = command.parent, children = live(command);
  const overview = family ? [`deckent ${command.path!.join(' ')}`, message(command.summary, locale), '',
    t('cli.help.familySynopsis', { command: family.path!.join(' ') }, locale), message(family.summary, locale), ''] : [];
  const bare = !family && command.bare && command.bare !== 'handler' && command.bare.read
    ? [t('cli.help.family.withoutAction', { command: `${CLI_NAME} ${command.name} ${command.bare.read}` }, locale)] : [];
  const rows = children.flatMap(child => hanging(`  ${child.name.padEnd(childColumn(children))}`, message(child.summary, locale)));
  return [wrapHelp([...overview, message(command.detail, locale).replace(/ ?\[--(?:json|no-color|lang (?:en\|tr|<locale>))\]/g, '').replace(/\n +(?=\n)/g, ''), ...(family ? [] : ['', message(command.summary, locale)])].join('\n')),
    ...(children.length ? [t('cli.help.heading.commands', {}, locale), ...rows] : []), ...bare,
    wrapHelp(['', t('cli.help.common', {}, locale), t('cli.help.output', {}, locale), ...(examples ? [examples] : [])].join('\n'))].join('\n');
}

/** Recognize only a help request. Extra execution flags still reach the unchanged parser. */
export async function cliHelpRequest<C>(argv: readonly string[], commands: readonly RegisteredCliCommand<C>[], env: NodeJS.ProcessEnv = process.env, readLanguage?: () => Promise<Locale | undefined>): Promise<{ output: string; locale: Locale } | null> {
  const helpAt = argv.findIndex(value => value === '--help' || value === '-h');
  if (helpAt < 0) return null;
  const path = argv.slice(0, helpAt), tail = argv.slice(helpAt + 1);
  // `--all` is retired: the main help shows every command. It is still tolerated on the main help so that call stays side-effect free.
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
  return { output: command ? renderCommandHelp(command, locale) : renderTopHelp(locale), locale };
}
