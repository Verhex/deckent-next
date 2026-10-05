import type { SessionStandingResult } from '#engine/index.js';
type Labels = { readonly savedSession: string; readonly savedAlways: string; readonly notSavedSession: string; readonly notSavedAlways: string; readonly unconfirmedSession: string };
type Answer = SessionStandingResult | { readonly scope: 'session' | 'always'; readonly saved: boolean; readonly reason?: string };
const fill = (text: string, params: Readonly<Record<string, string>>) => text.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
export function standingAnswerNotice(id: string, scope: 'session' | 'always', answer: Answer | undefined, labels: Labels): { level: 'info' | 'error'; text: string } {
  const saved = answer && ('status' in answer ? answer.status === 'saved' : answer.saved), always = scope === 'always';
  const unknown = !answer || ('status' in answer && answer.status === 'unconfirmed');
  const text = saved ? (always ? labels.savedAlways : labels.savedSession) : !always && unknown ? labels.unconfirmedSession
    : (always ? labels.notSavedAlways : labels.notSavedSession);
  return { level: saved ? 'info' : 'error', text: fill(text, { id, reason: answer && 'reason' in answer ? answer.reason ?? 'unconfirmed' : 'unconfirmed' }) };
}
/** Capture the conversation before awaiting; a later selection cannot change either target or acknowledgement. */
export async function clearStandingNotice(session: string, clear: (session: string) => Promise<void>, labels: { readonly cleared: string; readonly unconfirmed: string }): Promise<{ level: 'info' | 'error'; text: string }> {
  try { await clear(session); return { level: 'info', text: fill(labels.cleared, { session }) }; }
  catch { return { level: 'error', text: fill(labels.unconfirmed, { session }) }; }
}
