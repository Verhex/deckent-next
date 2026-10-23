import { useEffect, useRef } from 'react';

/** What needs the person: a running piece of work finished, or a card is waiting for an answer. */
export interface AttentionSignals { readonly working: boolean; readonly awaitingAnswer: boolean }

/**
 * T2: calls `notify` once when the work stops (working true to false) and once when a card starts waiting (awaitingAnswer false to true).
 * It carries no text and no state: `notify` itself decides whether the window is in the background. The first render never rings.
 */
export function useAttentionNotice(notify: (() => void) | undefined, signals: AttentionSignals): void {
  const before = useRef(signals);
  useEffect(() => {
    const last = before.current;
    before.current = signals;
    if (!notify) return;
    if ((last.working && !signals.working) || (!last.awaitingAnswer && signals.awaitingAnswer)) notify();
  }, [notify, signals.working, signals.awaitingAnswer]);
}
