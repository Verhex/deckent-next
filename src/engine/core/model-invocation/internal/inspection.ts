import { verifyModelInvocationPlanUsage } from './plan-usage.js';
import { z } from 'zod';
import type { ModelInvocationPlanUsageRead } from '#domain/index.js';
import { verifyInvocationSpendReservation, type ProviderSpendReservation } from '#engine/core/provider-spend/index.js';
import { isDeepStrictEqual } from 'node:util';
import { parseModelInvocationControlRecord, parseModelInvocationQuery, ModelInvocationError, modelInvocationCommandQueryInputSchema, type ModelInvocationCommandQuery, type ModelInvocationControlRecord, type ModelInvocationPurgeReceipt, type ModelInvocationQuery,
  type ModelInvocationReceipt, type ModelInvocationResponseContent } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelInvocationAuthorizer } from './application.js';
import { verifyModelInvocationRecord } from './content.js';
import { ModelInvocationStoreError, type ModelInvocationRecord } from './port.js';
import { checkInvocationResultDelivery, validateInvocationDelivery, type ModelInvocationDelivery } from './delivery.js';
// Today's successful response map predates the bounded v2 observation; keep all of its valid names readable.
const legacyPlugins = z.object({ cliVersion: z.string().min(1), builtinPlugins: z.array(z.string().min(1)) });

/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export interface ModelInvocationInspectionRecord { readonly record: ModelInvocationRecord; readonly control: ModelInvocationControlRecord; readonly spending: ProviderSpendReservation | null; readonly planUsage?: ModelInvocationPlanUsageRead | null }
export interface ModelInvocationInspectionReader {
  loadReceipt?(scopeId: string, commandId: string): Promise<ModelInvocationRecord | null>;
  loadInspection(scopeId: string, invocationId: string): Promise<ModelInvocationInspectionRecord | null>;
  loadObservationPage?(scopeId: string, after: string | null, limit: number): Promise<{ records: readonly ModelInvocationInspectionRecord[]; next: string | null }>;
  close(): void;
}
export type ModelInvocationInspection = Readonly<{ schemaVersion: 7; scopeId: string; invocationId: string;
  reference: ModelInvocationQuery['reference']; historyIntegrity: 'not-recorded'; invocation: ModelInvocationReceipt | null;
  control: ModelInvocationControlRecord | null;
  spending: ProviderSpendReservation | null;
  planUsage?: ModelInvocationPlanUsageRead | null;
  contentStatus: 'retained' | 'not-captured' | 'purged' | null; purge: ModelInvocationPurgeReceipt | null;
  responseContent?: ModelInvocationResponseContent | null }>;
export class ModelInvocationInspectionApplication {
  constructor(private readonly verifier: PrincipalVerifier, private readonly authorization: ModelInvocationAuthorizer,
    private readonly openReader: () => Promise<ModelInvocationInspectionReader>) {}
  /** Scoped, bounded history, with the ordinary inspection authority checked separately for each reference. */
  async inspectNativePlugins(scopeId: string, limits: { pageSize: number; maxRecords: number }, credential?: unknown) {
    const principal = await authenticate(this.verifier, credential, scopeId);
    if (![limits.pageSize, limits.maxRecords].every(value => Number.isSafeInteger(value) && value > 0)) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const reader = await this.openReader(), names = new Map<string, { cliVersion: string | null; name: string }>();
    let after: string | null = null, scanned = 0, calls = 0, hiddenCalls = 0, omitted = 0n, complete = true;
    const allowed = async (action: 'inspect' | 'inspect-content', target: Parameters<ModelInvocationAuthorizer['authorize']>[1]) => {
      try { await this.authorization.authorize(action, target, principal); return true; }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && (error.code === 'POLICY_DENIED' || error.code === 'POLICY_APPROVAL_UNSUPPORTED')) return false;
        throw error;
      }
    };
    try {
      if (!reader.loadObservationPage) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
      do {
        const page = await reader.loadObservationPage(scopeId, after, Math.min(limits.pageSize, limits.maxRecords - scanned));
        for (const stored of page.records) {
          scanned++;
          const record = verifyModelInvocationRecord(stored.record), receipt = record.receipt;
          if (receipt.claim.scopeId !== scopeId) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
          const usage = verifyModelInvocationPlanUsage(stored.planUsage ?? null, record);
          const target = { scopeId, reference: receipt.request.reference };
          if (!await allowed('inspect', target)) continue;
          let observation = usage?.schemaVersion === 2 ? usage.observation : null;
          if (!observation?.builtinPlugins && receipt.outcome?.state === 'responded' && record.content?.kind === 'native-response') {
            const headless = record.content.response.native['headless'];
            const parsed = legacyPlugins.safeParse(headless);
            if (parsed.success && parsed.data.builtinPlugins.length) observation = { schemaVersion: 1, cliVersion: parsed.data.cliVersion,
              builtinPlugins: { names: parsed.data.builtinPlugins, omitted: 0 }, paidExtraUsage: null };
          }
          if (record.purge && receipt.outcome?.state === 'responded' && !observation?.builtinPlugins) complete = false;
          const plugins = observation?.builtinPlugins;
          if (!plugins) continue;
          calls++;
          if (!await allowed('inspect-content', target)) { hiddenCalls++; continue; }
          omitted += BigInt(plugins.omitted);
          for (const name of plugins.names) names.set(JSON.stringify([observation!.cliVersion, name]), { cliVersion: observation!.cliVersion, name });
        }
        after = page.next;
      } while (after !== null && scanned < limits.maxRecords);
      // Across records the exact total may exceed Counter; decimal text also keeps the view JSON-safe.
      return { calls, hiddenCalls, names: [...names.values()], omitted: omitted.toString(), complete: complete && after === null };
    } finally { reader.close(); }
  }
  /** Same read authority, resolved by command identity first; immutable scope/reference are verified before returning any lookup. */
  async inspectCommand(input: ModelInvocationCommandQuery, credential?: unknown): Promise<ModelInvocationInspection | null> {
    const parsed = modelInvocationCommandQueryInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelInvocationError('MODEL_INVOCATION_INVALID');
    const query = parsed.data, principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', { scopeId: query.scopeId, reference: query.reference }, principal);
    const reader = await this.openReader();
    let invocationId: string;
    try {
      if (!reader.loadReceipt) throw new ModelInvocationStoreError('MODEL_INVOCATION_UNAVAILABLE');
      const stored = await reader.loadReceipt(query.scopeId, query.commandId);
      if (!stored) return null;
      const { receipt } = verifyModelInvocationRecord(stored);
      if (receipt.claim.scopeId !== query.scopeId || receipt.request.commandId !== query.commandId
        || !isDeepStrictEqual(receipt.request.reference, query.reference)) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      invocationId = receipt.claim.invocationId;
    } finally { reader.close(); }
    return this.inspect({ schemaVersion: 2, scopeId: query.scopeId, invocationId, reference: query.reference }, credential);
  }
  async inspect(input: unknown, credential?: unknown, delivery?: ModelInvocationDelivery): Promise<ModelInvocationInspection> {
    validateInvocationDelivery(delivery);
    const query = parseModelInvocationQuery(input), principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize('inspect', { scopeId: query.scopeId, reference: query.reference }, principal);
    if (query.includeResponseContent === true) await this.authorization.authorize('inspect-content',
      { scopeId: query.scopeId, reference: query.reference }, principal);
    // No durable full-history audit producer is connected: record checks must not imply historical verification.
    const identity = { schemaVersion: 7 as const, historyIntegrity: 'not-recorded' as const, scopeId: query.scopeId, invocationId: query.invocationId, reference: query.reference };
    const reader = await this.openReader();
    try {
      const stored = await reader.loadInspection(query.scopeId, query.invocationId);
      if (!stored) return checkInvocationResultDelivery(Object.freeze({ ...identity, invocation: null, control: null, spending: null, contentStatus: null, purge: null,
        ...(query.includeResponseContent === true ? { responseContent: null } : {}) }), delivery);
      const record = verifyModelInvocationRecord(stored.record), receipt = record.receipt;
      const control = verifyModelInvocationInspectionControl(receipt, stored.control);
      if (receipt.claim.scopeId !== query.scopeId || receipt.claim.invocationId !== query.invocationId
        || JSON.stringify(receipt.request.reference) !== JSON.stringify(query.reference)) {
        throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      }
      const spending = stored.spending === null ? null : verifyInvocationSpendReservation(stored.spending, receipt);
      const verifiedUsage = verifyModelInvocationPlanUsage(stored.planUsage ?? null, record);
      const planUsage = verifiedUsage?.schemaVersion === 2 && verifiedUsage.observation?.builtinPlugins && query.includeResponseContent !== true
        ? { ...verifiedUsage, observation: { ...verifiedUsage.observation, builtinPlugins: { names: [],
          omitted: verifiedUsage.observation.builtinPlugins.names.length + verifiedUsage.observation.builtinPlugins.omitted } } } : verifiedUsage;
      if (planUsage && spending) throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT');
      return checkInvocationResultDelivery(Object.freeze({ ...identity, invocation: receipt, control, spending,
        ...(receipt.profile.schemaVersion !== 1 ? { planUsage } : {}),
        contentStatus: record.purge ? 'purged' : record.content === null ? 'not-captured' : 'retained', purge: record.purge,
        ...(query.includeResponseContent === true ? { responseContent: record.content } : {}) }), delivery);
    } finally { reader.close(); }
  }
}

export function verifyModelInvocationInspectionControl(receipt: ModelInvocationReceipt, input: unknown): ModelInvocationControlRecord {
  try {
    const control = parseModelInvocationControlRecord(input), outcome = receipt.outcome, cancellation = control.cancellation;
    if (!isDeepStrictEqual(control.claim, receipt.claim) || !isDeepStrictEqual(control.reference, receipt.request.reference)
      || (control.send.state === 'pending' && outcome !== null)
      || ((outcome?.state === 'not-sent') !== (control.send.state === 'prevented'))
      || (outcome?.state === 'not-sent' && (outcome.cancellationCommandId !== cancellation?.command.commandId
        || outcome.observedAtMs !== cancellation.requestedAtMs))
      || (cancellation?.disposition === 'already-terminal' && outcome?.state !== 'responded' && outcome?.state !== 'rejected')) {
      throw new Error();
    }
    return control;
  } catch { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
}

export type SubscriptionUsageSummary = Readonly<{ state: 'complete' | 'unavailable'; completedRequests: number | null; busiestDayRequests: number | null; activeDays: number | null }>;
