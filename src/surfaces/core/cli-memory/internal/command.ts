import { ErrorRegistry, emit, loadConfig, t, type ConfigLoadOptions, type ExitCode } from '#platform/index.js';
import { MEMORY_LIMITS, MEMORY_STATES, type MemoryState } from '#domain/index.js';
import type { MemoryHeld, MemoryInspection } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, requireIdPrefix, resolveCommandScope, safeCell, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { cardIo, sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { MemoryCommandContext } from './context.js';
import { memoryWrite } from './write.js';
import { evaluatorLines, table, view } from './render.js';
import limits from './limits.json' with { type: 'json' };

export interface Parsed { action: 'search' | 'inspect' | 'propose' | 'verify' | 'retire' | null; words: string[]; states?: MemoryState[]; scope?: string; language?: string;
  input?: string; note?: string; reason?: string; supersededBy?: string; json: boolean; help: boolean }
const VALUED: Readonly<Record<string, 'scope' | 'language' | 'input' | 'note' | 'reason' | 'supersededBy'>> = { '--scope': 'scope', '--lang': 'language', '--input': 'input',
  '--note': 'note', '--reason': 'reason', '--superseded-by': 'supersededBy' };
/** Which flags and how many words each action takes (null: the bare list). */
const SHAPE = { list: { words: [0, 0], flags: ['--state'] }, search: { words: [1, Infinity], flags: ['--state'] }, inspect: { words: [1, 1], flags: [] },
  propose: { words: [0, 0], flags: ['--input'] }, verify: { words: [1, 1], flags: ['--note'] }, retire: { words: [1, 1], flags: ['--reason', '--superseded-by'] } } as const;
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'memory') throw ErrorRegistry.createError('CLI_USAGE');
  const result: Parsed = { action: null, words: [], json: false, help: false }, seen = new Set<string>();
  let index = 1;
  if (['search', 'inspect', 'propose', 'verify', 'retire'].includes(argv[1] ?? '')) { result.action = argv[1] as Parsed['action']; index = 2; }
  const shape = SHAPE[result.action ?? 'list'];
  for (; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (!key.startsWith('-')) { result.words.push(key); continue; }
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--help') result.help = true;
    else if (key === '--json') result.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--state' && (shape.flags as readonly string[]).includes(key)) {
      const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      const states = value.split(',');
      if (states.some(state => !(MEMORY_STATES as readonly string[]).includes(state))) throw ErrorRegistry.createError('CLI_USAGE', { params: { flag: '--state' } });
      result.states = [...new Set(states)] as MemoryState[];
    } else if (VALUED[key] && (key === '--scope' || key === '--lang' || (shape.flags as readonly string[]).includes(key))) {
      const value = argv[++index]; if (!value || (value.startsWith('-') && key !== '--input')) throw ErrorRegistry.createError('CLI_USAGE');
      result[VALUED[key]!] = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const required = result.action === 'propose' ? result.input : result.action === 'verify' ? result.note : result.action === 'retire' ? result.reason : '';
  if (!result.help && (result.words.length < shape.words[0] || result.words.length > shape.words[1] || required === undefined)) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}
/** One entry by its id or the unique short id the list shows (CLI_ID_UNKNOWN/AMBIGUOUS otherwise); `not-found` only without a list handler. */
async function resolveEntry(context: MemoryCommandContext, root: string, scopeId: string, id: string, options: ConfigLoadOptions): Promise<MemoryInspection> {
  if (!context.inspectMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
  const inspect = (entryId: string) => context.inspectMemory!(root, { schemaVersion: 1, scopeId, entryId }, options), result = await inspect(id);
  if (result.status !== 'not-found' || !context.listMemory) return result;
  const listed = await context.listMemory(root, { schemaVersion: 1, scopeId, states: [...MEMORY_STATES], limit: MEMORY_LIMITS.pageMax }, options);
  return listed.status === 'ok' ? inspect(requireIdPrefix(id, listed.entries.map(entry => entry.entryId))) : listed;
}
export async function memoryCommand(argv: readonly string[], context: MemoryCommandContext = {}): Promise<void | ExitCode> {
  const args = parse(argv), locale = commandLocale(context, args.language), sinks = sinksOf(context);
  if (args.help) { emit(t('memory.help.detail', {}, locale), sinks); return; }
  const writing = args.action === 'propose' || args.action === 'verify' || args.action === 'retire';
  // A memory change is a person's terminal act (like `coding instructions trust`): an AI tool, CI, pipe or `--json` is refused before anything is read.
  const operation = `${argv[0]} ${args.action}`;
  if (writing && cliMode(context, args.json).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation } });
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const interactive = cliMode(context, args.json).mode === 'interactive', configured = (config.terminal as { scopeId?: unknown } | undefined)?.scopeId;
  const ask = cardIo(context, locale, config.approvals.sessionTtlMs).ask;
  const scope = await resolveCommandScope({ command: 'deckent memory', locale, explicit: args.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: writing, interactive, listScopes: scopeLister(context, root, options), pick: ask });
  if (!scope) return writing ? 1 : undefined;
  if (writing) return memoryWrite(args, context, { root, options, locale, scope, ask, inputMaxBytes: config.cli.invocationInputMaxBytes, resolve: id => resolveEntry(context, root, scope.scopeId, id, options) });
  const base = { schemaVersion: 1 as const, scopeId: scope.scopeId, ...(args.states ? { states: args.states } : {}) };
  const lines = [scopeNotice(scope, locale)];
  const finish = (result: { readonly status: string }): ExitCode | undefined => {
    if (args.json) { emit(result, { ...sinks, json: true }); return result.status === 'held' ? 1 : undefined; }
    if (result.status !== 'held') return undefined;
    const { code } = result as MemoryHeld;
    emit(t('memory.held', { code, next: code === 'MEMORY_CORRUPT' ? t('memory.held.next.MEMORY_CORRUPT', {}, locale) : t('memory.held.next.MEMORY_UNAVAILABLE', {}, locale) }, locale), { ...sinks, level: 'error' }); return 1;
  };
  if (args.action === 'inspect') {
    if (!context.inspectMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
    const result = await resolveEntry(context, root, scope.scopeId, args.words[0]!, options);
    if (args.json || result.status === 'held') return finish(result);
    lines.push(result.status === 'not-found' ? t('memory.notFound', { id: safeCell(result.entryId) }, locale) : view(result.entry, result.history, locale));
  } else if (args.action === 'search') {
    if (!context.searchMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
    const result = await context.searchMemory(root, { ...base, query: args.words.join(' '), limit: limits.search.limit }, options);
    if (args.json || result.status === 'held') return finish(result);
    const terms = result.terms.join(' ');
    lines.push(result.method === 'scan' ? t('memory.search.method.scan', { count: MEMORY_LIMITS.scanMax, terms }, locale) : t('memory.search.method.full-text', { terms }, locale));
    if (!result.complete) lines.push(t('memory.search.incomplete', {}, locale));
    lines.push(result.entries.length ? table(result.entries, locale, context) : t('memory.search.none', { terms }, locale));
    if (result.withheld) lines.push(t('memory.withheld', { count: result.withheld }, locale));
  } else {
    if (!context.listMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
    const result = await context.listMemory(root, { ...base, limit: limits.list.limit }, options);
    if (args.json || result.status === 'held') return finish(result);
    lines.push(result.entries.length ? table(result.entries, locale, context) : t('memory.none', {}, locale));
    if (result.withheld) lines.push(t('memory.withheld', { count: result.withheld }, locale));
    if (context.inspectMemoryEvaluators) lines.push(...await context.inspectMemoryEvaluators(root, scope.scopeId, options).then(view => evaluatorLines(view, locale),
      () => [t('memory.view.evaluator.unavailable', {}, locale)]));
  }
  emit(lines.join('\n'), sinks);
}
