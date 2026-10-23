import { ErrorRegistry, emit, loadConfig, t, type ExitCode, type Locale } from '#platform/index.js';
import { MEMORY_LIMITS, MEMORY_STATES, type MemoryEntry, type MemoryState } from '#domain/index.js';
import type { MemoryHeld } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, cliTableStyle, displayId, formatAgo, renderCliTable, requireIdPrefix, resolveCommandScope, safeCell, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { cardIo, sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { MemoryCommandContext } from './context.js';
import limits from './limits.json' with { type: 'json' };

interface Parsed { action: 'search' | 'inspect' | null; words: string[]; states?: MemoryState[]; scope?: string; language?: string; json: boolean; help: boolean }
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'memory') throw ErrorRegistry.createError('CLI_USAGE');
  const result: Parsed = { action: null, words: [], json: false, help: false }, seen = new Set<string>();
  let index = 1;
  if (argv[1] === 'search' || argv[1] === 'inspect') { result.action = argv[1]; index = 2; }
  for (; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (!key.startsWith('-')) { if (!result.action) throw ErrorRegistry.createError('CLI_USAGE'); result.words.push(key); continue; }
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--help') result.help = true;
    else if (key === '--json') result.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--scope' || key === '--lang' || key === '--state') {
      const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--scope') result.scope = value; else if (key === '--lang') result.language = value;
      else {
        const states = value.split(',');
        if (states.some(state => !(MEMORY_STATES as readonly string[]).includes(state))) throw ErrorRegistry.createError('CLI_USAGE', { params: { flag: '--state' } });
        result.states = [...new Set(states)] as MemoryState[];
      }
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (!result.help && result.action && !result.words.length) throw ErrorRegistry.createError('CLI_USAGE');
  if (result.action === 'inspect' && (result.words.length > 1 || result.states)) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}
const state = (value: MemoryState, locale: Locale) => value === 'candidate' ? t('memory.state.candidate', {}, locale) : value === 'verified' ? t('memory.state.verified', {}, locale)
  : t('memory.state.retired', {}, locale);
const kind = (entry: MemoryEntry, locale: Locale) => entry.content.kind === 'lesson' ? t('memory.kind.lesson', {}, locale) : t('memory.kind.fact', {}, locale);
const actor = (who: { issuer: string; subject: string }) => safeCell(`${who.issuer}:${who.subject}`);
function table(entries: readonly MemoryEntry[], locale: Locale, context: MemoryCommandContext): string {
  const ids = entries.map(entry => entry.entryId), now = Date.now();
  return renderCliTable([{ header: t('memory.column.id', {}, locale) }, { header: t('memory.column.state', {}, locale) }, { header: t('memory.column.kind', {}, locale) },
    { header: t('memory.column.title', {}, locale), shrink: true }, { header: t('memory.column.changed', {}, locale) }],
  entries.map(entry => [displayId(entry.entryId, ids), state(entry.state, locale), kind(entry, locale), entry.content.title, formatAgo(entry.updatedAtMs, now, locale)]), cliTableStyle(context));
}
/** One entry for a person: content, lesson fields, who proposed it from where, how it was verified or retired, then every revision. */
function view(entry: MemoryEntry, history: readonly MemoryEntry[], locale: Locale): string {
  const now = Date.now(), { content, provenance, verification, retirement } = entry, lesson = content.lesson;
  return [safeCell(content.title), t('memory.view.state', { kind: kind(entry, locale), state: state(entry.state, locale), revision: entry.revision, changed: formatAgo(entry.updatedAtMs, now, locale) }, locale),
    safeCell(content.body), ...(content.tags.length ? [t('memory.view.tags', { tags: content.tags.map(tag => safeCell(tag)).join(', ') }, locale)] : []),
    ...(lesson ? [t('memory.view.lesson', { source: safeCell(lesson.source), cause: safeCell(lesson.cause), correction: safeCell(lesson.correction), evidence: safeCell(lesson.evidence) }, locale)] : []),
    t('memory.view.author', { author: actor(provenance.author), who: provenance.author.ai ? t('memory.view.author.ai', {}, locale) : t('memory.view.author.person', {}, locale),
      origin: safeCell(provenance.origin.ref ? `${provenance.origin.kind} ${provenance.origin.ref}` : provenance.origin.kind) }, locale),
    verification?.basis === 'human-review' ? t('memory.view.verified.human-review', { reviewer: actor(verification.reviewer), note: safeCell(verification.note) }, locale)
      : verification ? t('memory.view.verified.independent-evaluation', { record: safeCell(`${verification.record.kind}/${verification.record.id}`), evaluator: actor(verification.evaluator) }, locale)
        : entry.state === 'candidate' ? t('memory.view.unverified', {}, locale) : '',
    ...(retirement ? [t('memory.view.retired', { by: actor(retirement.by), reason: safeCell(retirement.reason) }, locale),
      ...(retirement.supersededBy ? [t('memory.view.superseded', { id: safeCell(retirement.supersededBy) }, locale)] : [])] : []),
    t('memory.view.history', {}, locale), ...history.map(item => t('memory.view.revision', { revision: item.revision, state: state(item.state, locale), at: formatAgo(item.updatedAtMs, now, locale) }, locale)),
  ].filter(Boolean).join('\n');
}

/**
 * `deckent memory [search <words…> | inspect <id>]` (S4 v1, read-only). A read the journal could not complete is shown as held on stderr with
 * the next step and exits 1 (`--json` prints the held result); it is never shown as an empty memory.
 */
export async function memoryCommand(argv: readonly string[], context: MemoryCommandContext = {}): Promise<void | ExitCode> {
  const args = parse(argv), locale = commandLocale(context, args.language), sinks = sinksOf(context);
  if (args.help) { emit(t('memory.help.detail', {}, locale), sinks); return; }
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const interactive = cliMode(context, args.json).mode === 'interactive', configured = (config.terminal as { scopeId?: unknown } | undefined)?.scopeId;
  const scope = await resolveCommandScope({ command: 'deckent memory', locale, explicit: args.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: false, interactive, listScopes: scopeLister(context, root, options), pick: cardIo(context, locale, config.approvals.sessionTtlMs).ask });
  if (!scope) return;
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
    const inspect = (entryId: string) => context.inspectMemory!(root, { schemaVersion: 1, scopeId: scope.scopeId, entryId }, options);
    let result = await inspect(args.words[0]!);
    // The list shows short ids: an unknown exact id is resolved as a unique prefix over the scope's entries (CLI_ID_UNKNOWN/AMBIGUOUS otherwise).
    if (result.status === 'not-found' && context.listMemory) {
      const listed = await context.listMemory(root, { schemaVersion: 1, scopeId: scope.scopeId, states: [...MEMORY_STATES], limit: MEMORY_LIMITS.pageMax }, options);
      if (listed.status === 'ok') result = await inspect(requireIdPrefix(args.words[0]!, listed.entries.map(entry => entry.entryId)));
    }
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
  } else {
    if (!context.listMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
    const result = await context.listMemory(root, { ...base, limit: limits.list.limit }, options);
    if (args.json || result.status === 'held') return finish(result);
    lines.push(result.entries.length ? table(result.entries, locale, context) : t('memory.none', {}, locale));
  }
  emit(lines.join('\n'), sinks);
}
