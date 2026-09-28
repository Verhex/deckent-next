/** The scopes a card can offer beyond "this once": the service says which (the view never decides). */
export type StandingScope = 'session' | 'always';

/**
 * Key mapping for a decision card. Only a single typed `y`/`Y` says yes; `n`/`N`, Enter, Esc and Ctrl+C say no (the safe
 * default; Ctrl+C closes the card instead of leaving the operator stuck, it never exits the terminal from a card).
 * Pasted or multi-character input, control sequences and every other key leave the card waiting. There is no
 * "always"/remember key on this plain card: every gated item is decided one by one (legacy `a` stays absent). A card the service
 * marks with standing scopes uses `scopedDecisionKey` instead (owner 2026-09-28: kapsam seçmeli).
 */
export function decisionKey(input: string, key: { readonly return?: boolean; readonly escape?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }):
  'yes' | 'no' | null {
  if (key.return || key.escape || (key.ctrl && input === 'c')) return 'no';
  if (key.ctrl || key.meta || input.length !== 1) return null;
  if (input === 'y' || input === 'Y') return 'yes';
  if (input === 'n' || input === 'N') return 'no';
  return null;
}

/**
 * Key mapping for a decision card that offers standing scopes (PERSISTENT-APPROVALS G6): `y` this once, `s` this session and `a` always in
 * this project — each only when the card offers it, a single typed key like `y` (pasted text, control sequences and unoffered scopes leave
 * the card waiting) — and the same safe-default no keys as `decisionKey`.
 */
export function scopedDecisionKey(input: string, key: Parameters<typeof decisionKey>[1], scopes: readonly StandingScope[]):
  { readonly yes: boolean; readonly standing?: StandingScope } | null {
  const plain = decisionKey(input, key);
  if (plain !== null) return { yes: plain === 'yes' };
  if (key.ctrl || key.meta || input.length !== 1) return null;
  const lower = input.toLowerCase();
  if (lower === 's' && scopes.includes('session')) return { yes: true, standing: 'session' };
  if (lower === 'a' && scopes.includes('always')) return { yes: true, standing: 'always' };
  return null;
}
