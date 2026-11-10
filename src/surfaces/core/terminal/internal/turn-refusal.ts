/** What the terminal does next after a turn or `/do` fails; the one place that maps a typed refusal code to its recovery step (F-H3c). */
type TurnNext = 'draft' | 'start-service' | 'show-spending' | 'cancelled' | 'error';

const NEXT: Readonly<Record<string, TurnNext | undefined>> = Object.freeze({
  TERMINAL_CHAT_NOT_CONFIGURED: 'draft', LOCAL_RUNTIME_UNAVAILABLE: 'start-service',
  PROVIDER_SPEND_EXHAUSTED: 'show-spending', PROVIDER_SPEND_FROZEN: 'show-spending', BRAIN_CANCELLED: 'cancelled',
});

/** `code` is the failure's own typed code (null for a foreign error); `next` the recovery step, `error` when the failure only gets its text. */
export function turnRefusal(error: unknown): Readonly<{ code: string | null; next: TurnNext }> {
  const raw = error && typeof error === 'object' && 'code' in error ? error.code : null, code = typeof raw === 'string' ? raw : null;
  return { code, next: code !== null && Object.hasOwn(NEXT, code) ? NEXT[code]! : 'error' };
}
