import { useCallback, useState } from 'react';
import type { WorkLedgerEntry } from './work-ledger.js';
import { notice } from './workline-actions.js';

/** `/reasoning` notices (TL-A D6); optional until the catalog carries `terminal.reasoning.*` (`i18n-delta.json`). */
export type WorklineReasoningLabels = Readonly<{ on: string; off: string; usage: string }>;
// Neutral text equal to the proposed `en` catalog values, so behavior tests hold once the lead wires the keys.
const NEUTRAL: WorklineReasoningLabels = { on: 'Reasoning preview on', off: 'Reasoning preview off', usage: 'Usage: /reasoning [on|off]' };

/**
 * Whether the live region shows the last lines of the model's reasoning (TL-A D6): on by default, for this terminal session only.
 * `/reasoning` toggles it, `/reasoning on|off` sets it; anything else is a usage notice and changes nothing. Presentation only: what the
 * model is asked to do is not changed here (the request side is TL-C's; the lead passes `show` to the turn when both land).
 */
export function useReasoningPreview(push: (entries: readonly WorkLedgerEntry[]) => void, labels: WorklineReasoningLabels | undefined) {
  const [show, setShow] = useState(true);
  const run = useCallback((args: string) => {
    const words = labels ?? NEUTRAL, arg = args.trim().toLowerCase();
    if (arg !== '' && arg !== 'on' && arg !== 'off') { push([notice('error', words.usage)]); return; }
    const next = arg === '' ? !show : arg === 'on';
    setShow(next); push([notice('info', next ? words.on : words.off)]);
  }, [labels, push, show]);
  return { show, run };
}
