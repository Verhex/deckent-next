import type { OpenRouterMetadataFetchOptions, OpenRouterMetadataObservation } from './fetch.js';

export type OpenRouterTariffAcquire = (options: OpenRouterMetadataFetchOptions, now: () => number, signal?: AbortSignal) => Promise<OpenRouterMetadataObservation>;

/**
 * Process-lifetime tariff cache (CATALOG-SEED pattern: acquire once, serve until the declared freshness window ends). A hit returns the
 * very observation that a verified TLS GET produced, so the pricing quote still checks its own `[fetchedAt, expiresAt)` window and a
 * stale entry can never be priced. The hot path of a call inside the window performs no network request; a miss (first use, expiry,
 * clock stepped outside the window, other endpoint/model/tag/CA) acquires through `acquire`. Failures are never cached, and
 * concurrent misses for one key share one request. The key covers every field that selects or secures the acquisition.
 */
export function createOpenRouterTariffCache(acquire: OpenRouterTariffAcquire) {
  const entries = new Map<string, OpenRouterMetadataObservation>(), inflight = new Map<string, Promise<OpenRouterMetadataObservation>>();
  const fresh = (observation: OpenRouterMetadataObservation, nowMs: number) =>
    Number.isSafeInteger(nowMs) && nowMs >= observation.observedAtMs && nowMs < observation.tariff.selection.expiresAtMs;
  const keyOf = (options: OpenRouterMetadataFetchOptions) => JSON.stringify([options.endpoint, options.modelId, options.endpointTag, options.maxAgeMs, options.maxResponseBytes, options.timeoutMs, options.caPem ?? null]);
  return Object.freeze({
    /** Observation only: a miss never fetches, joins an in-flight effect or mutates the cache. */
    peek(options: OpenRouterMetadataFetchOptions, nowMs: number): OpenRouterMetadataObservation | null {
      const hit = entries.get(keyOf(options)); return hit && fresh(hit, nowMs) ? hit : null;
    },
    async get(options: OpenRouterMetadataFetchOptions, now: () => number, signal?: AbortSignal): Promise<OpenRouterMetadataObservation> {
      const key = keyOf(options);
      const hit = entries.get(key);
      if (hit && fresh(hit, now())) return hit;
      entries.delete(key);
      const joined = inflight.get(key);
      if (joined) { try { const shared = await joined; if (fresh(shared, now())) return shared; } catch { /* acquire on this caller's own signal below */ } }
      const pending = acquire(options, now, signal);
      inflight.set(key, pending);
      try {
        const observation = await pending;
        // Bounded by freshness: an insert drops every entry whose window has ended.
        for (const [other, held] of entries) if (!fresh(held, now())) entries.delete(other);
        entries.set(key, observation); return observation;
      } finally { if (inflight.get(key) === pending) inflight.delete(key); }
    },
    clear() { entries.clear(); },
    size() { return entries.size; },
  });
}
