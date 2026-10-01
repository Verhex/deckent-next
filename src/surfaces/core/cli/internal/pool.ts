import { randomUUID } from 'node:crypto';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { PoolHoldCommand, PoolHoldQuery, PoolHoldReceipt, PoolHoldView } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

export type PoolHoldApplyHandler = (root: string, command: PoolHoldCommand, options: ConfigLoadOptions) => Promise<PoolHoldReceipt>;
export type PoolHoldInspectHandler = (root: string, query: PoolHoldQuery, options: ConfigLoadOptions) => Promise<PoolHoldView>;

function renderView(view: PoolHoldView, locale: Locale): string {
  const by = view.hold ? `${view.hold.changedBy.issuer}/${view.hold.changedBy.subject}` : '-';
  return [t('cli.pool.status', { pool: view.poolId, state: view.state, revision: view.hold?.revision ?? 0, by,
    at: view.hold ? new Date(view.hold.changedAtMs).toISOString() : '-', reason: view.hold?.reason ?? '-' }, locale),
  t('cli.pool.occupancy', { execution: view.occupancy.execution, inFlight: view.occupancy.inFlight, drained: String(view.drained) }, locale)].join('\n');
}
function renderReceipt(receipt: PoolHoldReceipt, locale: Locale): string {
  const params = { pool: receipt.poolId, state: receipt.state, command: receipt.commandId };
  return receipt.changed ? t('cli.pool.changed', params, locale) : t('cli.pool.unchanged', params, locale);
}

/**
 * `deckent pool status|hold|resume [--scope <id>] [--pool <id>] [--command-id <id>] [--reason <text>] [--json] [--lang en|tr]` (K5 typed
 * pool hold): the same application as SDK `applyPoolHold` / `inspectPoolHold` and MCP. `--pool` defaults to the installation's admission
 * pool, `--scope` to `terminal.scopeId`; a hold/resume without `--command-id` is a new command (a repeat is an idempotent no-op anyway).
 */
export async function poolCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1], env = context.env ?? process.env;
  const usage = (flag?: string) => ErrorRegistry.createError('CLI_USAGE', { params: { command: 'deckent pool', usage: t('cli.help.pool', {}, resolveLocale(undefined, env)),
    ...(flag ? { flag } : {}) } });
  if (action !== 'status' && action !== 'hold' && action !== 'resume') throw usage();
  const allowed = action === 'status' ? ['--scope', '--pool', '--lang'] : ['--scope', '--pool', '--lang', '--command-id', '--reason'];
  const values = new Map<string, string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-color') continue;
    if (!allowed.includes(arg) || values.has(arg)) throw usage(arg);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(arg); values.set(arg, value);
  }
  const root = context.root ?? process.cwd(), locale = resolveLocale(values.get('--lang'), env); context.onLocale?.(locale);
  const scopeId = values.get('--scope') ?? ((await loadConfig(root, { env }))['terminal'] as { scopeId?: unknown } | undefined)?.scopeId;
  if (typeof scopeId !== 'string' || !scopeId) throw ErrorRegistry.createError('TERMINAL_SCOPE_REQUIRED');
  const pool = values.get('--pool'), sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (action === 'status') {
    if (!context.inspectPoolHold) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    emit(await context.inspectPoolHold(root, { schemaVersion: 1, scopeId, ...(pool ? { poolId: pool } : {}) }, { env }), { ...sinks, render: view => renderView(view, locale) });
    return;
  }
  if (!context.applyPoolHold) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE'); const reason = values.get('--reason');
  emit(await context.applyPoolHold(root, { schemaVersion: 1, scopeId, commandId: values.get('--command-id') ?? randomUUID(), action,
    ...(pool ? { poolId: pool } : {}), ...(reason ? { reason } : {}) }, { env }), { ...sinks, render: receipt => renderReceipt(receipt, locale) });
}
