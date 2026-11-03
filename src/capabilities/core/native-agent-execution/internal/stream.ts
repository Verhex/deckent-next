import { splitModelInvocationDelta, type ModelInvocationDeltaSink } from '#domain/index.js';
/** Presentation only: a failing sink never changes the call. */
export function emitDelta(onDelta: ModelInvocationDeltaSink | undefined, text: string): void {
  for (const delta of splitModelInvocationDelta('text', text)) { try { onDelta?.(delta); } catch { /* Presentation only. */ } }
}
/** Reported usage counters: each required one, and each optional one present, is a safe non-negative integer and their sum stays safe; otherwise
 * null (unknown consumption is never a measured zero, so the caller refuses and the reservation stays charged). An absent optional counter is none. */
export function reportedCounters<K extends string>(usage: unknown, required: readonly K[], optional: readonly K[] = []): Readonly<Record<K, number>> | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const counters = {} as Record<K, number>; let sum = 0;
  for (const key of [...required, ...optional]) {
    const value = Object.hasOwn(usage, key) ? (usage as Record<string, unknown>)[key] : required.includes(key) ? undefined : 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(sum += value)) return null;
    counters[key] = value;
  }
  return counters;
}
