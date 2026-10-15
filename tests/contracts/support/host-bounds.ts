/**
 * Scales a fixed in-test wait by the configured per-test bound (DECKENT_TEST_TIMEOUT_MS, default 30 s; see vitest.config.ts): unchanged on
 * Linux CI and locally, ×4 on the hosted macOS/Windows cells (120 s), whose 3–4 vCPU runners start child processes slower. A hang still fails,
 * only later (PLATFORM-TEMIZLIK: purge barrier, concurrent service and allocation timings timed out on macOS in tries 1 and 3).
 */
export function hostBound(milliseconds: number): number {
  const raw = process.env['DECKENT_TEST_TIMEOUT_MS'], configured = raw === undefined || raw === '' ? 30_000 : Number(raw);
  return Number.isSafeInteger(configured) && configured > 30_000 ? Math.round(milliseconds * configured / 30_000) : milliseconds;
}
