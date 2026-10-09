import { useCallback, useRef, useState } from 'react';
import { type WorkLedgerEntry, notice } from '#surfaces/core/terminal-ledger/index.js';

/** `/reasoning` notices (TL-A D6); optional until the catalog carries `terminal.reasoning.*` (`i18n-delta.json`). */
export type WorklineReasoningLabels = Readonly<{ on: string; off: string; usage: string; unsupported?: string }>;
// Neutral text equal to the proposed `en` catalog values, so behavior tests hold once the lead wires the keys.
const NEUTRAL: WorklineReasoningLabels = { on: 'Reasoning on (preview and model thinking)', off: 'Reasoning off (preview and model thinking)',
  usage: 'Usage: /reasoning [on|off]' };
/** What the `/reasoning` window sets: whether the model thinks, and whether the live preview of that thinking is shown. */
export type ReasoningSetting = 'thinking-on' | 'thinking-off' | 'preview-on' | 'preview-off';

/**
 * Whether the model reasons in this terminal session (TL-A D6, protocol v16): on by default, for this session only. Off hides the
 * live preview and the workline asks the service for turns without model thinking (a model that cannot switch refuses them by name).
 * SLASH-WINDOWS (owner 2026-10-08): the rich terminal sets the two states through the `/reasoning` window (`set`) and shows them in the
 * status strip; the typed `/reasoning [on|off]` (`run`, both states together, one notice) stays for a terminal without windows.
 */
export function useReasoningPreview(push: (entries: readonly WorkLedgerEntry[]) => void, labels: WorklineReasoningLabels | undefined) {
  const [thinking, setThinking] = useState(true), [preview, setPreview] = useState(true);
  // Read by the turn when it starts: a `/reasoning` queued before a message (FIFO) holds for it although no render ran between them.
  const current = useRef(true);
  const run = useCallback((args: string) => {
    const words = labels ?? NEUTRAL, arg = args.trim().toLowerCase();
    if (arg !== '' && arg !== 'on' && arg !== 'off') { push([notice('error', words.usage)]); return; }
    const next = arg === '' ? !current.current : arg === 'on';
    current.current = next; setThinking(next); setPreview(next); push([notice('info', next ? words.on : words.off)]);
  }, [labels, push]);
  const set = useCallback((setting: ReasoningSetting) => {
    if (setting === 'thinking-on' || setting === 'thinking-off') { current.current = setting === 'thinking-on'; setThinking(current.current); }
    else setPreview(setting === 'preview-on');
  }, []);
  return { show: thinking && preview, thinking, preview, run, set, current };
}
