import { z } from 'zod';
import { advanceProviderSpendPeriod, providerSpendPeriodUsedExact } from './period.js';
import { ceilProviderSpendExactMinorUnits } from './exact.js';
import { nativeCliIdSchema, NATIVE_CLI_HEADLESS_ADAPTER_ID, type ModelInvocationBillingAxis, type ModelInvocationProfile, type ExecutionProfileDefinition } from '#domain/index.js';
import { providerSpendEvidenceDigest, createProviderSpendAccount, parseProviderSpendAccount, type ProviderSpendAccount } from './account.js';
import { createProviderSpendCheckpoint } from './checkpoint.js';
import type { ProviderSpendBudget } from '#domain/index.js';
import { providerSpendLocalZeroTariffProfile } from './no-charge.js';
import { isNativeCliWorkerProfile, readNativeCliWorkerParameters } from '#capabilities/index.js';
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type WorkSpending = 'metered' | 'not-metered';
const subscription = z.looseObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), provider: nativeCliIdSchema });
/** Trusted selected bindings only; never a model-authored billing claim. Unknown bindings stay metered. */
export function classifyWorkSpending(input: Readonly<{ kind: 'model'; profile: ModelInvocationProfile | null }>
  | Readonly<{ kind: 'worker'; profile: ExecutionProfileDefinition | null }>): WorkSpending {
  if (!input.profile) return 'metered';
  if (input.kind === 'worker') return workerBillingAxis(input.profile) === null ? 'metered' : 'not-metered';
  return modelInvocationBillingAxis(input.profile) === 'metered' ? 'metered' : 'not-metered';
}

export function workSpendingBasis(profiles: readonly (ExecutionProfileDefinition | null)[]) {
  return { semantics: profiles.every(profile => classifyWorkSpending({ kind: 'worker', profile }) === 'not-metered') ? 'not-metered' as const : 'metered' as const,
    digest: providerSpendEvidenceDigest({ schemaVersion: 1, profiles }) };
}
/** A caller's observed usage preserves its period timestamp or fractional display; otherwise derive current rounded usage. */
export function providerSpendRemaining(checkpoint: Readonly<{ account: Readonly<{ budget: ProviderSpendBudget; reservedMinorUnits: number; settledMinorUnits: number; frozen: boolean; schemaVersion?: ProviderSpendAccount['schemaVersion']; settledExactMinorUnits?: string; period?: ProviderSpendAccount['period'] }> }> | null, usedMinorUnits?: number) {
  const raw = checkpoint?.account;
  if (!raw) return null;
  const periodic = raw.period && usedMinorUnits === undefined ? advanceProviderSpendPeriod(parseProviderSpendAccount(raw), Date.now()) : null;
  const account = periodic ?? raw, used = usedMinorUnits ?? (periodic ? ceilProviderSpendExactMinorUnits(providerSpendPeriodUsedExact(periodic)) : raw.settledMinorUnits);
  return Object.freeze({ currency: account.budget.currency, limitMinorUnits: account.budget.limitMinorUnits, frozen: account.frozen,
    remainingMinorUnits: Math.max(0, account.budget.limitMinorUnits - used - account.reservedMinorUnits) });
}
/** Initial account projection only; this creates neither a ledger account nor a reservation. */
export function configuredProviderSpendCheckpoint(budget: ProviderSpendBudget) {
  return createProviderSpendCheckpoint(createProviderSpendAccount(budget), 1, 0);
}

/** Compatibility classification never rewrites historical v1 profiles or their digest. */
export function modelInvocationBillingAxis(profile: ModelInvocationProfile): ModelInvocationBillingAxis {
  return profile.schemaVersion !== 1 ? profile.billingAxis : providerSpendLocalZeroTariffProfile(profile) ? 'local' : 'metered';
}
/** Owner B1-11: isolation decisions (shell host refusal, MCP tool scope) count a subscription profile and every native headless profile, v1
 * included, as a subscription. Billing stays on its own axis above, where a v1 headless profile is metered. */
export const isolatesAsSubscription = (profile: ModelInvocationProfile) => (profile.schemaVersion !== 1 && profile.billingAxis === 'subscription') || profile.adapter.id === NATIVE_CLI_HEADLESS_ADAPTER_ID;

/** Unknown worker bindings stay conservatively metered at admission; observation must not claim an API charge. A profile without a
 * subscription binding is local only by its explicit typed declaration (`billingAxis: 'local'`, e.g. a Docker verify task with no
 * provider connection), never by its name or adapter (owner 2026-10-17, Jev d8b2a0ce); the installed adapter refuses the declaration
 * beside a subscription binding. */
export function workerBillingAxis(profile: ExecutionProfileDefinition): ModelInvocationBillingAxis | null {
  // R9d: a connected CLI worker (`--connection`) wraps its base profile; the subscription binding is the base's. An invalid wrapper stays metered.
  const parameters = isNativeCliWorkerProfile(profile) ? readNativeCliWorkerParameters(profile)?.base.parameters ?? null : profile.parameters;
  if (!parameters) return null;
  if (subscription.safeParse(parameters['nativeSubscription']).success) return 'subscription';
  return parameters['billingAxis'] === 'local' ? 'local' : null;
}
