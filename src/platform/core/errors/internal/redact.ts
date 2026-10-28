import { randomUUID } from 'node:crypto';
import { redactForRecord, previewRecordStream, type KnownSecretSnapshot } from '#platform/core/redaction/index.js';
import { ErrorRegistry } from './registry.js';
import type { DeckentError } from './error.js';

/** Compatibility entry: the canonical B7 record producer. */
export function redactSensitive(value: string): string { return redactForRecord(value); }

// Internal diagnostic custody: never an error property, client parameter, or second log/store.
const diagnostics = new WeakMap<DeckentError, unknown>();
const SAFE_CLASSES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'SqliteError']);
/** Client envelope contains no source text; even an arbitrary error name is untrusted. */
export function unexpectedQueryFailure(error: unknown): DeckentError {
  const errorClass = error instanceof Error && SAFE_CLASSES.has(error.name) ? error.name : 'Error';
  const failure = ErrorRegistry.createError('QUERY_UNEXPECTED_FAILURE', { params: { errorClass, diagnosticId: randomUUID() } });
  diagnostics.set(failure, error); return failure;
}
/** Server-only derived record. Scan complete fields before any bound; withhold incomplete known-secret suffixes.
 * The caller supplies its actual resolved configuration snapshot and sends the result to the existing service log. */
export function takeQueryErrorRecord(failure: DeckentError, known: KnownSecretSnapshot): string | undefined {
  if (!diagnostics.has(failure)) return undefined;
  let current = diagnostics.get(failure); const parts: string[] = [];
  diagnostics.delete(failure);
  for (let depth = 0; depth < 3; depth++) {
    if (!(current instanceof Error)) { if (!parts.length) parts.push(typeof current); break; }
    for (const field of [current.name, current.message, current.stack ?? '']) {
      const scanned = redactForRecord(field, known);
      parts.push(scanned.split('\n').map(line => previewRecordStream({ held: line, withheld: false }, known)).join('\n'));
    }
    current = current.cause;
    if (current === undefined) break;
  }
  const record = redactForRecord(parts.join(' ← '), known);
  const controlled = [...record].map(char => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159) ? ' ' : char; }).join('');
  return redactForRecord(controlled, known).slice(0, 2048);
}
/** Bind derived diagnostics to the service's existing observer sink; record failures never disclose source text. */
export async function reportQueryError(failure: DeckentError, loadKnown: () => Promise<KnownSecretSnapshot>,
  record?: (event: { readonly code: string; readonly diagnosticId: string; readonly detail: string }) => void | Promise<void>): Promise<void> {
  if (failure.code !== 'QUERY_UNEXPECTED_FAILURE' || !record) return;
  try {
    const detail = takeQueryErrorRecord(failure, await loadKnown());
    if (detail !== undefined) await record({ code: failure.code, diagnosticId: String(failure.params?.['diagnosticId']), detail });
  } catch { /* No raw fallback if configuration or the existing record sink is unavailable. */ }
}
/** Closed client parameter shape for transports: never forward arbitrary params or an untrusted class name. */
export function queryErrorClientParams(error: DeckentError): Readonly<{ errorClass: string; diagnosticId: string }> | undefined {
  const errorClass = error.params?.['errorClass'], diagnosticId = error.params?.['diagnosticId'];
  return error.code === 'QUERY_UNEXPECTED_FAILURE' && typeof errorClass === 'string' && SAFE_CLASSES.has(errorClass)
    && typeof diagnosticId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(diagnosticId)
    ? { errorClass, diagnosticId } : undefined;
}
/** Re-mapping a typed query failure cannot smuggle legacy detail params or a custom message back to a client. */
export function sanitizeQueryFailure(error: DeckentError): DeckentError {
  const params = queryErrorClientParams(error);
  if (!params) return unexpectedQueryFailure(error);
  const safe = ErrorRegistry.createError('QUERY_UNEXPECTED_FAILURE', { params });
  if (diagnostics.has(error)) { diagnostics.set(safe, diagnostics.get(error)); diagnostics.delete(error); }
  return safe;
}
