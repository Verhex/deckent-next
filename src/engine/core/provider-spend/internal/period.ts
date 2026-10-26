import { z } from 'zod';
import { counterSchema, providerSpendPeriodSchema, PROVIDER_SPEND_PERIOD_REGISTRY, identitySchema, RegistryError } from '#domain/index.js';
import type { ProviderSpendAccount } from './account.js';
import { canonicalProviderSpendExactMinorUnits, compareProviderSpendExactMinorUnits, subtractProviderSpendExactMinorUnits } from './exact.js';
import { ProviderSpendError } from './error.js';

const periodDefinitionSchema = z.object({ schemaVersion: z.literal(1), id: identitySchema, calendarMonths: counterSchema.positive() }).strict().readonly();
type PeriodDefinition = z.infer<typeof periodDefinitionSchema>;
/** Distribution registration is add-only data before composeCore seals; it never changes an existing period or grants a budget write. */
export class ProviderSpendPeriodRegistry {
  private readonly rows = new Map<string, PeriodDefinition>();
  private sealed = false;
  constructor(seed: readonly unknown[]) { for (const input of seed) { const row = periodDefinitionSchema.parse(input); this.rows.set(row.id, row); } }
  register(input: unknown): void {
    if (this.sealed) throw new RegistryError('REGISTRY_SEALED');
    const parsed = periodDefinitionSchema.safeParse(input);
    if (!parsed.success) throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    if (!parsed.data.id.includes('.') || parsed.data.id.startsWith('core.')) throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
    if (this.rows.has(parsed.data.id)) throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    this.rows.set(parsed.data.id, parsed.data);
  }
  get(id: string): PeriodDefinition {
    const row = this.rows.get(id);
    if (!row) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
    return row;
  }
  seal(): void { this.sealed = true; }
}
export const providerSpendPeriodRegistry = new ProviderSpendPeriodRegistry(PROVIDER_SPEND_PERIOD_REGISTRY.periods);
export function registerProviderSpendPeriod(input: unknown): void { providerSpendPeriodRegistry.register(input); }
const CALENDAR_MONTHS_PER_YEAR = 12;

export const PROVIDER_SPEND_PERIOD_ACCOUNT_VERSION = 3;
export const providerSpendPeriodStateSchema = z.object({ schemaVersion: z.literal(1), kind: providerSpendPeriodSchema, calendarMonths: counterSchema.positive(),
  startedAtMs: counterSchema, nextResetAtMs: counterSchema, timeZone: z.string().min(1).max(128),
  settledBaselineExactMinorUnits: z.string(), legacyTransition: z.boolean() }).strict().readonly();

/** Local midnight on the first of next month (calendar arithmetic, including DST). Never a fixed day count. */
function nextMonth(nowMs: number, kind: string): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const date = new Date(nowMs);
  const span = providerSpendPeriodRegistry.get(kind).calendarMonths;
  const currentMonth = date.getFullYear() * CALENDAR_MONTHS_PER_YEAR + date.getMonth();
  const nextMonthIndex = (Math.floor(currentMonth / span) + 1) * span;
  date.setDate(1); date.setHours(0, 0, 0, 0);
  date.setFullYear(Math.floor(nextMonthIndex / CALENDAR_MONTHS_PER_YEAR), nextMonthIndex % CALENDAR_MONTHS_PER_YEAR, 1);
  const next = date.getTime();
  if (!Number.isSafeInteger(next) || next <= nowMs) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return next;
}
/** Pins an existing cap until its first reset; no settled amount, reservation, freeze or budget authority is erased. */
export function initializeProviderSpendPeriod(account: ProviderSpendAccount, nowMs: number, legacyTransition = false): ProviderSpendAccount {
  if (account.period) return account;
  const kind = account.budget.period ?? PROVIDER_SPEND_PERIOD_REGISTRY.defaultPeriod;
  return { ...account, schemaVersion: PROVIDER_SPEND_PERIOD_ACCOUNT_VERSION, period: { schemaVersion: 1, kind, calendarMonths: providerSpendPeriodRegistry.get(kind).calendarMonths,
    startedAtMs: nowMs, nextResetAtMs: nextMonth(nowMs, kind), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    settledBaselineExactMinorUnits: '0', legacyTransition } };
}
/** Read-only projection, persisted by the existing transactional checkpoint writer. A timezone/clock change cannot advance a pinned reset. */
export function advanceProviderSpendPeriod(account: ProviderSpendAccount, nowMs: number): ProviderSpendAccount {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (!account.period || nowMs < account.period.nextResetAtMs) return account;
  return { ...account, period: { ...account.period, startedAtMs: account.period.nextResetAtMs, nextResetAtMs: nextMonth(nowMs, account.period.kind),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, settledBaselineExactMinorUnits: account.settledExactMinorUnits,
    legacyTransition: false } };
}
export function providerSpendPeriodUsedExact(account: ProviderSpendAccount): string {
  const definition = providerSpendPeriodRegistry.get(account.period?.kind ?? account.budget.period ?? PROVIDER_SPEND_PERIOD_REGISTRY.defaultPeriod);
  if (account.period && account.period.calendarMonths !== definition.calendarMonths) throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT');
  if (account.period && account.budget.period && account.period.kind !== account.budget.period) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  const baseline = account.period?.settledBaselineExactMinorUnits ?? '0';
  canonicalProviderSpendExactMinorUnits(baseline);
  if (compareProviderSpendExactMinorUnits(account.settledExactMinorUnits, baseline) < 0) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  return subtractProviderSpendExactMinorUnits(account.settledExactMinorUnits, baseline);
}
/** A historical settlement refund changes its historical baseline, never the current month's allowance. */
export function providerSpendPeriodAfterCorrection(account: ProviderSpendAccount, nextExact: string, settledAtMs: number | undefined) {
  if (!account.period || compareProviderSpendExactMinorUnits(nextExact, account.settledExactMinorUnits) >= 0) return account.period;
  if (settledAtMs === undefined || !Number.isSafeInteger(settledAtMs) || settledAtMs < 0) throw new ProviderSpendError('PROVIDER_SPEND_INVALID');
  if (settledAtMs >= account.period.startedAtMs) return account.period;
  const reduction = subtractProviderSpendExactMinorUnits(account.settledExactMinorUnits, nextExact);
  return { ...account.period, settledBaselineExactMinorUnits: subtractProviderSpendExactMinorUnits(account.period.settledBaselineExactMinorUnits, reduction) };
}
