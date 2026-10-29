import { ErrorRegistry, emit, loadConfig, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { RecoveryRolloutView } from '#domain/index.js';
import type { RecoveryPolicyCommand, RecoveryPolicyRow, RecoveryPolicyView, RecoveryReviewItem, RecoveryVerdictOutcome } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, cliTableStyle, renderCliTable, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { ApprovalCommandContext } from './context.js';
import { cardIo, sinksOf } from './io.js';
import { readScope } from './policy-summary.js';
import { toggleScope, toggleTitle } from './policy-toggle.js';

type Scoped = Readonly<{ schemaVersion: 1; scopeId: string }>;
/** alpha.56 recovery cards (composition-bound; every write is the person's, at their witnessed terminal). */
export interface RecoveryHandlers {
  inspectRollout(root: string, input: Scoped, options: ConfigLoadOptions): Promise<RecoveryRolloutView>;
  inspectPolicy(root: string, input: Scoped, options: ConfigLoadOptions): Promise<RecoveryPolicyView>;
  changePolicy(root: string, command: RecoveryPolicyCommand, options: ConfigLoadOptions): Promise<Readonly<{ status: 'applied' | 'current'; view: RecoveryPolicyView }>>;
  reviewPending(root: string, input: Scoped, options: ConfigLoadOptions): Promise<readonly RecoveryReviewItem[]>;
  reviewAnswer(root: string, input: Readonly<{ schemaVersion: 1; scopeId: string; caseId: string; detection: 'lost' | 'not-lost'; choice: RecoveryVerdictOutcome['choice'] }>,
    options: ConfigLoadOptions): Promise<RecoveryVerdictOutcome>;
}
type Action = 'fence-attempt' | 'hold-run' | 'stop-orphan' | 'restart-component' | 'alert-brain' | 'hand-to-human' | 'continue-new-attempt';
/** One literal key per recovery action (the lint-arch i18n rule); the record keeps the map complete by type. */
const actionWord = (id: string, l: Locale) => (({ 'fence-attempt': () => t('cli.policy.recovery.action.fence-attempt', {}, l),
  'hold-run': () => t('cli.policy.recovery.action.hold-run', {}, l), 'stop-orphan': () => t('cli.policy.recovery.action.stop-orphan', {}, l),
  'restart-component': () => t('cli.policy.recovery.action.restart-component', {}, l), 'alert-brain': () => t('cli.policy.recovery.action.alert-brain', {}, l),
  'hand-to-human': () => t('cli.policy.recovery.action.hand-to-human', {}, l), 'continue-new-attempt': () => t('cli.policy.recovery.action.continue-new-attempt', {}, l),
} satisfies Record<Action, () => string>) as Partial<Record<string, () => string>>)[id]?.() ?? id;
/** BeUser D-16: what a measured rule detects, in plain words (one literal key per Core rule id); an overlay rule without text keeps its id. */
const ruleWhen = (id: string, l: Locale) => (({ 'container-gone': () => t('cli.policy.recovery.when.container-gone', {}, l),
  'launcher-dead-orphan': () => t('cli.policy.recovery.when.launcher-dead-orphan', {}, l), 'launcher-dead-gone': () => t('cli.policy.recovery.when.launcher-dead-gone', {}, l),
}) as Partial<Record<string, () => string>>)[id]?.();
const rowWord = (row: RecoveryPolicyRow, l: Locale) => {
  if (row.kind === 'action') return actionWord(row.id, l);
  const when = ruleWhen(row.id.split('@')[0]!, l);
  return when ? t('cli.policy.recovery.rule.named', { when, rule: row.id }, l) : t('cli.policy.recovery.rule', { rule: row.id }, l);
};
const state = (row: RecoveryPolicyRow, l: Locale) => !row.available ? t('cli.policy.recovery.unavailable', {}, l) : row.managed === 'conflict' ? t('cli.policy.conflict', {}, l)
  : row.effective === 'allowed' ? t('cli.policy.on', {}, l) : t('cli.policy.off', {}, l);
const exits = (row: RecoveryPolicyRow, l: Locale) => row.exits === null ? '-' : row.exits ? t('recovery.rollout.met', {}, l) : t('recovery.rollout.unmet', {}, l);
function policyTable(view: RecoveryPolicyView, context: ApprovalCommandContext, l: Locale): string {
  return renderCliTable([{ header: t('cli.policy.column.label', {}, l), shrink: true }, { header: t('cli.policy.recovery.column.state', {}, l) },
    { header: t('cli.policy.recovery.column.exits', {}, l) }], view.rows.map(row => [rowWord(row, l), state(row, l), exits(row, l)]), cliTableStyle(context));
}
/** The rollout view in words: per measured rule its shadow cases since the last false alarm, the blind decision agreement, and the counterfactual note. */
export function recoveryRolloutText(view: RecoveryRolloutView, context: ApprovalCommandContext, l: Locale): string {
  const { decisions } = view, met = (value: boolean) => value ? t('recovery.rollout.met', {}, l) : t('recovery.rollout.unmet', {}, l);
  return [renderCliTable([{ header: t('recovery.rollout.column.rule', {}, l) }, { header: t('recovery.rollout.column.cases', {}, l) },
    { header: t('recovery.rollout.column.since', {}, l) }, { header: t('recovery.rollout.column.falsePositives', {}, l) }, { header: t('recovery.rollout.column.exits', {}, l) }],
  view.rules.map(rule => [`${rule.id}@${rule.version}`, rule.shadowCases, rule.sinceFalsePositive, rule.falsePositives, met(rule.met)]), cliTableStyle(context)),
  t('recovery.rollout.decisions', { decided: decisions.decided, agreements: decisions.agreements, perMille: decisions.perMille ?? '-', waiting: decisions.waiting, met: met(decisions.met) }, l),
  ...(view.complete ? [] : [t('recovery.rollout.incomplete', {}, l)]), t('recovery.rollout.note.counterfactual', {}, l), t('recovery.rollout.note.evidence', {}, l)].join('\n');
}
const person = (context: ApprovalCommandContext, json = false) => { if (cliMode(context, json).mode !== 'interactive') throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED'); };
const flags = (argv: readonly string[], from: number) => {
  const values: { json: boolean; scope?: string; lang?: string } = { json: false };
  for (let i = from; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !values.json) values.json = true;
    else if ((flag === '--scope' || flag === '--lang') && values[flag === '--scope' ? 'scope' : 'lang'] === undefined) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); values[flag === '--scope' ? 'scope' : 'lang'] = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  return values;
};

/**
 * `deckent policy recovery [--scope] [--json]` (alpha.56 G2 + G3, owner Q-A9): the lost-worker recovery rows — a standing grant per recovery action
 * and the promotion of each measured rule at its version — with on/off and their measured exits. On a person's terminal one row can be switched
 * (pick → card → apply); the card re-reads the view inside the change. Off a terminal (pipe, CI, agent, `TERM=dumb`, `--json`) it only reads.
 */
export async function policyRecoveryCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  const host = context.recovery; if (!host) throw ErrorRegistry.createError('CLI_USAGE');
  const values = flags(argv, 2), root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, locale = commandLocale(context, values.lang);
  const print = (text: string) => emit(text, sinksOf(context));
  if (values.json || cliMode(context, values.json).mode !== 'interactive') {
    const scope = await readScope(context, locale, values.scope, 'deckent policy recovery'), view = await host.inspectPolicy(root, { schemaVersion: 1, scopeId: scope.scopeId }, options);
    emit(view, { json: values.json, ...sinksOf(context), render: data => [scopeNotice(scope, locale), policyTable(data, context, locale)].join('\n') }); return;
  }
  const { ask } = cardIo(context, locale, (await loadConfig(root, options)).approvals.sessionTtlMs);
  const scope = await toggleScope(context, locale, values.scope, 'deckent policy recovery', ask); if (!scope) return;
  const view = await host.inspectPolicy(root, { schemaVersion: 1, scopeId: scope.scopeId }, options);
  print([scopeNotice(scope, locale), policyTable(view, context, locale), t('recovery.rollout.note.evidence', {}, locale)].join('\n'));
  const choices = view.rows.filter(row => row.managed !== 'conflict' && (row.available || row.managed === 'granted'));
  const picked = await ask({ title: t('cli.policy.recovery.pick', { scope: scope.scopeId }, locale), options: [...choices.map(row => ({ id: `${row.kind}:${row.id}`,
    label: `${rowWord(row, locale)} · ${state(row, locale)}` })), { id: '-leave', label: t('cli.policy.toggle.leave', {}, locale), key: 'q' }] });
  const row = choices.find(entry => `${entry.kind}:${entry.id}` === picked); if (!row) return;
  const action = row.managed === 'granted' ? 'revoke' : 'grant', what = rowWord(row, locale);
  const body = [action === 'grant' ? t('cli.policy.toggle.becomesOn', { what }, locale) : t('cli.policy.toggle.becomesOff', { what }, locale),
    t('cli.policy.recovery.scope', { scope: scope.scopeId }, locale),
    ...(action === 'grant' && row.exits === false ? [t('cli.policy.recovery.exitsUnmet', {}, locale)] : [])];
  if (await ask({ title: toggleTitle(action, what, locale), body, options: [{ id: 'apply', label: t('cli.policy.toggle.apply', {}, locale), role: 'yes' },
    { id: 'no', label: t('cli.policy.toggle.no', {}, locale), role: 'no' }] }) !== 'apply') return;
  const result = await host.changePolicy(root, { schemaVersion: 1, scopeId: scope.scopeId, kind: row.kind, id: row.id, action, expectedRevision: view.revision }, options);
  print([result.status === 'applied' ? t('cli.policy.recovery.applied', {}, locale) : t('cli.policy.recovery.current', {}, locale), policyTable(result.view, context, locale)].join('\n'));
}

/**
 * `deckent recovery [--scope] [--json]`: the read-only rollout view (counts only; a model's choice of an unreviewed case is never shown).
 * `deckent recovery review [--scope]`: the person's blind review card (owner Q-A5) — each model-decided case without its choice, then the person's
 * answer is sealed and only then the model's choice is shown. A person's terminal only.
 */
export async function recoveryCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  const host = context.recovery; if (!host) throw ErrorRegistry.createError('CLI_USAGE');
  const review = argv[1] === 'review', values = flags(argv, review ? 2 : 1), root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const locale = commandLocale(context, values.lang), print = (text: string) => emit(text, sinksOf(context));
  if (!review) {
    const scope = await readScope(context, locale, values.scope, 'deckent recovery'), view = await host.inspectRollout(root, { schemaVersion: 1, scopeId: scope.scopeId }, options);
    emit(view, { json: values.json, ...sinksOf(context), render: data => [scopeNotice(scope, locale), recoveryRolloutText(data, context, locale)].join('\n') }); return;
  }
  person(context, values.json);
  const { ask } = cardIo(context, locale, (await loadConfig(root, options)).approvals.sessionTtlMs);
  const scope = await toggleScope(context, locale, values.scope, 'deckent recovery review', ask); if (!scope) return;
  const items = await host.reviewPending(root, { schemaVersion: 1, scopeId: scope.scopeId }, options);
  print([scopeNotice(scope, locale), items.length ? t('recovery.review.pending', { count: items.length }, locale) : t('recovery.review.none', {}, locale)].join('\n'));
  const answers = { continue: ['lost', 'continue-new-attempt'], escalate: ['lost', 'escalate-human'], 'not-lost': ['not-lost', null] } as const;
  for (const item of items) {
    const body = [t('recovery.review.rule', { rule: item.rule ? `${item.rule.id}@${item.rule.version}` : '-', activity: item.activity ?? '-', launcher: item.launcher ?? '-' }, locale),
      t('recovery.review.gate', { result: item.gate.result, settled: item.gate.settled, intents: item.gate.intents }, locale),
      t('recovery.review.work', { run: item.runId, task: item.taskId, attempts: item.attempts ?? '-' }, locale), ...(item.wouldStop ? [t('recovery.review.wouldStop', {}, locale)] : [])];
    const answer = await ask({ title: t('recovery.review.title', { case: item.caseId.slice(0, 12) }, locale), body, options: [
      { id: 'continue', label: t('recovery.review.choice.continue', {}, locale), key: 'c' }, { id: 'escalate', label: t('recovery.review.choice.escalate', {}, locale), key: 'p' },
      { id: 'not-lost', label: t('recovery.review.choice.notLost', {}, locale), key: 'n' }, { id: 'skip', label: t('recovery.review.choice.skip', {}, locale), key: 's' },
      { id: 'stop', label: t('recovery.review.choice.stop', {}, locale), key: 'q' }] });
    if (answer === null || answer === 'stop') return;
    if (answer === 'skip' || !(answer in answers)) continue;
    const [detection, choice] = answers[answer as keyof typeof answers];
    const outcome = await host.reviewAnswer(root, { schemaVersion: 1, scopeId: scope.scopeId, caseId: item.caseId, detection, choice }, options);
    print(t('recovery.review.reveal', { model: actionWord(outcome.model.action, locale), verdict: outcome.agreed === null ? t('recovery.review.verdict.notLost', {}, locale)
      : outcome.agreed ? t('recovery.review.verdict.agreed', {}, locale) : t('recovery.review.verdict.disagreed', {}, locale) }, locale));
  }
}
