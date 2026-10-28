import data from './local-run.json' with { type: 'json' };

/** Owner decision 2026-10-28 (option A, LAW-AUDIT-DR2-01 K1-K3): whether a /do refusal may offer the person to run the task here in the terminal
 * (behind a card, never automatically). Registry data, read by every surface; only "nothing is set up" qualifies. */
export const localRunOffered = (code: unknown): boolean => typeof code === 'string' && (data.offerHereOn as readonly string[]).includes(code);
