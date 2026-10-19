import { poolCapacityDrift, type PoolCapacity, type PoolDrift, type PoolWait } from '#engine/index.js';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, EXIT_CODES, emit, getSystemProfile, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import type { QuotaReleaseCommand, QuotaReleaseReceipt, PoolCapacityCommand, PoolCapacityReceipt, PoolCapacityView, PoolHoldCommand, PoolHoldQuery, PoolHoldReceipt, PoolHoldView } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { formatAgo, resolveCommandScope, scopeLister, scopeNotice, type CliCardOption } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminInteractive, adminSinks, askAdminCard, confirmOptions, reportCancelled } from './io.js';

export type QuotaReleaseHandler = (root: string, command: QuotaReleaseCommand, options: ConfigLoadOptions) => Promise<QuotaReleaseReceipt>;
export type PoolCapacityApplyHandler = (root: string, command: PoolCapacityCommand, options: ConfigLoadOptions) => Promise<PoolCapacityReceipt>;
export type PoolCapacityInspectHandler = (root: string, query: PoolHoldQuery, options: ConfigLoadOptions) => Promise<PoolCapacityView>;
export type PoolHoldApplyHandler = (root: string, command: PoolHoldCommand, options: ConfigLoadOptions) => Promise<PoolHoldReceipt>;
export type PoolHoldInspectHandler = (root: string, query: PoolHoldQuery, options: ConfigLoadOptions) => Promise<PoolHoldView>;

const actorText = (actor: Readonly<{ issuer: string; subject: string }>) => terminalSafeText(`${actor.issuer}/${actor.subject}`);
/** Owner CLI review 2026-10-19 (`pool`): the status in human words; empty fields are left out, never printed as `-`. */
function renderStatus(view: PoolHoldView, capacity: PoolCapacityView | undefined, locale: Locale, nowMs: number): string {
  const pool = terminalSafeText(view.poolId), held = view.state === 'held';
  const lines = [held ? t('cli.pool.view.held', { pool }, locale) : t('cli.pool.view.open', { pool }, locale)];
  if (held && view.hold) {
    lines.push(t('cli.pool.view.heldBy', { by: actorText(view.hold.changedBy), ago: formatAgo(view.hold.changedAtMs, nowMs, locale) }, locale));
    if (view.hold.reason) lines.push(t('cli.pool.view.reason', { reason: terminalSafeText(view.hold.reason) }, locale));
  }
  // Occupancy: `execution` = reserved or running; `inFlight` also counts the tasks being evaluated.
  lines.push(t('cli.pool.view.now', { running: view.occupancy.execution, evaluating: Math.max(0, view.occupancy.inFlight - view.occupancy.execution) }, locale));
  if (view.drained) lines.push(t('cli.pool.view.drained', {}, locale));
  if (capacity) {
    const slots = capacity.capacity, recommended = getSystemProfile().recommendedMaxWorkers;
    lines.push(slots.inFlightSlots === slots.executionSlots ? t('cli.pool.view.capacity', { slots: slots.executionSlots, recommended }, locale)
      : t('cli.pool.view.capacityEvaluating', { slots: slots.executionSlots, inFlight: slots.inFlightSlots, recommended }, locale));
    if (capacity.receipt) lines.push(t('cli.pool.view.capacityChanged', { by: actorText(capacity.receipt.actor), ago: formatAgo(capacity.receipt.atMs, nowMs, locale) }, locale));
  }
  return lines.join('\n');
}
function renderReceipt(receipt: PoolHoldReceipt, locale: Locale): string {
  const params = { pool: terminalSafeText(receipt.poolId), state: receipt.state === 'held' ? t('cli.pool.state.held', {}, locale) : t('cli.pool.state.open', {}, locale) };
  return receipt.changed ? t('cli.pool.changed', params, locale) : t('cli.pool.unchanged', params, locale);
}
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  'quota-release': ['--scope', '--pool', '--lang', '--command-id', '--channel'], 'set-capacity': ['--scope', '--pool', '--lang', '--command-id', '--execution-slots', '--in-flight-slots'],
  status: ['--scope', '--pool', '--lang'], hold: ['--scope', '--pool', '--lang', '--command-id', '--reason'], resume: ['--scope', '--pool', '--lang', '--command-id', '--reason'],
};
/** The reasons a person picks on a terminal (values only by selection, owner 2026-10-08); the recorded reason is the chosen sentence. */
const reasons = (locale: Locale) => ({ maintenance: t('cli.pool.reason.maintenance', {}, locale), problem: t('cli.pool.reason.problem', {}, locale),
  cost: t('cli.pool.reason.cost', {}, locale) });

/**
 * `deckent pool status|hold|resume|set-capacity|quota-release [--scope <id>] [--pool <id>] …` (K5 typed pool hold): the same application as SDK
 * and MCP. `--pool` defaults to the installation's admission pool. Owner CLI review 2026-10-19: `status` reads the configured scope and says so;
 * a change never takes a silent default — off a terminal `--scope` is required (CLI_SCOPE_REQUIRED, exit 2, nothing written); a person on a
 * terminal picks the scope and confirms what changes, on which pool and why on a card; `set-capacity` values come from preset options there.
 */
export async function poolCommand(argv: readonly string[], context: AdminCommandContext): Promise<void | ExitCode> {
  const action = argv[1], env = context.env ?? process.env;
  const early = commandLocale(context, argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : undefined);
  const usage = (flag?: string) => ErrorRegistry.createError('CLI_USAGE', { params: { command: 'deckent pool', usage: t('cli.help.pool', {}, early), ...(flag ? { flag } : {}) } });
  if (action !== 'status' && action !== 'hold' && action !== 'resume' && action !== 'set-capacity' && action !== 'quota-release') throw usage();
  const allowed = FLAGS[action]!;
  const values = new Map<string, string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-color') continue;
    if (!allowed.includes(arg) || values.has(arg)) throw usage(arg);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(arg); values.set(arg, value);
  }
  const root = context.root ?? process.cwd(), locale = commandLocale(context, values.get('--lang')), options = { env };
  const configured = await loadConfig(root, options).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const interactive = adminInteractive(context, json);
  const scope = await resolveCommandScope({ command: `deckent pool ${action}`, locale, explicit: values.get('--scope'), configured: typeof configured === 'string' ? configured : undefined,
    mutating: action !== 'status', interactive, listScopes: () => scopeLister(context, root, options)().catch(() => []), pick: request => askAdminCard(context, locale, request) });
  if (!scope) { reportCancelled(context, locale); return EXIT_CODES.error; }
  const scopeId = scope.scopeId, pool = values.get('--pool'), sinks = { json, ...adminSinks(context) };
  const notice = () => { if (!json) emit(scopeNotice(scope, locale), adminSinks(context)); };
  if (action === 'status') {
    if (!context.inspectPoolHold) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const query = { schemaVersion: 1 as const, scopeId, ...(pool ? { poolId: pool } : {}) };
    const view = await context.inspectPoolHold(root, query, options);
    const capacity = context.inspectPoolCapacity ? await context.inspectPoolCapacity(root, query, options) : undefined;
    notice();
    emit({ ...view, ...(capacity ? { capacity } : {}) }, { ...sinks, render: () => renderStatus(view, capacity, locale, Date.now()) });
    return;
  }
  const poolLabel = pool ? terminalSafeText(pool) : t('cli.pool.card.defaultPool', {}, locale);
  // A person on a terminal confirms what changes, on which pool and why; anyone else already named the scope and is never asked.
  const confirmed = async (title: string, body: readonly string[]) => !interactive || await askAdminCard(context, locale, { title,
    body: [t('cli.pool.card.where', { scope: terminalSafeText(scopeId), pool: poolLabel }, locale), ...body], options: confirmOptions(locale) }) === 'apply';
  const cancelled = () => { reportCancelled(context, locale); return EXIT_CODES.error; };
  const commandId = values.get('--command-id') ?? randomUUID();
  if (action === 'quota-release') {
    const channelId = values.get('--channel'); if (!channelId) throw usage('--channel');
    if (!context.releaseQuota) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    if (!await confirmed(t('cli.pool.card.quotaRelease', { channel: terminalSafeText(channelId) }, locale), [t('cli.pool.card.quotaReleaseWhat', {}, locale)])) return cancelled();
    notice();
    emit(await context.releaseQuota(root, { schemaVersion: 1, scopeId, commandId, channelId, ...(pool ? { poolId: pool } : {}) }, options), { ...sinks,
      render: receipt => t('cli.pool.quotaReleased', { channel: terminalSafeText(receipt.channelId), released: receipt.released }, locale) });
    return;
  }
  if (action === 'set-capacity') {
    if (!context.applyPoolCapacity) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const slots = (flag: string) => {
      const raw = values.get(flag), value = Number(raw);
      if (!raw || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) throw usage(flag);
      return value;
    };
    let execution: number, inFlight: number;
    if (!interactive || (values.has('--execution-slots') && values.has('--in-flight-slots'))) { execution = slots('--execution-slots'); inFlight = slots('--in-flight-slots'); }
    else {
      const current = context.inspectPoolCapacity ? await context.inspectPoolCapacity(root, { schemaVersion: 1, scopeId, ...(pool ? { poolId: pool } : {}) }, options).catch(() => undefined) : undefined;
      const picked = values.has('--execution-slots') ? slots('--execution-slots') : await pickSlots(context, locale, current?.capacity.executionSlots);
      if (picked === null) return cancelled();
      execution = picked; inFlight = values.has('--in-flight-slots') ? slots('--in-flight-slots') : Math.max(picked, current?.capacity.inFlightSlots ?? picked);
    }
    if (!await confirmed(t('cli.pool.card.setCapacity', { slots: execution, inFlight }, locale), [t('cli.pool.card.setCapacityWhat', {}, locale)])) return cancelled();
    notice();
    emit(await context.applyPoolCapacity(root, { schemaVersion: 1, scopeId, commandId, ...(pool ? { poolId: pool } : {}), capacity: { executionSlots: execution, inFlightSlots: inFlight } }, options),
      { ...sinks, render: receipt => receipt.changed ? t('cli.pool.capacityChanged', { pool: terminalSafeText(receipt.poolId), oldExecution: receipt.previous.executionSlots,
        oldInFlight: receipt.previous.inFlightSlots, execution: receipt.next.executionSlots, inFlight: receipt.next.inFlightSlots }, locale)
        : t('cli.pool.capacityUnchanged', { pool: terminalSafeText(receipt.poolId), execution: receipt.next.executionSlots, inFlight: receipt.next.inFlightSlots }, locale) });
    return;
  }
  if (!context.applyPoolHold) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  let reason = values.get('--reason');
  if (interactive && action === 'hold' && !reason) {
    const presets: Readonly<Record<string, string>> = reasons(locale);
    const picked = await askAdminCard(context, locale, { title: t('cli.pool.card.reasonTitle', { pool: poolLabel }, locale),
      options: [...Object.entries(presets).map(([id, label]) => ({ id, label })), { id: 'none', label: t('cli.pool.reason.none', {}, locale) }] });
    if (picked === null) return cancelled();
    reason = Object.hasOwn(presets, picked) ? presets[picked] : undefined;
  }
  if (!await confirmed(action === 'hold' ? t('cli.pool.card.hold', {}, locale) : t('cli.pool.card.resume', {}, locale),
    [action === 'hold' ? t('cli.pool.card.holdWhat', {}, locale) : t('cli.pool.card.resumeWhat', {}, locale),
      reason ? t('cli.pool.view.reason', { reason: terminalSafeText(reason) }, locale) : t('cli.pool.card.noReason', {}, locale)])) return cancelled();
  notice();
  emit(await context.applyPoolHold(root, { schemaVersion: 1, scopeId, commandId, action, ...(pool ? { poolId: pool } : {}), ...(reason ? { reason } : {}) }, options),
    { ...sinks, render: receipt => renderReceipt(receipt, locale) });
}

/** The execution-slot choice: presets, the current value and this machine's recommendation, ascending; the current one preselected. */
async function pickSlots(context: AdminCommandContext, locale: Locale, current: number | undefined): Promise<number | null> {
  const recommended = getSystemProfile().recommendedMaxWorkers;
  const choices = [...new Set([1, 2, 4, 8, recommended, ...(current ? [current] : [])])].filter(value => value >= 1).sort((a, b) => a - b);
  const options: CliCardOption[] = choices.map(value => ({ id: String(value), label: [t('cli.pool.slots', { n: value }, locale),
    ...(value === current ? [t('cli.pool.slots.current', {}, locale)] : []), ...(value === recommended ? [t('cli.pool.slots.recommended', {}, locale)] : [])].join(' ') }));
  const picked = await askAdminCard(context, locale, { title: t('cli.pool.card.slotsTitle', {}, locale), options, ...(current ? { initial: String(current) } : {}) });
  return picked === null ? null : Number(picked);
}

/** Doctor uses the same scoped inspection contract; missing observation stays explicit. */
export async function assessPoolReadiness(root: string, context: AdminCommandContext, options: ConfigLoadOptions, admission: (PoolCapacity & { poolId: string }) | null | undefined, scopeId?: string) {
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
