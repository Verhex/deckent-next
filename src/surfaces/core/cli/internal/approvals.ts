import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t } from '#platform/index.js';
import { readJsonInput } from './json-input.js';
import type { CommandContext } from './kernel-commands.js';
export async function approvalsCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1]; let source: string | undefined; let language: string | undefined; let json = false;
  const help = argv.length === 2 && (action === '--help' || action === '-h');
  if (!help && action !== 'list' && action !== 'inspect' && action !== 'decide' && action !== 'renew') throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]; if (flag === '--json' && !json) { json = true; continue; }
    if (flag !== '--input' && flag !== '--lang') throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    if (flag === '--input' && source === undefined) source = value;
    else if (flag === '--lang' && language === undefined) language = value;
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const locale = resolveLocale(language, context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (help) { emit(t('cli.approval.help', {}, locale), sinks); return; }
  const handler = action === 'renew' ? context.renewApproval : action === 'list' ? context.listApprovals : action === 'inspect' ? context.inspectApproval : context.decideApproval;
  if (!source || !handler) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(); const config = await loadConfig(root, { env: context.env ?? process.env });
  const input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  const result = await handler(input);
  emit(result, { ...sinks, json, render: value => JSON.stringify(value, null, 2) });
}
