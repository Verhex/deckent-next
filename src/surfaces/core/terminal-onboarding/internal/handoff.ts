import { useEffect, useRef } from 'react';
import { useApp, useInput, usePaste } from 'ink';
import type { FirstTaskIntent, OnboardingFocus } from './contract.js';
type OpeningNotice = Readonly<{ level: 'info' | 'warning'; text: string }>;
/** alpha.60 B: the opening's setup, prepared after the first frame. `total`: the steps waiting (0: none); `notice`: the line said when no card opens
 * (a deferral, an unreadable observation); `unavailable`: setup could not be read at all (the view then has no setup, as before the frame-first
 * opening); `show` runs the prepared cards and gives the chosen first task and the line said after them. */
export type OnboardingOpening = Readonly<{ total: number; notice: OpeningNotice | null; unavailable?: true;
  show(signal: AbortSignal): Promise<Readonly<{ intent: FirstTaskIntent | null; notice: OpeningNotice | null }>> }>;
export type OnboardingHandoff = Readonly<{ initial?: FirstTaskIntent | null; opening?: Promise<OnboardingOpening | null>; open(signal: AbortSignal, focus?: OnboardingFocus): Promise<FirstTaskIntent | null>;
  /** Said when a message waits as a draft for a model (catalog text; the raw TERMINAL_CHAT_NOT_CONFIGURED is not shown to the person). */
  modelDraft: string;
  /** Owner 2026-10-31 (rule b): the one line said instead of opening the waiting card once the person has typed ("N steps waiting — /setup"). */
  waiting?: (count: number) => string }>;
/** Selected intent is submitted once to the ordinary Workline input queue, preserving its /do command identity. The opening's waiting card opens by
 * itself only while the person has typed nothing since the frame; after any key or paste the line is said instead, so typed-ahead keys never answer
 * a card that opened by itself. `opened` follows every open (the status row re-reads the configured model). */
export function useOnboardingHandoff(input: Readonly<{ port?: OnboardingHandoff | undefined; submit(id: string, line: string): boolean;
  release?(): void; reclaim?(): void; hold?(): () => void; say?(level: 'info' | 'warning', text: string): void; opened?(): void }>) {
  const { suspendTerminal } = useApp(), latest = useRef(input), queued = useRef(new Map<string, FirstTaskIntent>()), typed = useRef(false);
  latest.current = input;
  useInput(() => { typed.current = true; }); usePaste(() => { typed.current = true; });
  const enqueue = (intent: FirstTaskIntent | null) => {
    if (!intent || queued.current.has(intent.commandId)) return;
    queued.current.set(intent.commandId, intent);
    if (!latest.current.submit(intent.commandId, `/do ${intent.intent}`)) queued.current.delete(intent.commandId);
  };
  // Ink draws nothing while a card holds the terminal: rows pushed just before are drawn first, rows pushed meanwhile are held and drawn after it.
  // Node stops reading the TTY one tick after the host's hold pauses it; a card that attached its reader before that tick would never be read again.
  const suspended = async <T>(work: () => Promise<T>): Promise<T | null> => {
    let result: T | null = null;
    await new Promise(resolve => setImmediate(resolve));
    const unhold = latest.current.hold?.();
    try { await suspendTerminal(async () => { latest.current.release?.(); try { await new Promise(resolve => process.nextTick(resolve)); result = await work(); } finally { latest.current.reclaim?.(); } }); }
    finally { unhold?.(); }
    return result;
  };
  useEffect(() => {
    enqueue(latest.current.port?.initial ?? null); // a remount (StrictMode) finds it queued already
    const stop = new AbortController(), say = (notice: OpeningNotice | null) => { if (notice) latest.current.say?.(notice.level, notice.text); };
    void latest.current.port?.opening?.then(async opening => {
      if (!opening || stop.signal.aborted) return;
      say(opening.notice);
      const waiting = latest.current.port?.waiting;
      if (!opening.total) return;
      if (typed.current && waiting) { say({ level: 'info', text: waiting(opening.total) }); return; }
      const shown = await suspended(() => opening.show(stop.signal));
      say(shown?.notice ?? null); enqueue(shown?.intent ?? null); latest.current.opened?.();
    }).catch(() => undefined);
    return () => stop.abort();
  }, []);
  return {
    intent: (inputId: string) => queued.current.get(inputId),
    settled: (inputId: string) => queued.current.delete(inputId),
    /** Whether this view has setup: a handoff without an opening has; an opening that could not read setup has not. */
    usable: async () => Boolean(latest.current.port) && await (latest.current.port?.opening ?? Promise.resolve(null)).then(opening => opening?.unavailable !== true, () => false),
    async open(signal: AbortSignal, focus?: OnboardingFocus) {
      if (!latest.current.port) return;
      enqueue(await suspended(() => latest.current.port!.open(signal, focus)));
      latest.current.opened?.();
    },
  };
}
