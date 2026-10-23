import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { ErrorRegistry, EXIT_CODES, emit, t, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import type { SkillRef } from '#domain/index.js';
import { agentDefinitionFileSchema as agentFileSchema, skillDefinitionFileSchema as skillFileSchema } from '#engine/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { safeCell, scopeNotice, type CliCardRequest, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import { sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { AgentsCommandContext } from './context.js';
import { agentLines } from './render.js';

interface WriteContext { readonly root: string; readonly options: ConfigLoadOptions; readonly locale: Locale; readonly scope: ScopeResolution; readonly inputMaxBytes: number;
  readonly ask: (request: CliCardRequest) => Promise<string | null> }
const options = (locale: Locale) => [{ id: 'apply', label: t('agents.card.apply', {}, locale), key: 'y' }, { id: 'cancel', label: t('agents.card.cancel', {}, locale), key: 'n' }];
const revisionLine = (previous: number | null, locale: Locale) => previous === null ? t('agents.card.new', {}, locale) : t('agents.card.revision', { from: previous, to: previous + 1 }, locale);

/**
 * `deckent agents define --input <file> | define-skill --input <file>` (S7; the default card of AJAN-ORG S6): only on the person's own terminal (the
 * caller refused AI tools, pipes and --json before this runs; the composition checks the terminal witness again). Each change is one card; nothing is
 * written unless the person applies it, and the writer gets the revision the card showed (compare-and-set).
 */
export async function agentsWrite(action: 'define' | 'define-skill', input: string, context: AgentsCommandContext, io: WriteContext): Promise<void | ExitCode> {
  const { locale, scope } = io, sinks = sinksOf(context), scopeId = scope.scopeId;
  emit(scopeNotice(scope, locale), sinks);
  const raw = await readJsonInput(resolvePath(io.root, input), io.inputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  const ask = async (title: string, body: string[]) => await io.ask({ title, body, options: options(locale) }) === 'apply';
  const cancelled = () => { emit(t('agents.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error; };
  if (!context.inspectSkill || (action === 'define' ? !context.inspectAgent || !context.defineAgent : !context.defineSkill)) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE');
  if (action === 'define-skill') {
    const file = skillFileSchema.safeParse(raw);
    if (!file.success) throw ErrorRegistry.createError('SKILL_DEFINITION_INVALID');
    const { skillId, ...content } = file.data, current = await context.inspectSkill(io.root, { schemaVersion: 1, scopeId, skillId }, io.options);
    const previous = current.status === 'ok' ? current.item.revision : null;
    if (!await ask(t('agents.card.skill.title', {}, locale), [`${safeCell(skillId)} · ${safeCell(content.name)}`, safeCell(content.text), '', revisionLine(previous, locale),
      t('agents.card.skill.body', {}, locale)])) return cancelled();
    const result = await context.defineSkill!(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId, skillId, expectedRevision: previous, content }, io.options);
    emit(t('agents.done.skill', { id: result.item.skillId, revision: result.item.revision }, locale), sinks); return;
  }
  const file = agentFileSchema.safeParse(raw);
  if (!file.success) throw ErrorRegistry.createError('AGENT_DEFINITION_INVALID');
  const { agentId, skills: wanted, ...rest } = file.data, skills: SkillRef[] = [];
  for (const want of wanted) {
    const found = await context.inspectSkill(io.root, { schemaVersion: 1, scopeId, skillId: want.skillId }, io.options);
    const row = found.status === 'ok' ? want.revision === undefined ? found.item : found.history.find(item => item.revision === want.revision) : undefined;
    if (!row) throw ErrorRegistry.createError('AGENT_SKILL_NOT_PINNED');
    skills.push({ skillId: row.skillId, revision: row.revision, digest: row.contentDigest });
  }
  const content = { ...rest, skills }, current = await context.inspectAgent!(io.root, { schemaVersion: 1, scopeId, agentId }, io.options);
  const previous = current.status === 'ok' ? current.item.revision : null;
  if (!await ask(previous === null ? t('agents.card.agent.new', {}, locale) : t('agents.card.agent.revise', {}, locale),
    [...agentLines(agentId, content, locale), '', revisionLine(previous, locale), t('agents.card.agent.body', {}, locale)])) return cancelled();
  const result = await context.defineAgent!(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId, agentId, expectedRevision: previous, content }, io.options);
  emit(t('agents.done.agent', { id: result.item.agentId, revision: result.item.revision }, locale), sinks);
}
