import { createContext, useEffect, useRef } from 'react';
import DECISION from './decision.json' with { type: 'json' };

/**
 * Decision arming (TERMINAL-SABIT-DUZEN slice 2, owner 2026-10-18; security review "unintended approval (keystroke race)"): a decision window
 * that holds the keyboard counts keys only after `armMs` (registry `decision.json`) with no key at all, measured from the moment it became
 * the visible input owner. Every key that arrives before that is swallowed and restarts the wait, so keys typed for the input, a held
 * (auto-repeated) key, a paste burst, a key carried over from the previous card of a queue or from a focus switch never decide it.
 */
export const DECISION_ARM_DEFAULT: number = DECISION.armMs;
/** The arming delay in force (the test harness may set 0; production keeps the registry value). */
export const DecisionArmContext = createContext<number>(DECISION_ARM_DEFAULT);

/** `touch`: a key arrived while unarmed (restart the wait). `restart`: drop the armed state now and wait again (a rejected burst). */
export function useQuietArming(active: boolean, ms: number): Readonly<{ armed: () => boolean; touch: () => void; restart: () => void }> {
  const armed = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null), live = useRef(active);
  live.current = active;
  const stop = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const start = () => {
    stop(); armed.current = false;
    if (!live.current) return;
    if (ms <= 0) { armed.current = true; return; }
    timer.current = setTimeout(() => { timer.current = null; armed.current = live.current; }, ms);
  };
  useEffect(() => { start(); return () => { stop(); armed.current = false; }; }, [active, ms]);
  return { armed: () => armed.current && live.current, touch: () => { if (!armed.current) start(); }, restart: start };
}
