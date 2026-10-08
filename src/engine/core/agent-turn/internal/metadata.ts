import type { ModelInvocationOutcome, ModelInvocationRejectionReason } from '#domain/index.js';
export function canonicalTurnRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTurnRequest).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalTurnRequest((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const TURN_NOTE_MAX_CHARS = 4_096; // The result note's bound (`chatTurnResultSchema`).
/** The turn's note with the MCP notices first (MCP-SANDBOX-PATHS): the engine's own note is kept whole; only the MCP part is shortened to fit. */
export function withMcpNotices(notices: readonly string[], note: string | null): string | null {
  if (!notices.length) return note;
  const room = TURN_NOTE_MAX_CHARS - (note ? note.length + 1 : 0), joined = notices.join(' ');
  if (room < 2) return note;
  const mcp = joined.length <= room ? joined : `${joined.slice(0, room - 1)}…`;
  return note ? `${mcp} ${note}` : mcp;
}
/**
 * How a round that ended without an answer is named in the turn's note: the outcome state and, when the provider answered, its bounded
 * diagnostic (rejection reason, HTTP status) — never the response body, which stays in the receipt (it may echo the sent input).
 */
export function chatTurnRoundFailureState(outcome: ModelInvocationOutcome): string {
  const evidence = outcome.state === 'rejected' || outcome.state === 'unknown' ? outcome.evidence : null;
  if (!evidence) return outcome.state;
  const kind = classifyProviderRejection(evidence);
  return `${outcome.state}: ${evidence.reason === 'http-status' && evidence.httpStatus !== null ? `HTTP ${evidence.httpStatus}`
    : `${evidence.reason}${evidence.httpStatus !== null ? `, HTTP ${evidence.httpStatus}` : ''}`}${kind ? ` (${kind})` : ''}`;
}

/** Why a provider refused a call, when it says so in a known way (SECRET-AT-REST, owner 2026-10-08): the API key was refused (invalid,
 * expired or revoked), the key may not use this model/workspace, the account's spend limit is reached, or the rate limit is hit. Without
 * the error body (a turn sees only the evidence summary) a 429 is `limit-reached` — spend or rate, not guessed — and a 400 stays
 * unclassified. The names are stable tokens shared by the turn note, the terminal hint and the T4 connection test; limits stay the
 * user's to manage. */
export const PROVIDER_REJECTION_KINDS = ['credential-rejected', 'access-denied', 'spend-limit', 'rate-limit', 'limit-reached'] as const;
export type ProviderRejectionKind = typeof PROVIDER_REJECTION_KINDS[number];
/** Only this prefix of an error body is parsed for the provider's error code; the body itself is never returned or shown. */
const ERROR_BODY_SCAN_SIZE = 16_384;
/** The provider's typed error fields (Anthropic `error.type` / `error.details.error_code`, OpenAI `error.code`); empty when unreadable. */
function providerError(data: string | undefined): Readonly<{ type: string; code: string; message: string }> {
  const none = { type: '', code: '', message: '' };
  if (!data) return none;
  try {
    const parsed = JSON.parse(Buffer.from(data.slice(0, Math.ceil(ERROR_BODY_SCAN_SIZE / 3) * 4), 'base64').toString('utf8')) as unknown;
    const error = (parsed as { error?: unknown } | null)?.error;
    if (!error || typeof error !== 'object') return none;
    const record = error as { type?: unknown; code?: unknown; message?: unknown; details?: { error_code?: unknown } | null };
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    return { type: text(record.type), code: text(record.details?.error_code) || text(record.code), message: text(record.message) };
  } catch { return none; }
}
/** Classifies an HTTP refusal; anything not recognized stays unclassified (null) rather than guessed. */
export function classifyProviderRejection(evidence: { readonly reason: ModelInvocationRejectionReason; readonly httpStatus: number | null; readonly body?: object }): ProviderRejectionKind | null {
  if (evidence.reason !== 'http-status' || evidence.httpStatus === null) return null;
  const status = evidence.httpStatus;
  if (status === 401) return 'credential-rejected';
  if (status === 403) return 'access-denied';
  if (status === 402) return 'spend-limit';
  const data = evidence.body && 'data' in evidence.body && typeof evidence.body.data === 'string' ? evidence.body.data : undefined;
  if (data === undefined) return status === 429 ? 'limit-reached' : null;
  const error = providerError(data);
  // Anthropic: the tier cap is a 429 with `enforced_spend_limit_reached` (no retry-after); OpenAI: `insufficient_quota`.
  if (status === 429) {
    if (error.code === 'enforced_spend_limit_reached' || error.code === 'insufficient_quota') return 'spend-limit';
    // Only a provider error that names a rate limit is one (Astra 2450 a); an unreadable or unrecognized body stays limit-reached.
    return error.type === 'rate_limit_error' || /^rate_limit/.test(error.code) ? 'rate-limit' : 'limit-reached';
  }
  // Anthropic: a limit the user set (organization or workspace) is a 400 `invalid_request_error` with this message.
  if (status === 400 && error.type === 'invalid_request_error' && /^You have reached your specified (?:workspace )?API usage limits/.test(error.message)) return 'spend-limit';
  return null;
}
