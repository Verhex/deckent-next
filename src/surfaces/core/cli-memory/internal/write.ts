import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { ErrorRegistry, EXIT_CODES, emit, t, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { memoryContentSchema, type MemoryContent } from '#domain/index.js';
import type { MemoryInspection } from '#engine/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { safeCell, scopeNotice, type CliCardRequest, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import { sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { MemoryCommandContext } from './context.js';
import type { Parsed } from './command.js';
import { contentLines, view } from './render.js';

export interface WriteContext { readonly root: string; readonly options: ConfigLoadOptions; readonly locale: Locale; readonly scope: ScopeResolution; readonly inputMaxBytes: number;
  readonly ask: (request: CliCardRequest) => Promise<string | null>; readonly resolve: (id: string) => Promise<MemoryInspection> }
export const cardOptions = (locale: Locale) => [{ id: 'apply', label: t('memory.card.apply', {}, locale), key: 'y' }, { id: 'cancel', label: t('memory.card.cancel', {}, locale), key: 'n' }];
const content = (value: MemoryContent, locale: Locale): string[] => [safeCell(value.title), ...contentLines(value, locale)];

/**
 * `deckent memory propose --input <file> | verify <id> --note <text> | retire <id> --reason <text> [--superseded-by <id>]` (lead 2026-10-23): only on the
 * person's own terminal (the caller refused AI tools, pipes and `--json` before this runs; the composition checks the terminal witness again for verify and
 * retire). Each change is shown on one card; nothing is written unless the person applies it, and the writer gets the revision the card showed.
 */
export async function memoryWrite(args: Parsed, context: MemoryCommandContext, io: WriteContext): Promise<void | ExitCode> {
  const { locale, scope } = io, sinks = sinksOf(context), cancelled = () => { emit(t('memory.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error; };
  emit(scopeNotice(scope, locale), sinks);
  if (args.action === 'propose') {
    if (!context.proposeMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
    const input = await readJsonInput(resolvePath(io.root, args.input!), io.inputMaxBytes,
      { subject: 'cli.input.subject.memory', limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
    const parsed = memoryContentSchema.safeParse(input);
    if (!parsed.success) throw ErrorRegistry.createError('MEMORY_ENTRY_INVALID');
    if (await io.ask({ title: t('memory.card.propose.title', {}, locale), body: [...content(parsed.data, locale), '', t('memory.card.propose.body', {}, locale)], options: cardOptions(locale) }) !== 'apply') return cancelled();
    const result = await context.proposeMemory(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId: scope.scopeId, content: parsed.data, origin: { kind: 'human', ref: null } }, io.options);
    emit(t('memory.done.proposed', { id: result.entry.entryId }, locale), sinks); return;
  }
  const found = await io.resolve(args.words[0]!);
  if (found.status === 'held') throw ErrorRegistry.createError(found.code);
  if (found.status === 'not-found') throw ErrorRegistry.createError('MEMORY_NOT_FOUND');
  const { entry } = found, verify = args.action === 'verify';
  if (verify ? !context.verifyMemory : !context.retireMemory) throw ErrorRegistry.createError('MEMORY_UNAVAILABLE');
  const body = [view(entry, found.history, locale), '', verify ? t('memory.card.verify.body', { note: safeCell(args.note!) }, locale)
    : t('memory.card.retire.body', { reason: safeCell(args.reason!), replacement: safeCell(args.supersededBy ?? '-') }, locale)];
  if (await io.ask({ title: verify ? t('memory.card.verify.title', {}, locale) : t('memory.card.retire.title', {}, locale), body, options: cardOptions(locale) }) !== 'apply') return cancelled();
  const base = { schemaVersion: 1 as const, commandId: randomUUID(), scopeId: scope.scopeId, entryId: entry.entryId, expectedRevision: entry.revision };
  const result = verify ? await context.verifyMemory!(io.root, { ...base, basis: { kind: 'human-review', note: args.note! } }, io.options)
    : await context.retireMemory!(io.root, { ...base, reason: args.reason!, supersededBy: args.supersededBy ?? null }, io.options);
  emit(verify ? t('memory.done.verified', { id: result.entry.entryId, revision: result.entry.revision }, locale)
    : t('memory.done.retired', { id: result.entry.entryId, revision: result.entry.revision }, locale), sinks);
}
