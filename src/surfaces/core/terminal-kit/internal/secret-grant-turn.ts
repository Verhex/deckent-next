import type { TurnDelta } from './turn-stream.js';

/** The first-use card's words (catalog text through the shared renderer): title, explanation rows and the key-hint row. */
export type SecretGrantQuestion = Readonly<{ title: string; lines: readonly Readonly<{ label: string; text: string }>[]; prompt: string }>;
/**
 * PRE-8 first-use card (owner decisions 2026-10-21 `#pre8-secret-model-2026-10-21`, `#pre8-v2-decisions-2026-10-21` 1). The composition owns
 * every decision; this surface only asks and starts the turn again:
 * - `offer`: whether this terminal may answer at all (a solo installation's attested human terminal); false shows the refusal and its command;
 * - `grant`: the governed `secret grant` application with source `card` (policy cell, terminal witness, sealed decision before the record).
 */
export interface SecretGrantCardPort {
  offer(): Promise<boolean>;
  question(name: string, project: string): SecretGrantQuestion;
  grant(name: string): Promise<void>;
  /** PRE-8 v2 (`/provider`): the typed `SECRET_GRANT_REQUIRED` when this project may not use main-vault key NAME yet; resolves otherwise (no value read). */
  check?(name: string): Promise<void>;
}
/** Shows the card until it is answered; `true` only for an explicit yes (no, Enter, Esc, Ctrl+C and a cancelled turn are not). */
export type SecretGrantAsk = (question: SecretGrantQuestion, signal: AbortSignal) => Promise<boolean>;

const refusedGrant = (error: unknown): Readonly<{ name: string; project: string }> | null => {
  const { code, params } = (error ?? {}) as { code?: unknown; params?: Record<string, unknown> };
  return code === 'SECRET_GRANT_REQUIRED' && typeof params?.['name'] === 'string' && typeof params['project'] === 'string'
    ? { name: params['name'], project: params['project'] } : null;
};

/**
 * One turn with the first-use card: a turn refused before its first delta for a main-vault key without a grant (`SECRET_GRANT_REQUIRED`, raised
 * by the preflight before anything is sent) asks once; yes records the grant and starts the same turn once more. Any other refusal, a refusal
 * after the turn produced output, a cancelled turn, a terminal that may not answer, an answer other than yes, a failed grant and a second refusal
 * end the turn with that typed error — the card is never shown twice in one turn and nothing is retried without a recorded grant.
 * `bound` says whether the refused attempt already bound a turn to the service (its command was sent): such a turn is never started again — the
 * card answers only the local preflight's refusal, before the service saw anything.
 */
export async function* secretGrantTurn(start: () => AsyncIterable<TurnDelta>, card: SecretGrantCardPort, ask: SecretGrantAsk,
  signal: AbortSignal, bound: () => boolean = () => false): AsyncGenerator<TurnDelta> {
  for (let asked = false; ;) {
    let started = false;
    try {
      for await (const delta of start()) { started = true; yield delta; }
      return;
    } catch (error) {
      const refused = started || asked || signal.aborted || bound() ? null : refusedGrant(error);
      if (refused === null || !await card.offer()) throw error;
      asked = true;
      if (!await ask(card.question(refused.name, refused.project), signal) || signal.aborted) throw error;
      await card.grant(refused.name);
    }
  }
}

/** KER-17 audit (lead 2026-10-28): after a turn whose MCP server was refused for a main-vault key without a grant, the same person-only card is
 * offered once per key in this session; no (Enter/Esc) keeps the key closed and the turn's notice stays. Nothing is retried; the server starts
 * on the next message. Returns the lines to show for the keys granted now. */
export async function offerMcpGrants(keys: () => Promise<readonly Readonly<{ name: string; project: string }>[]>, card: SecretGrantCardPort,
  ask: (question: SecretGrantQuestion) => Promise<boolean>, offered: Set<string>, given: (name: string) => string): Promise<readonly string[]> {
  const granted: string[] = [];
  for (const key of await keys().catch(() => [])) {
    if (offered.has(key.name)) continue; offered.add(key.name);
    if (!await card.offer() || !await ask(card.question(key.name, key.project))) continue;
    await card.grant(key.name); granted.push(given(key.name));
  }
  return granted;
}
