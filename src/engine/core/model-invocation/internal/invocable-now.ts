import type { ModelActivationRecord, ModelBindingDefinition, ModelInvocationProfile, ModelReference } from '#domain/index.js';
import type { ModelInvocationDelivery } from './delivery.js';
import type { ModelInvocationDeliverySurface } from './profile-delivery.js';
import { assessModelInvocationProfileDeliveries } from './profile-delivery.js';

export type ModelInvocabilityReasonKind = 'stale-activation' | 'not-carried' | 'binding' | 'profile' | 'delivery-unfit'
  | 'no-credential' | 'tariff' | 'budget' | 'policy' | 'protocol' | 'unavailable';
/** `reservation`: PROVIDER-ERRORS N01 — the refused call's own required reservation in its budget's minor units and currency; never account totals. */
export interface ModelInvocabilityReason { readonly kind: ModelInvocabilityReasonKind; readonly code: string; readonly activationRevision?: number;
  readonly reservation?: Readonly<{ requestedMinorUnits: number; currency: string }> }
export type ModelInvocability = Readonly<{ invocable: true; reason: null }> | Readonly<{ invocable: false; reason: ModelInvocabilityReason }>;
export interface InvocableModel {
  readonly reference: ModelReference; readonly label: string; readonly nativeId: string;
  readonly catalogRevision: string; readonly bindingDigest: string; readonly availability: ModelInvocability;
}
export interface InvocableModels { readonly schemaVersion: 1; readonly scopeId: string; readonly models: readonly InvocableModel[] }
export interface ModelInvocableNowChecks {
  readonly surfaces: readonly (readonly [ModelInvocationDeliverySurface, ModelInvocationDelivery])[];
  credentialPresent(profile: ModelInvocationProfile): Promise<boolean>;
}
class InvocabilityRefusal extends Error {
  constructor(readonly reason: ModelInvocabilityReason) { super(reason.code); }
}
export function refuseInactiveModel(activation: ModelActivationRecord | null): never {
  throw new InvocabilityRefusal({ kind: 'not-carried', code: 'MODEL_INVOCATION_ACTIVATION_CONFLICT', activationRevision: activation?.revision ?? 0 });
}
/** Pure delivery/current-activation gates plus the composition-owned credential existence port. No activation repair. */
export async function assertModelInvocableNow(activation: ModelActivationRecord, profile: ModelInvocationProfile,
  definition: ModelBindingDefinition, catalogRevision: string, checks: ModelInvocableNowChecks): Promise<void> {
  if (activation.catalogRevision !== catalogRevision) throw new InvocabilityRefusal({ kind: 'stale-activation', code: 'MODEL_INVOCATION_ACTIVATION_CONFLICT', activationRevision: activation.revision });
  if (assessModelInvocationProfileDeliveries([{ profile, definition, catalogRevision }], checks.surfaces).length)
    throw new InvocabilityRefusal({ kind: 'delivery-unfit', code: 'MODEL_INVOCATION_RESULT_LIMIT' });
  if (!await checks.credentialPresent(profile)) throw new InvocabilityRefusal({ kind: 'no-credential', code: 'MODEL_INVOCATION_CREDENTIAL_UNAVAILABLE' });
}
/** Only typed codes cross the read boundary; backend error text, URLs and credentials never do. */
export function modelInvocabilityRefusal(error: unknown): ModelInvocability {
  if (error instanceof InvocabilityRefusal) return { invocable: false, reason: error.reason };
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(raw) ? raw : 'MODEL_INVOCATION_UNAVAILABLE';
  const kind: ModelInvocabilityReasonKind = code === 'MODEL_INVOCATION_ACTIVATION_CONFLICT' ? 'not-carried'
    : code === 'MODEL_INVOCATION_BINDING_CONFLICT' ? 'binding' : code === 'MODEL_INVOCATION_PROFILE_CONFLICT' ? 'profile'
    : code === 'MODEL_INVOCATION_RESULT_LIMIT' ? 'delivery-unfit'
    : code.includes('TARIFF') || code.includes('PRICING') || code === 'PROVIDER_SPEND_DATA_POLICY_REFUSED' ? 'tariff'
    : code.startsWith('PROVIDER_SPEND_') ? 'budget'
    : code.startsWith('POLICY_') || code.startsWith('PRINCIPAL_') || code.startsWith('SCOPE_') ? 'policy'
    : code.startsWith('OPENAI_CHAT_') || code.startsWith('ANTHROPIC_') || code === 'MODEL_INVOCATION_NATIVE_REQUEST_INVALID' ? 'protocol' : 'unavailable';
  // A raw ProviderSpendError carries `amounts`; a query-mapped refusal carries the same two public fields as `params` (never account totals here).
  const typed = error as { params?: { requested?: unknown; currency?: unknown }; amounts?: { requested?: unknown; currency?: unknown } } | null;
  const params = typed?.params ?? typed?.amounts, requested = params?.requested;
  const currency = params?.currency;
  if (code === 'PROVIDER_SPEND_EXHAUSTED' && typeof requested === 'number' && Number.isSafeInteger(requested) && requested >= 0 && typeof currency === 'string' && /^[A-Z]{3}$/u.test(currency))
    return { invocable: false, reason: { kind, code, reservation: { requestedMinorUnits: requested, currency } } };
  return { invocable: false, reason: { kind, code } };
}
/** The sole read model owner. Sequential checks bound resource use; one failed reference cannot mark another ready. */
export class ModelInvocableNowApplication {
  constructor(private readonly inspect: (reference: ModelReference) => Promise<void>) {}
  async read(scopeId: string, targets: readonly Omit<InvocableModel, 'availability'>[]): Promise<InvocableModels> {
    const models: InvocableModel[] = [];
    for (const target of targets) {
      let availability: ModelInvocability;
      try { await this.inspect(target.reference); availability = { invocable: true, reason: null }; }
      catch (error) { availability = modelInvocabilityRefusal(error); }
      models.push(Object.freeze({ ...target, availability }));
    }
    return Object.freeze({ schemaVersion: 1, scopeId, models: Object.freeze(models) });
  }
}
