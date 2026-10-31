import { splitModelInvocationDelta, type HeadlessEgress, type ModelInvocationDeltaSink, type ModelInvocationNativeResult, type ModelInvocationProfile, type ModelInvocationRejectionReason } from '#domain/index.js';
import type { HeadlessRejectionBody, NativeCliHeadlessDefinition } from './contract.js';
import type { HeadlessEntry } from './env.js';
import type { HeadlessPreflight } from './preflight.js';

/** What `prepare` sealed for one call (the port's token). */
export type Prepared = Readonly<{ profile: ModelInvocationProfile; definition: NativeCliHeadlessDefinition; entry: HeadlessEntry; model: string; system: string; user: string;
  effortArgs: readonly string[] }>;
/** A typed rejection: the receipt's reason and status and the adapter's own body (never CLI output). */
export type Refusal = Readonly<{ reason: ModelInvocationRejectionReason; status: number | null; body: HeadlessRejectionBody }>;
export const reject = (reason: ModelInvocationRejectionReason, body: Omit<Extract<HeadlessRejectionBody, { schemaVersion: 1 }>, 'schemaVersion'>, status: number | null = null): Refusal =>
  Object.freeze({ reason, status, body: { schemaVersion: 1 as const, ...body } });
/**
 * One call's event-stream reading (selected by the registry's `eventStream`): `line` returns the first refusal (the process is stopped), `end` the
 * settled outcome once the CLI exited — a typed refusal, the governed response, or null (the outcome is unknown and thrown).
 */
export type HeadlessTurn = Readonly<{ line(raw: string): Refusal | null;
  end(exit: Readonly<{ exited: boolean; exitCode: number | null }>, egress: HeadlessEgress): Readonly<{ refusal: Refusal }> | Readonly<{ response: Exclude<ModelInvocationNativeResult, { kind: 'rejected' }> }> | null }>;
export type HeadlessTurnFactory = (prepared: Prepared, preflight: HeadlessPreflight, runDir: string, onDelta?: ModelInvocationDeltaSink) => HeadlessTurn;
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
