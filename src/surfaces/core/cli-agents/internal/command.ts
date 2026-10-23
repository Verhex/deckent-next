import { ErrorRegistry, emit, loadConfig, t, type ExitCode } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, resolveCommandScope, safeCell, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { cardIo, sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { AgentsCommandContext } from './context.js';
import { agentTable, agentView, skillTable, skillView } from './render.js';
import { agentsWrite } from './write.js';
import limits from './limits.json' with { type: 'json' };

const ACTIONS = ['inspect', 'skills', 'skill', 'define', 'define-skill'] as const;
type Action = typeof ACTIONS[number];
interface Parsed { action: Action | null; words: string[]; scope?: string; language?: string; input?: string; json: boolean; help: boolean }
/** How many words each action takes and whether it needs `--input` (null: the bare agent list). */
const SHAPE: Readonly<Record<Action | 'list', { words: number; input: boolean }>> = { list: { words: 0, input: false }, inspect: { words: 1, input: false },
  skills: { words: 0, input: false }, skill: { words: 1, input: false }, define: { words: 0, input: true }, 'define-skill': { words: 0, input: true } };
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'agents') throw ErrorRegistry.createError('CLI_USAGE');
  const result: Parsed = { action: null, words: [], json: false, help: false }, seen = new Set<string>();
  let index = 1;
  if ((ACTIONS as readonly string[]).includes(argv[1] ?? '')) { result.action = argv[1] as Action; index = 2; }
  const shape = SHAPE[result.action ?? 'list'];
  for (; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (!key.startsWith('-')) { result.words.push(key); continue; }
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--help') result.help = true;
    else if (key === '--json') result.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--scope' || key === '--lang' || (key === '--input' && shape.input)) {
      const value = argv[++index]; if (!value || (value.startsWith('-') && key !== '--input')) throw ErrorRegistry.createError('CLI_USAGE');
      result[key === '--scope' ? 'scope' : key === '--lang' ? 'language' : 'input'] = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (!result.help && (result.words.length !== shape.words || (shape.input && result.input === undefined))) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}

/** `deckent agents [inspect <id> | skills | skill <id> | define --input <file> | define-skill --input <file>]` (S7 catalog core). */
export async function agentsCommand(argv: readonly string[], context: AgentsCommandContext = {}): Promise<void | ExitCode> {
  const args = parse(argv), locale = commandLocale(context, args.language), sinks = sinksOf(context);
  if (args.help) { emit(t('agents.help.detail', {}, locale), sinks); return; }
  const writing = args.action === 'define' || args.action === 'define-skill';
  // A catalog change is a person's terminal act (the default card): an AI tool, CI, pipe or `--json` is refused before anything is read.
  if (writing && cliMode(context, args.json).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: `${argv[0]} ${args.action}` } });
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const interactive = cliMode(context, args.json).mode === 'interactive', configured = (config.terminal as { scopeId?: unknown } | undefined)?.scopeId;
  const ask = cardIo(context, locale, config.approvals.sessionTtlMs).ask;
  const scope = await resolveCommandScope({ command: 'deckent agents', locale, explicit: args.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: writing, interactive, listScopes: scopeLister(context, root, options), pick: ask });
  if (!scope) return writing ? 1 : undefined;
  if (writing) return agentsWrite(args.action as 'define' | 'define-skill', args.input!, context, { root, options, locale, scope, ask, inputMaxBytes: config.cli.invocationInputMaxBytes });
  const scopeId = scope.scopeId, id = args.words[0]!, lines = [scopeNotice(scope, locale)];
  const show = (result: unknown, text: () => string) => { if (args.json) emit(result, { ...sinks, json: true }); else emit([...lines, text()].join('\n'), sinks); };
  if (args.action === 'inspect' || args.action === 'skill') {
    const result = args.action === 'inspect' ? await context.inspectAgent?.(root, { schemaVersion: 1, scopeId, agentId: id }, options)
      : await context.inspectSkill?.(root, { schemaVersion: 1, scopeId, skillId: id }, options);
    if (!result) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE');
    show(result, () => result.status === 'not-found' ? t('agents.notFound', { id: safeCell(result.id) }, locale)
      : 'agentId' in result.item ? agentView(result.item, result.history as never, locale, 'standings' in result ? result.standings : []) : skillView(result.item, result.history as never, locale));
    return;
  }
  const listing = args.action === 'skills' ? await context.listSkills?.(root, { schemaVersion: 1, scopeId, limit: limits.list.limit }, options)
    : await context.listAgents?.(root, { schemaVersion: 1, scopeId, limit: limits.list.limit }, options);
  if (!listing) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE');
  show(listing, () => !listing.items.length ? args.action === 'skills' ? t('agents.skills.none', {}, locale) : t('agents.none', {}, locale)
    : args.action === 'skills' ? skillTable(listing.items as never, locale, context) : agentTable(listing.items as never, locale, context));
}
