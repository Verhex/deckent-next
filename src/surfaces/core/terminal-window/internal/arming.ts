import { createContext, useEffect, useRef, useState } from 'react';
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

/** The arming words a decision window shows on its hint row until it is armed (catalog `terminal.decision.*`); neutral marks without them. */
export type DecisionArmLabels = Readonly<{ arming: string; ignored: string }>;
export const DecisionArmLabelsContext = createContext<DecisionArmLabels>(Object.freeze({ arming: '…', ignored: '… ×' }));

/**
 * `touch`: a key arrived while unarmed (restart the wait, and say so: `ignored`). `restart`: drop the armed state now and wait again (a
 * rejected burst). `shown`: the armed state as render state, so the window shows its keys only once they count (CI 2026-10-18: a key sent
 * right after a card appeared was swallowed silently and the flow looked hung; the visible state is both the person's and a test's signal).
 */
export function useQuietArming(active: boolean, ms: number): Readonly<{ armed: () => boolean; touch: () => void; restart: () => void; shown: boolean; ignored: boolean }> {
  const armed = useRef(ms <= 0 && active), timer = useRef<ReturnType<typeof setTimeout> | null>(null), live = useRef(active);
  const [shown, setShown] = useState(ms <= 0 && active), [ignored, setIgnored] = useState(false);
  live.current = active;
  const stop = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const set = (value: boolean) => { armed.current = value; setShown(value); if (value) setIgnored(false); };
  const start = () => {
    stop(); set(false);
    if (!live.current) return;
    if (ms <= 0) { set(true); return; }
    timer.current = setTimeout(() => { timer.current = null; set(live.current); }, ms);
  };
  useEffect(() => { start(); return () => { stop(); armed.current = false; }; }, [active, ms]);
  return { armed: () => armed.current && live.current, touch: () => { if (!armed.current) { start(); setIgnored(true); } }, restart: start, shown: shown && active, ignored };
}
