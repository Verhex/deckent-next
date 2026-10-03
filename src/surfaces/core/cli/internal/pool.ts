import { poolCapacityDrift, type PoolCapacity, type PoolDrift, type PoolWait } from '#engine/index.js';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { PoolCapacityCommand, PoolCapacityReceipt, PoolCapacityView, PoolHoldCommand, PoolHoldQuery, PoolHoldReceipt, PoolHoldView } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

export type PoolCapacityApplyHandler = (root: string, command: PoolCapacityCommand, options: ConfigLoadOptions) => Promise<PoolCapacityReceipt>;
export type PoolCapacityInspectHandler = (root: string, query: PoolHoldQuery, options: ConfigLoadOptions) => Promise<PoolCapacityView>;
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
  if (action !== 'status' && action !== 'hold' && action !== 'resume' && action !== 'set-capacity') throw usage();
  const allowed = action === 'set-capacity' ? ['--scope', '--pool', '--lang', '--command-id', '--execution-slots', '--in-flight-slots'] : action === 'status' ? ['--scope', '--pool', '--lang'] : ['--scope', '--pool', '--lang', '--command-id', '--reason'];
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
    const query = { schemaVersion: 1 as const, scopeId, ...(pool ? { poolId: pool } : {}) };
    const view = await context.inspectPoolHold(root, query, { env });
    const capacity = context.inspectPoolCapacity ? await context.inspectPoolCapacity(root, query, { env }) : undefined;
    emit({ ...view, ...(capacity ? { capacity } : {}) }, { ...sinks, render: result => [renderView(result, locale),
      ...(capacity ? [t('cli.pool.capacity', { pool: capacity.poolId, execution: capacity.capacity.executionSlots, inFlight: capacity.capacity.inFlightSlots,
        command: capacity.receipt?.commandId ?? '-', by: capacity.receipt ? `${capacity.receipt.actor.issuer}/${capacity.receipt.actor.subject}` : '-', at: capacity.receipt?.atMs ?? '-' }, locale)] : [])].join('\n') });
    return;
  }
  if (action === 'set-capacity') {
    const slots = (flag: string) => {
      const raw = values.get(flag), value = Number(raw);
      if (!raw || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) throw usage(flag);
      return value;
    };
    const capacity = { executionSlots: slots('--execution-slots'), inFlightSlots: slots('--in-flight-slots') };
    if (!context.applyPoolCapacity) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    emit(await context.applyPoolCapacity(root, { schemaVersion: 1, scopeId, commandId: values.get('--command-id') ?? randomUUID(),
      ...(pool ? { poolId: pool } : {}), capacity }, { env }), { ...sinks, render: receipt => t('cli.pool.capacityChanged', {
        pool: receipt.poolId, command: receipt.commandId, oldExecution: receipt.previous.executionSlots, oldInFlight: receipt.previous.inFlightSlots,
        execution: receipt.next.executionSlots, inFlight: receipt.next.inFlightSlots, changed: String(receipt.changed), by: `${receipt.actor.issuer}/${receipt.actor.subject}`, at: receipt.atMs }, locale) });
    return;
  }
  if (!context.applyPoolHold) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE'); const reason = values.get('--reason');
  emit(await context.applyPoolHold(root, { schemaVersion: 1, scopeId, commandId: values.get('--command-id') ?? randomUUID(), action,
    ...(pool ? { poolId: pool } : {}), ...(reason ? { reason } : {}) }, { env }), { ...sinks, render: receipt => renderReceipt(receipt, locale) });
}

/** Doctor uses the same scoped inspection contract; missing observation stays explicit. */
export async function assessPoolReadiness(root: string, context: CommandContext, options: ConfigLoadOptions, admission: (PoolCapacity & { poolId: string }) | null | undefined, scopeId?: string) {
  if (!admission) return { status: 'unconfigured' as const, drift: null };
  if (!scopeId || !context.inspectPoolCapacity) return { status: 'unavailable' as const, code: 'INVENTORY_UNAVAILABLE', drift: null };
  try {
    const view = await context.inspectPoolCapacity(root, { schemaVersion: 1, scopeId, poolId: admission.poolId }, options);
    const drift = poolCapacityDrift(view.poolId, admission, view.capacity, 'admission');
    return { status: drift ? 'drift' as const : 'ready' as const, drift, pool: view };
  } catch { return { status: 'unavailable' as const, code: 'INVENTORY_UNAVAILABLE', drift: null }; }
}

export function poolDriftLine(drift: PoolDrift, locale: Locale): string {
  const source = drift.source === 'run' ? t('cli.pool.source.run', {}, locale) : t('cli.pool.source.admission', {}, locale);
  return t('cli.pool.drift', { pool: drift.poolId, source, requestedExecution: drift.requested.executionSlots, requestedInFlight: drift.requested.inFlightSlots, execution: drift.capacity.executionSlots, inFlight: drift.capacity.inFlightSlots }, locale);
}
export function poolWaitLine(task: string, wait: PoolWait, locale: Locale): string {
  const reason = wait.code === 'pool-held' ? t('monitor.blocker.poolHeld', {}, locale) : t('monitor.blocker.waitingPoolSlot', {}, locale);
  return t('cli.pool.wait', { task, code: wait.code, reason, pool: wait.poolId, execution: wait.occupancy.execution, inFlight: wait.occupancy.inFlight, executionSlots: wait.effectiveCapacity.executionSlots, inFlightSlots: wait.effectiveCapacity.inFlightSlots }, locale);
}
export function poolReadinessLines(readiness: Awaited<ReturnType<typeof assessPoolReadiness>>, locale: Locale): string[] {
  const statuses = { ready: t('doctor.poolReadiness.status.ready', {}, locale), drift: t('doctor.poolReadiness.status.drift', {}, locale), unavailable: t('doctor.poolReadiness.status.unavailable', {}, locale), unconfigured: t('doctor.poolReadiness.status.unconfigured', {}, locale) };
  return [t('doctor.poolReadiness', { status: statuses[readiness.status], code: readiness.code ?? '-' }, locale), ...(readiness.drift ? [poolDriftLine(readiness.drift, locale)] : [])];
}
