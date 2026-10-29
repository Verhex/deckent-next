import { delegationWords } from '#surfaces/core/work-labels/index.js';
import { ErrorRegistry, emit, loadConfig, t } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, cliTableStyle, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { ApprovalCommandContext } from './context.js';
import { cardIo, sinksOf } from './io.js';
import { delegationCardLines, delegationTable, toggleDelegations, toggleTitle } from './policy-toggle.js';
import { readScope } from './policy-summary.js';

/**
 * `deckent policy delegations [--scope]`: the AI steps of the scope with on/off (the default scope named); on a person's terminal one can be
 * switched (pick → preview card → apply). `delegate`/`undelegate --scope --step`: the explicit form, answered on the same card; off a
 * terminal the change itself refuses (`APPROVAL_INTERACTIVE_REQUIRED`). Every change is the existing governed delegation change.
 */
export async function policyDelegationsCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  const action = argv[1], host = context.delegations;
  if (!host || !['delegations', 'delegate', 'undelegate'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  const values: Record<string, string> = {}; let json = false;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) json = true;
    else if (['--scope', '--step', '--actor', '--resource', '--lang'].includes(flag) && !values[flag]) {
      const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); values[flag] = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if ((action !== 'delegations' && !values['--scope']) || (values['--actor'] && values['--actor'] !== 'mcp') || (action === 'delegations' ? !!values['--step'] : !values['--step'])) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env }, config = await loadConfig(root, { ...options, heal: false });
  const locale = commandLocale(context, values['--lang']), words = delegationWords(locale), sinks = { json, ...sinksOf(context) };
  if (action === 'delegations' && !values['--resource'] && cliMode(context, json).mode === 'interactive') return toggleDelegations(context, locale, values['--scope'], config.approvals.sessionTtlMs);
  const scope = action === 'delegations' ? await readScope(context, locale, values['--scope'], 'deckent policy delegations') : { scopeId: values['--scope']!, source: 'flag' as const };
  const query = { schemaVersion: 1 as const, scopeId: scope.scopeId, actor: 'mcp' as const, ...(values['--resource'] ? { resourceId: values['--resource'] } : {}) };
  const view = await host.inspect(root, query, options);
  if (action === 'delegations') { emit(view, { ...sinks, render: data => [scopeNotice(scope, locale), delegationTable(data, locale, cliTableStyle(context))].join('\n') }); return; }
  const step = values['--step']!;
  if (!view.steps.some(row => row.step.id === step)) throw ErrorRegistry.createError('POLICY_DELEGATION_STEP_INVALID');
  const verb = action === 'delegate' ? 'grant' : 'revoke', { ask } = cardIo(context, locale, config.approvals.sessionTtlMs);
  // The card shows the view the change re-read (what is applied), never the earlier one; off a terminal nothing is asked.
  const result = await host.change(root, { ...query, step, action: verb, expectedRevision: view.revision }, async reviewed => {
    if (cliMode(context).mode !== 'interactive') throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
    return await ask({ title: toggleTitle(verb, words.step[step] ?? step, locale), body: delegationCardLines(reviewed, step, verb, locale),
      options: [{ id: 'apply', label: t('cli.policy.toggle.apply', {}, locale), role: 'yes' }, { id: 'no', label: t('cli.policy.toggle.no', {}, locale), role: 'no' }] }) === 'apply';
  }, options);
  emit(result, { ...sinks, render: data => [words.result[data.status], delegationTable(data.view, locale, cliTableStyle(context))].join('\n') });
}
