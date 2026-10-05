import type { ModelInvocationOutcome } from '#domain/index.js';
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
  return `${outcome.state}: ${evidence.reason === 'http-status' && evidence.httpStatus !== null ? `HTTP ${evidence.httpStatus}`
    : `${evidence.reason}${evidence.httpStatus !== null ? `, HTTP ${evidence.httpStatus}` : ''}`}`;
}
