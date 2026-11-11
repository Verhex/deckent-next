import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PACKAGE_VERSION } from '#platform/core/common/index.js';
import REGISTRY from './timing-registry.json' with { type: 'json' };
import COMMANDS from './timing-commands.json' with { type: 'json' };

export type TimingPhase = 'process-entry' | 'queued' | 'started' | 'gate-passed' | 'dispatch' | 'first-flush' | 'populated-flush' | 'first-output' | 'finished' | 'cancelled' | 'exit' | 'read-completed';
type Read = typeof REGISTRY.reads[number];
type Cache = 'none' | 'hit' | 'miss' | 'forced' | 'read' | 'reparsed';
type Result = 'ok' | 'error' | 'cancelled' | 'unknown';
export type TimingCounts = Record<string, { count: number; totalMs: number }>;
export interface TimingRecord { schemaVersion: 1; buildId: string; traceId: string; command: string; phase: TimingPhase; elapsedMs: number;
  counts: TimingCounts; cacheOutcome: Cache; result: Result }
export interface TimingTrace {
  readonly traceId: string;
  readonly command: string;
  phase(phase: TimingPhase, result?: Result): void;
  finish(cancelled?: boolean): void;
  fail(): void;
  readonly done: boolean;
  readonly process: boolean;
}
export const TIMING_TRACE_LIMITS = Object.freeze({ maxBytes: REGISTRY.maxBytes, maxPendingRecords: REGISTRY.maxPendingRecords });
export const timingEnabled = process.env[REGISTRY.environmentKey] === '1';
const storage = timingEnabled ? new AsyncLocalStorage<TimingTrace>() : undefined;
const counters = new WeakMap<TimingTrace, TimingCounts>();
const traceCommands = new WeakMap<TimingTrace, string>(), traceStarts = new WeakMap<TimingTrace, number>();
const outcomes = new WeakMap<TimingTrace, Cache>();
const pending: TimingRecord[] = [];
let draining: Promise<void> | undefined, dropped = 0;
let flush: (() => Promise<void>) | undefined;
export const timingCommand = (word: string): string => COMMANDS.includes(word) ? word : 'unknown';
export const currentTiming = (): TimingTrace | undefined => timingEnabled ? storage?.getStore() : undefined;
export const runWithTiming = <T>(trace: TimingTrace | undefined, work: () => T): T => trace && storage ? storage.run(trace, work) : work();
function enqueue(record: TimingRecord) {
  if (pending.length >= REGISTRY.maxPendingRecords) { dropped++; return; }
  pending.push(record);
  draining ??= drain().catch(() => { dropped += pending.length; pending.length = 0; }).finally(() => { draining = undefined; if (pending.length) enqueueDrain(); });
}
function enqueueDrain() { draining ??= drain().catch(() => { dropped += pending.length; pending.length = 0; }).finally(() => { draining = undefined; if (pending.length) enqueueDrain(); }); }
let buildIdentity: Promise<string> | undefined;
async function drain() {
  buildIdentity ??= readFile(new URL('../../../../build-identity.json', import.meta.url), 'utf8').then(text => {
    const id: unknown = (JSON.parse(text) as Record<string, unknown>)['sourceTreeSha256'];
    return typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id) ? `${PACKAGE_VERSION}:${id}` : `${PACKAGE_VERSION}-unbuilt`;
  }).catch(() => `${PACKAGE_VERSION}-unbuilt`);
  const buildId = await buildIdentity;
  const { appendTiming } = await import('./timing-file.js');
  while (pending.length) {
    const record = pending.shift()!;
    record.buildId = buildId;
    record.counts['dropped'] = { count: dropped, totalMs: 0 };
    if (!await appendTiming(record)) dropped++;
  }
}
export async function flushTiming(): Promise<void> { while (draining) await draining; }
/** Only generated identity and enumerated labels enter the serializer; a trace never authorizes work. */
export function startTiming(word: string, enteredAt?: number): TimingTrace | undefined {
  if (!timingEnabled) return undefined;
  const started = enteredAt ?? performance.now();
  const command = timingCommand(word), traceId = randomUUID(), counts: TimingCounts = {};
  let done = false, outcome: Result = 'ok';
  const emitted = new Set<TimingPhase>();
  const trace: TimingTrace = { traceId, command, get done() { return done; }, get process() { return emitted.has('process-entry'); },
    fail() { outcome = 'error'; },
    phase(phase, result = outcome) {
      if (done || emitted.has(phase) || !REGISTRY.phases.includes(phase)) return;
      emitted.add(phase);
      enqueue({ schemaVersion: 1, buildId: PACKAGE_VERSION, traceId, command: timingCommand(command), phase,
        elapsedMs: Math.max(0, performance.now() - started), counts: structuredClone(counts), cacheOutcome: outcomes.get(trace) ?? 'none', result: REGISTRY.results.includes(result) ? result : 'unknown' });
    },
    finish(cancelled = false) { trace.phase(cancelled ? 'cancelled' : 'finished', cancelled ? 'cancelled' : outcome); done = true; } };
  counters.set(trace, counts); traceCommands.set(trace, timingCommand(command)); traceStarts.set(trace, started); return trace;
}
export function beginTimingRead(read: Read, method?: string): ((cache?: Cache) => void) | undefined {
  if (!timingEnabled) return undefined;
  const trace = currentTiming();
  if (!trace || !REGISTRY.reads.includes(read)) return undefined;
  const started = performance.now();
  return (cache = 'none') => {
    outcomes.set(trace, cache);
    const counts = counters.get(trace)!, label = read === 'runtime-request' && method && REGISTRY.runtimeMethods.includes(method) ? `${read}.${method}` : read, key = `${label}:${REGISTRY.cacheOutcomes.includes(cache) ? cache : 'none'}`;
    const value = counts[key] ??= { count: 0, totalMs: 0 }; value.count++; value.totalMs += performance.now() - started;
    if (trace.done) enqueue({ schemaVersion: 1, buildId: PACKAGE_VERSION, traceId: trace.traceId, command: traceCommands.get(trace) ?? 'unknown',
      phase: 'read-completed', elapsedMs: Math.max(0, performance.now() - (traceStarts.get(trace) ?? started)), counts: structuredClone(counts), cacheOutcome: cache, result: 'ok' });
  };
}
export function timedAsync<A extends unknown[], T>(read: Read, work: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  return (...args) => {
    if (!timingEnabled) return work(...args);
    const end = beginTimingRead(read);
    return work(...args).finally(() => end?.());
  };
}
export function timedSync<A extends unknown[], T>(read: Read, work: (...args: A) => T): (...args: A) => T {
  return (...args) => { if (!timingEnabled) return work(...args); const end = beginTimingRead(read); try { return work(...args); } finally { end?.(); } };
}
/** Set only by the actual terminal host; never a React setState timestamp. */
export function installTimingFlush(next: () => Promise<void>): () => void { flush = next; return () => { if (flush === next) flush = undefined; }; }
const frames = new WeakMap<TimingTrace, Promise<void>>();
export function timingFrame(trace: TimingTrace | undefined, populated: boolean): Promise<void> {
  if (!trace || trace.done || !flush) return Promise.resolve();
  let first = frames.get(trace);
  if (!first) { first = flush().then(() => trace.phase('first-flush')); frames.set(trace, first); }
  return populated ? first.then(async () => { await flush?.(); trace.phase('populated-flush'); trace.finish(); }) : first;
}
/** Called before the CLI's heavy dynamic import. Stream bytes are never inspected or retained. */
export function startProcessTiming(argv: readonly string[]): void {
  if (!timingEnabled) return;
  const word = argv[0] === '--lang' ? argv[2] : argv[0], trace = startTiming(word ?? 'terminal', 0)!;
  storage?.enterWith(trace); trace.phase('process-entry');
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = ((...args: Parameters<typeof stream.write>) => { trace.phase('first-output'); return write(...args); }) as typeof stream.write;
  }
  process.once('beforeExit', () => { trace.phase('exit'); trace.finish(); void flushTiming(); });
}

export const catalogParseObserver = timingEnabled ? () => beginTimingRead('catalog-parse') : undefined;
