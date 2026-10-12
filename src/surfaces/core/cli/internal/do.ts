import { randomUUID } from 'node:crypto';
import { brainPlanCommandSchema } from '#domain/index.js';
import { brainProposalLines } from '#surfaces/core/run-planning/index.js';
import { emit, loadConfig, resolveLocale, ErrorRegistry, type Locale } from '#platform/index.js';
import { cliUsage } from '#surfaces/core/cli-kit/index.js';
import type { CommandContext } from './kernel-commands.js';
export async function doCommand(argv: readonly string[], context: CommandContext, initialLocale: Locale = resolveLocale(undefined, context.env)) {
  const values = new Map<string, string>(); let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-color') continue;
    if (!['--request', '--scope', '--command-id', '--lang'].includes(arg) || values.has(arg)) throw cliUsage('do', undefined, initialLocale);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw cliUsage('do', undefined, initialLocale, arg);
    values.set(arg, value);
  }
  if (!context.planRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const locale = resolveLocale(values.get('--lang'), context.env, config.language); context.onLocale?.(locale);
  const scopeId = values.get('--scope') ?? (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  const intent = values.get('--request'); if (!scopeId || !intent) throw cliUsage('do', undefined, locale);
  const command = brainPlanCommandSchema.parse({ schemaVersion: 1, commandId: values.get('--command-id') ?? randomUUID(), scopeId, intent });
  const result = await context.planRun(root, command, options, context.signal);
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: value => brainProposalLines(value, locale).join('\n') });
}
