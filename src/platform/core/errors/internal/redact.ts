import { redactForRecord } from '#platform/core/redaction/index.js';

/** Compatibility entry: the canonical B7 record producer. */
export function redactSensitive(value: string): string { return redactForRecord(value); }

/** Diagnostic envelope v1: bound before scanning; remove credentials, paths and terminal controls. */
export function queryErrorDiagnostic(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!(current instanceof Error)) { if (!parts.length) parts.push(typeof current); break; }
    parts.push(`${current.name}: ${current.message}`.slice(0, 2048)); current = current.cause;
    if (current === undefined) break;
  }
  const text = redactSensitive(parts.join(' ← ').slice(0, 2048)).replace(/(?:[A-Za-z]:[\\/]|\/)[^\s,;)'"<>]+/g, '[PATH]');
  return [...text].map(char => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159) ? ' ' : char; }).join('');
}
