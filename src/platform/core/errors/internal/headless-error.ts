import { readHeadlessDiagnosticCase, readLegacyHeadlessDiagnosticCase, type HeadlessDiagnosticArgs } from './headless-diagnostics.js';
import { DeckentError } from './error.js';
import { ErrorRegistry } from './registry.js';

/** A provider-program refusal carries only the checked diagnostic fields. */
export function headlessDiagnostic(...[code, params]: HeadlessDiagnosticArgs) {
  return ErrorRegistry.createError(code, { params: params ?? {} });
}
export function refuseHeadlessDiagnostic(...args: HeadlessDiagnosticArgs): never {
  throw headlessDiagnostic(...args);
}

export function readHeadlessDiagnosticRecord(refusal: unknown, legacyCheck: unknown): DeckentError {
  const diagnostic = readHeadlessDiagnosticCase(refusal) ?? readLegacyHeadlessDiagnosticCase(refusal, legacyCheck);
  return diagnostic ? ErrorRegistry.createError(diagnostic.code, { params: diagnostic.params }) : ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED');
}

const signInReturned = new WeakSet<object>();
/** The original diagnostic remains the shared error. Command-start evidence is local to this interaction. */
export function markHeadlessLoginReturned(error: unknown): never {
  if (isObject(error)) signInReturned.add(error);
  throw error;
}

export function didHeadlessLoginReturn(error: unknown): boolean {
  if (isObject(error) && signInReturned.has(error)) return true;
  if (!(error instanceof DeckentError)) return false;
  const check = error.params?.['check'];
  return error.code === 'HEADLESS_PREFLIGHT_FAILED' && (check === 'login-record-write' || check === 'login-record-rename');
}

const isObject = (value: unknown): value is object => (typeof value === 'object' && value !== null) || typeof value === 'function';
