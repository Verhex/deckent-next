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

/** True while an escape sequence (CSI or OSC) has not reached its final byte or terminator. */
// Matching the control characters is the point of these patterns (untrusted model text).
/* eslint-disable no-control-regex */
const unfinishedEscape = (tail: string) => tail.length === 1 || (tail[1] === '[' ? !/^\u001b\[[0-?]*[ -/]*[@-~]/u.test(tail)
  : tail[1] === ']' ? !/\u0007|\u001b\\/u.test(tail.slice(2)) : false);
/* eslint-enable no-control-regex */

/**
 * Line mode (pipe, no terminal) writes the answer as it arrives: plain text on `out`, no ANSI, the last line ended. Tool results and
 * approval cards are one plain line each on `err`, so a pipe carries the answer alone. Line mode cannot decide an approval card (no
 * owner is at the other end): the first card cancels the turn through `cancel`, and nothing is allowed. Untrusted text is stripped of
 * escapes and controls; an escape or CR split across two deltas is held back until its end is known.
 */
export type LineTurnIo = Readonly<{ out: Sink; err: Sink; cancel: () => void;
  /** Strips escapes and controls from untrusted text (the caller's platform sanitizer). */
  safe: (text: string) => string;
  /** The caller's catalog lines for a finished tool call and for a refused approval card. */
  toolLine: (call: Readonly<{ name: string; target: string | null; status: string | null; ms: number | null }>) => string;
  approvalLine: (summary: string) => string }>;
export async function streamLineTurn(stream: AsyncIterable<TurnDelta>, io: LineTurnIo): Promise<LineTurnOutcome> {
  const appended: AgentChatMessage[] = [];
  let compacted: readonly AgentChatMessage[] | null = null, finish: Finish | null = null, answer = '', held = '', lastChar = '\n', approvalRefused = false;
  const write = (text: string) => { if (text.length === 0) return; io.out.write(text); lastChar = text.at(-1)!; };
  const note = (line: string) => { io.err.write(`${io.safe(line).replace(/\s+/gu, ' ').trim()}\n`); };
  const feed = (text: string) => {
    answer += text;
    // An unfinished escape or a trailing CR waits for one more delta only; a tail still unfinished then is cleaned and written.
    const buffer = held + text, escape = buffer.lastIndexOf('\u001b'), fresh = held === '';
    const cut = fresh && escape >= 0 && unfinishedEscape(buffer.slice(escape)) ? escape : fresh && buffer.endsWith('\r') ? buffer.length - 1 : buffer.length;
    held = buffer.slice(cut);
    write(io.safe(buffer.slice(0, cut)));
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
      if (held) { write(io.safe(held)); held = ''; }
      if (answer.length === 0 && delta.note) { write(`${io.safe(delta.note)}`); answer = delta.note; }
    }
  }
  if (held) write(io.safe(held));
  if (lastChar !== '\n') write('\n');
  return Object.freeze({ appended, compacted, finish, answer, approvalRefused });
}
