import { ErrorRegistry, emit, loadConfig, t, type ExitCode } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { cardIo, sinksOf } from '#surfaces/core/cli-approval/index.js';
import { catalogSuggestionViewRefusal } from '#engine/index.js';
import type { AgentsCommandContext } from './context.js';
import { agentTable, agentView, skillTable, skillView } from './render.js';
import { agentsInputHelp, agentsWrite, type InputAction } from './write.js';
import { SIGNER_ACTIONS, signersCommand, type SignerAction } from './signers.js';
import { agentStatsView } from './stats.js';
import { EVOLUTION_ACTIONS, draftDefine, evolutionCommand, resolveSuggestion, type EvolutionAction } from './evolution.js';
import limits from './limits.json' with { type: 'json' };

const ACTIONS = ['inspect', 'skills', 'skill', 'define', 'define-skill', 'stats', ...SIGNER_ACTIONS, ...EVOLUTION_ACTIONS] as const;
type Action = typeof ACTIONS[number];
interface Parsed { action: Action | null; words: string[]; scope?: string; language?: string; input?: string; principal?: string; label?: string; workClass?: string; suggestion?: string;
  fromSuggestion?: string; id?: string; json: boolean; help: boolean; schema?: true; example?: true }
/** How many words each action takes (`optional`: at most that many) and whether it needs `--input` (null: the bare agent list); S8-5 `enrol-signer`
 * takes `--principal` and `--label`; S8-4 standing cards take `--work-class` (and optionally `--suggestion`), a define may come `--from-suggestion` with `--id`. */
type Shape = { words: number; input: boolean; enrol?: true; optional?: true; workClass?: true; suggestion?: true; draft?: true; file?: true };
const card: Shape = { words: 1, input: false, workClass: true, suggestion: true };
const SHAPE: Readonly<Record<Action | 'list', Shape>> = { list: { words: 0, input: false }, inspect: { words: 1, input: false },
  skills: { words: 0, input: false }, skill: { words: 1, input: false }, define: { words: 0, input: true, draft: true, suggestion: true, file: true }, 'define-skill': { words: 0, input: true, draft: true, file: true },
  signers: { words: 0, input: false }, 'enrol-signer': { words: 0, input: false, enrol: true }, 'add-signer': { words: 0, input: true }, 'revoke-signer': { words: 1, input: false },
  'repair-signers': { words: 0, input: false }, 'import-skill': { words: 0, input: true, file: true }, stats: { words: 1, input: false, optional: true },
  suggestions: { words: 2, input: false, optional: true }, promote: card, demote: card, restore: card, retire: card, dismiss: { words: 1, input: false }, standing: { words: 1, input: false, workClass: true } };
const VALUE_FLAGS = { '--work-class': 'workClass', '--suggestion': 'suggestion', '--from-suggestion': 'fromSuggestion', '--id': 'id' } as const;
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
    else if ((key === '--schema' || key === '--example') && shape.file) result[key === '--schema' ? 'schema' : 'example'] = true;
    else if (key === '--scope' || key === '--lang' || (key === '--input' && shape.input) || ((key === '--principal' || key === '--label') && shape.enrol)
      || (key === '--work-class' && shape.workClass) || (key === '--suggestion' && shape.suggestion) || ((key === '--from-suggestion' || key === '--id') && shape.draft)) {
      const value = argv[++index]; if (!value || (value.startsWith('-') && key !== '--input' && key !== '--label')) throw ErrorRegistry.createError('CLI_USAGE');
      if (Object.hasOwn(VALUE_FLAGS, key)) result[VALUE_FLAGS[key as keyof typeof VALUE_FLAGS]] = value;
      else result[key === '--scope' ? 'scope' : key === '--lang' ? 'language' : key === '--input' ? 'input' : key === '--principal' ? 'principal' : 'label'] = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  // A define comes from a file or from a suggestion's draft (`--from-suggestion` + `--id`), never both; `--suggestion` names the revise suggestion a file decides.
  const draft = result.fromSuggestion !== undefined || result.id !== undefined;
  if (!result.help && !result.schema && !result.example && ((shape.optional ? result.words.length > shape.words : result.words.length !== shape.words) || (shape.input && !draft && result.input === undefined)
    || (draft && (result.input !== undefined || result.suggestion !== undefined || !result.fromSuggestion || !result.id)) || (shape.enrol && (!result.principal || !result.label))
    || (shape.workClass && !result.workClass) || (shape.draft && result.suggestion !== undefined && result.input === undefined))) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}

/** `deckent agents [inspect <id> | skills | skill <id> | define --input <file> | define-skill --input <file> | stats [<id>]]` (S7 catalog core, S8-2 stats), the S8-5
 * signer cards and the S8-3/S8-4 suggestions and standing cards (`suggestions`, `promote|demote|restore|retire <id> --work-class`, `dismiss`, `standing reset`). */
export async function agentsCommand(argv: readonly string[], context: AgentsCommandContext = {}): Promise<void | ExitCode> {
  const args = parse(argv), locale = commandLocale(context, args.language), sinks = sinksOf(context);
  if (args.help) { emit(`${t('agents.help.detail', {}, locale)}\n${t('agentsign.help.detail', {}, locale)}\n${t('agentstats.help', {}, locale)}\n${t('agentsevo.help', {}, locale)}`, sinks); return; }
  // BeUser E-02: the input file's contract or a filled example, without a project, card or terminal.
  if (args.schema || args.example) return agentsInputHelp(args.action as InputAction, args.schema === true, context, locale);
  const writing = args.action !== null && !['inspect', 'skills', 'skill', 'signers', 'stats', 'suggestions'].includes(args.action);
  // A catalog change is a person's terminal act (the default card): an AI tool, CI, pipe or `--json` is refused before anything is read.
  if (writing && cliMode(context, args.json).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: `${argv[0]} ${args.action}` } });
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const interactive = cliMode(context, args.json).mode === 'interactive', configured = (config.terminal as { scopeId?: unknown } | undefined)?.scopeId;
  const ask = cardIo(context, locale, config.approvals.sessionTtlMs).ask;
  const scope = await resolveCommandScope({ command: 'deckent agents', locale, explicit: args.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: writing, interactive, listScopes: scopeLister(context, root, options), pick: ask });
  if (!scope) { emit(t('agents.cancelled', {}, locale), { ...sinks, level: 'warning' }); return 1; }
  const io = { root, options, locale, scope, ask, inputMaxBytes: config.cli.invocationInputMaxBytes };
  if ((SIGNER_ACTIONS as readonly string[]).includes(args.action ?? '')) return signersCommand(args.action as SignerAction, { ...args, id: args.words[0] }, context, { ...io, json: args.json });
  if ((EVOLUTION_ACTIONS as readonly string[]).includes(args.action ?? '')) return evolutionCommand(args.action as EvolutionAction, args, context, { ...io, json: args.json });
  if (writing && args.fromSuggestion) return draftDefine(args.action as 'define' | 'define-skill', args, context, { ...io, json: args.json });
  // REVISE 2742 R1: a superseded (revoked producer key), expired, decided or shadow suggestion is refused before the card is shown; the commit checks again.
  const named = writing && args.suggestion ? await resolveSuggestion(args.suggestion, context, io) : null;
  const refused = named && catalogSuggestionViewRefusal(named, Date.now());
  if (refused) throw ErrorRegistry.createError(refused);
  if (writing) return agentsWrite(args.action as 'define' | 'define-skill', args.input!, context, { ...io, ...(named ? { suggestion: named.suggestionId } : {}) });
  const scopeId = scope.scopeId, id = args.words[0]!, lines = [scopeNotice(scope, locale)];
  if (!args.json && (args.action === null || args.action === 'stats')) {
    const diagnostics = await context.inspectCatalogMonitor?.(root, scopeId, options).catch(() => null);
    if (diagnostics?.includes('catalog-aggregator-unsigned')) lines.push(t('agentsevo.monitor.unsigned', {}, locale), t('agentsevo.monitor.unsignedAction', {}, locale));
    else if (diagnostics === null) lines.push(t('agentstats.signer.unavailable', {}, locale));
  }
  const show = (result: unknown, text: () => string) => { if (args.json) emit(result, { ...sinks, json: true }); else emit([...lines, text()].join('\n'), sinks); };
  if (args.action === 'stats') {
    const view = await context.inspectAgentStats?.(root, { schemaVersion: 1, scopeId, ...(args.words[0] ? { agentId: args.words[0] } : { limit: limits.list.limit }) }, options);
    if (!view) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE');
    if (view.status === 'not-found') throw ErrorRegistry.createError('AGENT_CATALOG_NOT_FOUND');
    show(view, () => agentStatsView(view, locale));
    return;
  }
  if (args.action === 'inspect' || args.action === 'skill') {
    const result = args.action === 'inspect' ? await context.inspectAgent?.(root, { schemaVersion: 1, scopeId, agentId: id }, options)
      : await context.inspectSkill?.(root, { schemaVersion: 1, scopeId, skillId: id }, options);
    if (!result) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE');
    if (result.status === 'not-found') throw ErrorRegistry.createError('AGENT_CATALOG_NOT_FOUND');
    show(result, () => 'agentId' in result.item ? agentView(result.item, result.history as never, locale, 'standings' in result ? result.standings : [], result.signers)
        : skillView(result.item, result.history as never, locale, result.signers));
    return;
  }
  const listing = args.action === 'skills' ? await context.listSkills?.(root, { schemaVersion: 1, scopeId, limit: limits.list.limit }, options)
    : await context.listAgents?.(root, { schemaVersion: 1, scopeId, limit: limits.list.limit }, options);
  if (!listing) throw ErrorRegistry.createError('AGENT_CATALOG_UNAVAILABLE');
  show(listing, () => !listing.items.length ? args.action === 'skills' ? t('agents.skills.none', {}, locale) : t('agents.none', {}, locale)
    : args.action === 'skills' ? skillTable(listing.items as never, locale, context) : agentTable(listing.items as never, locale, context));
}
