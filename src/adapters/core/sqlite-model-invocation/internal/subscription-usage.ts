import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { delegationOwner, modelInvocationPlanUsageSchema, type ModelInvocationReceipt, type ModelReference } from '#domain/index.js';
import { verifyModelInvocationReceipt, modelInvocationPlanUsageDigest, providerSpendOutcomeDigest, type SubscriptionUsageSummary } from '#engine/index.js';
import { requireLedgerVersion, MODEL_INVOCATION_PLAN_USAGE_LEDGER_VERSION, assertSqliteEngineSupported } from '#adapters/core/sqlite-ledger/index.js';
const MILLISECONDS_PER_DAY = 86_400_000;
/** Bounded, verified receipt projection. Counts completed requests in Deckent's ledger, never upstream quota or a reset prediction. */
export async function readSqliteSubscriptionUsageSummary(path: string, input: { scopeId: string; connectionId: string; adapterId: string;
  owner: { issuer: string; subject: string }; fromMs: number; untilMs: number; maxEntries: number; timeoutMs: number; busyTimeoutMs: number; signal?: AbortSignal;
  references: readonly ModelReference[] }): Promise<SubscriptionUsageSummary> {
  let db: DatabaseSync | undefined;
  try {
    assertSqliteEngineSupported(process.versions.sqlite);
    const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    db = new NativeDatabase(path, { readOnly: true, timeout: input.busyTimeoutMs });
    requireLedgerVersion(db, MODEL_INVOCATION_PLAN_USAGE_LEDGER_VERSION);
    const days = new Map<number, number>(); let total = 0, scanned = 0;
    db.exec('BEGIN');
    const deadline = performance.now() + input.timeoutMs;
    for (const row of db.prepare(`SELECT i.record, u.record AS usage, u.digest FROM model_invocations i LEFT JOIN model_invocation_plan_usage u
      ON i.scope_id=u.scope_id AND i.invocation_id=u.invocation_id WHERE i.scope_id=? LIMIT ?`).iterate(input.scopeId, input.maxEntries + 1)) {
      await yieldTurn();
      if (input.signal?.aborted || performance.now() >= deadline) return { state: 'unavailable', completedRequests: null, busiestDayRequests: null, activeDays: null };
      if (++scanned > input.maxEntries) return { state: 'unavailable', completedRequests: null, busiestDayRequests: null, activeDays: null };
      const receipt: ModelInvocationReceipt = verifyModelInvocationReceipt(JSON.parse(String(row['record'])));
      if (receipt.request.scopeId !== input.scopeId) throw new Error();
      const observedAt = receipt.outcome?.observedAtMs;
      if (receipt.profile.adapter.id !== input.adapterId || receipt.profile.adapter.definition['connectionId'] !== input.connectionId
        || observedAt === undefined || observedAt < input.fromMs || observedAt > input.untilMs) continue;
      const usage = modelInvocationPlanUsageSchema.parse(JSON.parse(String(row['usage'])));
      if (row['digest'] !== modelInvocationPlanUsageDigest(usage) || usage.scopeId !== input.scopeId || usage.invocationId !== receipt.claim.invocationId
        || usage.profileDigest !== receipt.profileDigest || usage.outcomeDigest !== providerSpendOutcomeDigest(receipt) || usage.observedAtMs !== receipt.outcome?.observedAtMs) throw new Error();
      const owner = delegationOwner(receipt.actor);
      if (owner.issuer !== input.owner.issuer || owner.subject !== input.owner.subject || !input.references.some(reference => JSON.stringify(reference) === JSON.stringify(receipt.request.reference))) continue;
      if (receipt.outcome?.state !== 'responded') continue;
      const day = Math.floor(receipt.outcome.observedAtMs / MILLISECONDS_PER_DAY); days.set(day, (days.get(day) ?? 0) + 1); total++;
    }
    db.exec('COMMIT');
    return { state: 'complete', completedRequests: total, busiestDayRequests: Math.max(0, ...days.values()), activeDays: days.size };
  } catch { return { state: 'unavailable', completedRequests: null, busiestDayRequests: null, activeDays: null }; }
  finally { db?.close(); }
}
