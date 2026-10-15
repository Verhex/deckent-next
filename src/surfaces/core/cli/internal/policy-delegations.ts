import { createInterface } from 'node:readline/promises';
import { delegationLines, delegationWords } from '#surfaces/core/work-labels/index.js';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t } from '#platform/index.js';
import type { CommandContext } from './kernel-commands.js';

export async function policyDelegationsCommand(argv: readonly string[], context: CommandContext): Promise<void> {
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
  if (!values['--scope'] || (values['--actor'] && values['--actor'] !== 'mcp') || (action === 'delegations' ? !!values['--step'] : !values['--step'])) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env }, config = await loadConfig(root, { ...options, heal: false });
  const locale = resolveLocale(values['--lang'], env, config.language), words = delegationWords(locale); context.onLocale?.(locale);
  const query = { schemaVersion: 1 as const, scopeId: values['--scope']!, actor: 'mcp' as const, ...(values['--resource'] ? { resourceId: values['--resource'] } : {}) };
  const view = await host.inspect(root, query, options);
  const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === 'delegations') { emit(view, { ...sinks, render: data => delegationLines(data, locale).join('\n') }); return; }
  const step = values['--step']!;
  if (!view.steps.some(row => row.step.id === step)) throw ErrorRegistry.createError('POLICY_DELEGATION_STEP_INVALID');
  const stdin = context.stdin ?? process.stdin;
  const result = await host.change(root, { ...query, step, action: action === 'delegate' ? 'grant' : 'revoke', expectedRevision: view.revision }, async reviewed => {
    if (!stdin.isTTY) throw ErrorRegistry.createError('APPROVAL_INTERACTIVE_REQUIRED');
    const rl = createInterface({ input: stdin, output: process.stderr });
    try { return /^y(es)?$/iu.test((await rl.question([...delegationLines(reviewed, locale), t('policy.delegate.confirm', { step,
      action: words.action[action === 'delegate' ? 'grant' : 'revoke'] }, locale)].join('\n'))).trim()); }
    finally { rl.close(); }
  }, options);
  emit(result, { ...sinks, render: data => [words.result[data.status], ...delegationLines(data.view, locale)].join('\n') });
}
