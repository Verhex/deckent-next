import { terminalLineEnd } from '#platform/index.js';
import type { AgentChatMessage, TurnDelta } from './turn-stream.js';

type Sink = { write(text: string): unknown };
type Finish = Extract<TurnDelta, { kind: 'done' }>['finish'];
export type LineTurnOutcome = Readonly<{
  /** Messages the turn appended (assistant and tool); the caller continues its history from exactly these. */
  appended: readonly AgentChatMessage[];
  /** Set when the turn compacted the history: it replaces every non-system message of the caller's history. */
  compacted: readonly AgentChatMessage[] | null;
  finish: Finish | null;
  answer: string;
  /** An approval card was raised: line mode has nobody to decide it, so the turn was cancelled and nothing ran. */
  approvalRefused: boolean;
}>;

/**
 * Line mode (pipe, no terminal) writes the answer as it arrives, one complete line at a time: plain text on `out`, no ANSI, the last line
 * ended. Tool results and approval cards are one plain line each on `err`, so a pipe carries the answer alone. Line mode cannot decide an
 * approval card (no owner is at the other end): the first card cancels the turn through `cancel`, and nothing is allowed. A pipe cannot take
 * back what it wrote, so a line is projected only once it is complete (a newline the projection keeps, or the turn's end): a secret or
 * escape split across deltas is redacted or removed whole, the same commit unit as the rich view's scrollback. A newline inside an escape
 * ends no line, so a value around an OSC that swallows its newline is never split between two writes. The held tail is never larger than
 * the turn's own answer text, which the outcome already carries.
 */
export type LineTurnIo = Readonly<{ out: Sink; err: Sink; cancel: () => void;
  /** The caller's human-surface projection of untrusted text (record redaction, escapes/controls removed, hidden characters marked):
   * `prose` for the answer, `exact` for tool targets and approval summaries. */
  project: (text: string, context: 'exact' | 'prose') => string;
  /** The caller's catalog lines for a finished tool call and for a refused approval card. */
  toolLine: (call: Readonly<{ name: string; target: string | null; status: string | null; ms: number | null }>) => string;
  approvalLine: (summary: string) => string }>;
export async function streamLineTurn(stream: AsyncIterable<TurnDelta>, io: LineTurnIo): Promise<LineTurnOutcome> {
  const appended: AgentChatMessage[] = [];
  let compacted: readonly AgentChatMessage[] | null = null, finish: Finish | null = null, answer = '', held = '', lastChar = '\n', approvalRefused = false;
  const write = (text: string) => { if (text.length === 0) return; io.out.write(text); lastChar = text.at(-1)!; };
  const note = (line: string) => { io.err.write(`${io.project(line, 'exact').replace(/\s+/gu, ' ').trim()}\n`); };
  const feed = (text: string) => {
    answer += text;
    // Only complete visible lines are written; an open OSC holds its line (it shows nothing until BEL, ST or the next ESC anyway).
    const buffer = held + text, cut = terminalLineEnd(buffer);
    held = buffer.slice(cut);
    write(io.project(buffer.slice(0, cut), 'prose'));
  };
  for await (const delta of stream) {
    if (delta.kind === 'text') feed(delta.text);
    else if (delta.kind === 'message') appended.push(delta.message);
    else if (delta.kind === 'compacted') { compacted = delta.messages; appended.length = 0; }
    else if (delta.kind === 'tool' && delta.phase === 'finished') {
      note(io.toolLine(delta));
    } else if (delta.kind === 'approval' && delta.phase === 'requested' && !approvalRefused) {
      approvalRefused = true;
      note(io.approvalLine(delta.summary));
      io.cancel();
    } else if (delta.kind === 'done') {
      finish = delta.finish;
      if (held) { write(io.project(held, 'prose')); held = ''; }
      if (answer.length === 0 && delta.note) { write(io.project(delta.note, 'prose')); answer = delta.note; }
    }
  }
  if (held) write(io.project(held, 'prose'));
  if (lastChar !== '\n') write('\n');
  return Object.freeze({ appended, compacted, finish, answer, approvalRefused });
}
