import type { WorkerEvent } from '#domain/index.js';
import { terminalSafeText } from '#platform/index.js';

/** MONITOR v1.1 bound for one surfaced line (first failure). */
export const MONITOR_FAILURE_MAX_CHARS = 200;
// Recognised failure lines, any of which counts; the first one in output order wins (stdout before stderr).
const FAILURE_LINES: readonly RegExp[] = Object.freeze([
  /^✗ \[[\w-]+\]/, // lint-arch / deckent gates
  /\berror TS\d+\b/, // tsc
  /^\d+:\d+\s+error\s/, // eslint stylish row (its file is the preceding path line)
  /^FAIL\s+\S/, // vitest failing file/test
  /^AssertionError\b/, // assertion message
  /^\w*Error \[[A-Z][A-Z0-9_]*\]:/, // node coded error
]);
/** Untrusted output → one display line: every escape sequence (CSI, OSC to BEL/ST, other ESC forms) and every C0/C1 control and DEL removed. */
const clean = (line: string) => terminalSafeText(line).replace(/\s+/g, ' ').trim();
const bound = (line: string) => line.length > MONITOR_FAILURE_MAX_CHARS ? line.slice(0, MONITOR_FAILURE_MAX_CHARS - 1) + '…' : line;

function firstMatch(text: string): string | null {
  const lines = text.split('\n').map(clean);
  for (const [index, line] of lines.entries()) {
    const pattern = FAILURE_LINES.findIndex(value => value.test(line));
    if (pattern < 0) continue;
    if (pattern !== 2) return line;
    const file = lines.slice(0, index).reverse().find(value => value !== '');
    return file && /^[\w./@-]+\.\w+$/.test(file) ? `${file} ${line}` : line;
  }
  return null;
}
/**
 * The first failing line of a failed attempt's recorded output: a recognised failure line (stdout first, then stderr), else the last
 * non-empty stderr line, else the last non-empty stdout line; ANSI stripped, whitespace collapsed, at most 200 chars. Pure; the
 * output itself is untrusted process text and this is display evidence only, never an outcome.
 */
export function extractFirstFailure(stdout: string, stderr: string): string | null {
  const found = firstMatch(stdout) ?? firstMatch(stderr);
  if (found) return bound(found);
  for (const text of [stderr, stdout]) {
    const last = text.split('\n').map(clean).reverse().find(value => value !== '');
    if (last) return bound(last);
  }
  return null;
}
const SUMMARY_CHARS = 120;
/** A worker-reported event (untrusted) as a short kind + summary for the monitor; no content beyond the redacted fields. */
export function summarizeMonitorEvent(event: WorkerEvent): { readonly kind: string; readonly summary: string } {
  const text = (() => {
    switch (event.kind) {
      case 'tool.call': return [event.toolClass, event.name, event.target].filter(Boolean).join(' ');
      case 'tool.result': return event.status;
      case 'session.started': return [event.provider, event.model].filter(Boolean).join(' ');
      case 'session.ended': return `${event.outcome} ${event.turns} turns`;
      case 'message': return event.excerpt;
      case 'usage': return `in ${event.tokens.input} out ${event.tokens.output}`;
      case 'quota': return `${event.window} ${Math.round(event.utilization * 100)}% ${event.status}`;
      case 'limit': return `${event.limit} ${event.detail}`;
      case 'unmapped': return `${event.nativeType} ×${event.count}`;
      case 'model.verification': return [event.status, event.admitted].filter(Boolean).join(' ');
      case 'dropped': return `${event.reason} ${event.count}`;
      default: return '';
    }
  })();
  return Object.freeze({ kind: event.kind, summary: clean(text).slice(0, SUMMARY_CHARS) });
}
