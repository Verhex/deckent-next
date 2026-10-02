import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type Locale } from '#platform/index.js';
import { decisionPrepareInputSchema, decisionAskCommandSchema, decisionQuerySchema, decisionRecordCommandSchema, decisionOutcomeCommandSchema,
  type DecisionAskResult, type DecisionInspection } from '#engine/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import type { DecisionCommandContext } from './context.js';

type Action = 'prepare' | 'ask' | 'record' | 'outcome' | 'inspect';
interface Parsed { action?: Action; input?: string; language?: string; json: boolean; help: boolean }
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'decide') throw ErrorRegistry.createError('CLI_USAGE');
  const result: Parsed = { json: false, help: false };
  let start = 1;
  if (argv[1] && !argv[1].startsWith('-')) {
    const action = argv[1];
    if (action !== 'prepare' && action !== 'ask' && action !== 'record' && action !== 'outcome' && action !== 'inspect') throw ErrorRegistry.createError('CLI_USAGE');
    result.action = action; start = 2;
  }
  const seen = new Set<string>();
  for (let i = start; i < argv.length; i++) {
    const key = argv[i] === '-h' ? '--help' : argv[i]!;
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--help') result.help = true;
    else if (key === '--json') result.json = true;
    else if (key === '--no-color') continue;
    else if (key === '--input' || key === '--lang') {
      const value = argv[++i]; if (!value || (value.startsWith('-') && value !== '-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--input') result.input = value; else result.language = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if ((result.help && (result.input || result.json)) || (!result.help && (!result.action || !result.input))) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}
function renderAdvice(result: DecisionAskResult | DecisionInspection, locale: Locale): string {
  if (result.status === 'not-found') return t('decision.notFound', { id: result.decisionId }, locale);
  const statuses = { advised: t('decision.status.advised', {}, locale), 'below-threshold': t('decision.status.below-threshold', {}, locale),
    unknown: t('decision.status.unknown', {}, locale), cancelled: t('decision.status.cancelled', {}, locale), unavailable: t('decision.status.unavailable', {}, locale) };
  const lines = [t('decision.result', { id: result.decisionId, status: statuses[result.status] }, locale)];
  if (result.advice) {
    const advice = result.advice;
    lines.push(t('decision.choice', { choice: advice.choice, confidence: advice.confidence, threshold: result.thresholds.choice }, locale));
    for (const [option, probability] of Object.entries(advice.probabilities)) lines.push(t('decision.probability', { option, probability }, locale));
    lines.push(t('decision.sufficiency', { score: advice.sufficiency, threshold: result.thresholds.sufficiency }, locale));
  } else lines.push(t('decision.noAdvice', {}, locale));
  if (result.replayed) lines.push(t('decision.replayed', {}, locale));
  lines.push(t('decision.authorityNotice', {}, locale));
  return lines.join('\n');
}
/** JSON input contains the versioned application command; selection only records data. */
export async function decisionCommand(argv: readonly string[], context: DecisionCommandContext = {}): Promise<void> {
  const args = parse(argv), env = context.env ?? process.env;
  let locale = resolveLocale(args.language, env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (args.help) { emit(t('cli.help.decide', {}, locale), sinks); return; }
  const root = context.root ?? process.cwd(), options = { env }, config = await loadConfig(root, options);
  locale = resolveLocale(args.language, env, config.language); context.onLocale?.(locale);
  const input = await readJsonInput(args.input === '-' ? '-' : resolve(root, args.input!), config.cli.invocationInputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  const schema = args.action === 'prepare' ? decisionPrepareInputSchema : args.action === 'ask' ? decisionAskCommandSchema
    : args.action === 'record' ? decisionRecordCommandSchema : args.action === 'outcome' ? decisionOutcomeCommandSchema : decisionQuerySchema;
  const validation = schema.safeParse(input);
  if (!validation.success) throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID');
  if (args.action === 'prepare') {
    if (!context.prepareDecision) throw ErrorRegistry.createError('DECISION_UNAVAILABLE');
    const result = await context.prepareDecision(root, decisionPrepareInputSchema.parse(input), options);
    emit(result, { ...sinks, json: args.json, render: value => t('decision.prepared', { digest: value.caseDigest,
      choice: value.thresholds.choice, sufficiency: value.thresholds.sufficiency }, locale) });
  } else if (args.action === 'ask') {
    if (!context.askDecision) throw ErrorRegistry.createError('DECISION_UNAVAILABLE');
    const result = await context.askDecision(root, decisionAskCommandSchema.parse(input), options, context.signal);
    emit(result, { ...sinks, json: args.json, render: value => renderAdvice(value, locale) });
  } else if (args.action === 'inspect') {
    if (!context.inspectDecision) throw ErrorRegistry.createError('DECISION_UNAVAILABLE');
    const result = await context.inspectDecision(root, decisionQuerySchema.parse(input), options);
    emit(result, { ...sinks, json: args.json, render: value => renderAdvice(value, locale) });
  } else if (args.action === 'record') {
    if (!context.recordDecision) throw ErrorRegistry.createError('DECISION_UNAVAILABLE');
    const command = decisionRecordCommandSchema.parse(input), result = await context.recordDecision(root, command, options);
    emit(result, { ...sinks, json: args.json, render: () => [t('decision.recorded', { id: command.decisionId, option: command.selectedOption }, locale),
      t('decision.authorityNotice', {}, locale)].join('\n') });
  } else {
    if (!context.outcomeDecision) throw ErrorRegistry.createError('DECISION_UNAVAILABLE');
    const command = decisionOutcomeCommandSchema.parse(input), result = await context.outcomeDecision(root, command, options);
    emit(result, { ...sinks, json: args.json, render: () => t('decision.outcomeRecorded', { id: command.decisionId, observedAt: command.outcome.observedAt }, locale) });
  }
}
