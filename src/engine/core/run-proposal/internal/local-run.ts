import data from './local-run.json' with { type: 'json' };

/** What closes the offer whatever the code (K2/K3): the person's profile defaults (`localRunFallbackClosed`) and a held pool / paused background work. */
export type LocalRunContext = Readonly<{ closed?: boolean; paused?: boolean }>;
/** Owner decision 2026-10-28 (option A, LAW-AUDIT-DR2-01 K1-K3): whether a /do refusal may offer the person to run the task here in the terminal
 * (terminal-default since owner 2026-11-02). Registry data read by every surface; a pause always wins over the code (K2). */
export const localRunOffered = (code: unknown, context: LocalRunContext = {}): boolean => typeof code === 'string' && (data.offerHereOn as readonly string[]).includes(code)
  && context.paused !== true && context.closed !== true;
