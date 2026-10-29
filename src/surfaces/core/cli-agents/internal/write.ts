import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { ErrorRegistry, EXIT_CODES, emit, loadConfig, t, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import type { AgentDefinition, SkillRef } from '#domain/index.js';
import { agentDefinitionFileSchema as agentFileSchema, skillDefinitionFileSchema as skillFileSchema, skillImportFileSchema, configuredWorkClassIds } from '#engine/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { safeCell, scopeNotice, type CliCardRequest, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import { assertInputFields, inputSchemaText, sinksOf } from '#surfaces/core/cli-approval/index.js';
import type { AgentsCommandContext } from './context.js';
import { agentLines } from './render.js';

interface WriteContext { readonly root: string; readonly options: ConfigLoadOptions; readonly locale: Locale; readonly scope: ScopeResolution; readonly inputMaxBytes: number;
  readonly ask: (request: CliCardRequest) => Promise<string | null>;
  /** S8-4: the open `revise-agent` suggestion this new revision decides (`--suggestion`, full id). */
  readonly suggestion?: string }
/** BeUser E-09: what a revision changes, field by field (a long persona is named, not repeated); "no change" when the file equals the current one. */
function agentDiff(before: AgentDefinition['content'], after: AgentDefinition['content'], locale: Locale): string[] {
  const skills = (rows: readonly SkillRef[]) => rows.map(row => `${row.skillId}@${row.revision}`).join(', ') || '-';
  const pairs: [string, string, string][] = [['name', before.name, after.name], ['workClasses', before.workClasses.join(', '), after.workClasses.join(', ')],
    ['skills', skills(before.skills), skills(after.skills)], ['parentAgentId', before.parentAgentId ?? '-', after.parentAgentId ?? '-']];
  const lines = pairs.filter(([, a, b]) => a !== b).map(([field, a, b]) => t('agents.card.diff', { field, before: safeCell(a), after: safeCell(b) }, locale));
  if (before.persona !== after.persona) lines.push(t('agents.card.diff.persona', {}, locale));
  return lines.length ? lines : [t('agents.card.diff.none', {}, locale)];
}
export type InputAction = 'define' | 'define-skill' | 'import-skill';
const FILE_SCHEMAS = { define: agentFileSchema, 'define-skill': skillFileSchema, 'import-skill': skillImportFileSchema } as const;
/** BeUser E-02: the WorkClasses an agent may name here (Core seed + this installation's registry). */
const workClassesOf = async (root: string, options: ConfigLoadOptions) => configuredWorkClassIds((await loadConfig(root, options).catch(() => null))?.admission?.registry);
/** `--schema` prints the file's JSON Schema (machine output); `--example` a filled, localized file and, for an agent, the valid WorkClasses. */
export async function agentsInputHelp(action: InputAction, schema: boolean, context: AgentsCommandContext, locale: Locale): Promise<void> {
  const sinks = sinksOf(context);
  if (schema) { emit(inputSchemaText(FILE_SCHEMAS[action]), { ...sinks, json: false }); return; }
  if (action !== 'define') { emit(action === 'define-skill' ? t('agents.example.skill', {}, locale) : t('agents.example.import', {}, locale), sinks); return; }
  const classes = await workClassesOf(context.root ?? process.cwd(), { env: context.env ?? process.env });
  emit([t('agents.example.agent', { workClass: classes[0] ?? '-' }, locale), t('agents.example.workClasses', { list: classes.join(', ') }, locale)].join('\n'), sinks);
}
/** A file that does not fit names its first field and points at the filled example (no bare `*_INVALID`). */
export const assertAgentsFile = (action: InputAction, raw: unknown) => assertInputFields(`deckent agents ${action}`, FILE_SCHEMAS[action], raw, `deckent agents ${action} --example`);
const options = (locale: Locale) => [{ id: 'apply', label: t('agents.card.apply', {}, locale), role: 'yes' as const }, { id: 'cancel', label: t('agents.card.cancel', {}, locale), role: 'no' as const }];
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
    { subject: 'cli.input.subject.agent', limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  const ask = async (title: string, body: string[]) => await io.ask({ title, body, options: options(locale) }) === 'apply';
  const cancelled = () => { emit(t('agents.cancelled', {}, locale), { level: 'warning', ...sinks }); return EXIT_CODES.error; };
  if (!context.inspectSkill || (action === 'define' ? !context.inspectAgent || !context.defineAgent : !context.defineSkill)) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE');
  if (action === 'define-skill') {
    assertAgentsFile('define-skill', raw); const file = skillFileSchema.safeParse(raw);
    if (!file.success) throw ErrorRegistry.createError('SKILL_DEFINITION_INVALID');
    const { skillId, ...content } = file.data, current = await context.inspectSkill(io.root, { schemaVersion: 1, scopeId, skillId }, io.options);
    const previous = current.status === 'ok' ? current.item.revision : null;
    if (!await ask(t('agents.card.skill.title', {}, locale), [`${safeCell(skillId)} · ${safeCell(content.name)}`, safeCell(content.text), '', revisionLine(previous, locale),
      t('agents.card.skill.body', {}, locale)])) return cancelled();
    const result = await context.defineSkill!(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId, skillId, expectedRevision: previous, content }, io.options);
    emit(t('agents.done.skill', { id: result.item.skillId, revision: result.item.revision }, locale), sinks); return;
  }
  assertAgentsFile('define', raw); const file = agentFileSchema.safeParse(raw);
  if (!file.success) throw ErrorRegistry.createError('AGENT_DEFINITION_INVALID');
  const { agentId, skills: wanted, ...rest } = file.data, skills: SkillRef[] = [], known = await workClassesOf(io.root, io.options);
  // E-02: an unknown WorkClass is named with this installation's list before any card (the application checks again at commit).
  if (rest.workClasses.some(id => !known.includes(id))) throw ErrorRegistry.createError('AGENT_WORK_CLASS_UNKNOWN', { params: { known: known.join(', ') } });
  for (const want of wanted) {
    const found = await context.inspectSkill(io.root, { schemaVersion: 1, scopeId, skillId: want.skillId }, io.options);
    const row = found.status === 'ok' ? want.revision === undefined ? found.item : found.history.find(item => item.revision === want.revision) : undefined;
    if (!row) throw ErrorRegistry.createError('AGENT_SKILL_NOT_PINNED');
    skills.push({ skillId: row.skillId, revision: row.revision, digest: row.contentDigest });
  }
  const content = { ...rest, skills }, current = await context.inspectAgent!(io.root, { schemaVersion: 1, scopeId, agentId }, io.options);
  const previous = current.status === 'ok' ? current.item.revision : null;
  if (!await ask(previous === null ? t('agents.card.agent.new', {}, locale) : t('agents.card.agent.revise', {}, locale),
    [...agentLines(agentId, content, locale), '', revisionLine(previous, locale), ...(current.status === 'ok' ? agentDiff(current.item.content, content, locale) : []),
      t('agents.card.agent.body', {}, locale)])) return cancelled();
  const result = await context.defineAgent!(io.root, { schemaVersion: 1, commandId: randomUUID(), scopeId, agentId, expectedRevision: previous, content,
    ...(io.suggestion ? { fromSuggestion: io.suggestion } : {}) }, io.options);
  emit(t('agents.done.agent', { id: result.item.agentId, revision: result.item.revision }, locale), sinks);
}
