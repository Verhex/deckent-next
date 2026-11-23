import type { HeadlessDiagnosticArgs } from './headless-diagnostics.js';
import { DeckentError } from './error.js';
import { ErrorRegistry } from './registry.js';

/** A provider-program refusal carries only the checked diagnostic fields. */
export function headlessDiagnostic(...[code, params]: HeadlessDiagnosticArgs) {
  return ErrorRegistry.createError(code, { params: params ?? {} });
}
export function refuseHeadlessDiagnostic(...args: HeadlessDiagnosticArgs): never {
  throw headlessDiagnostic(...args);
}

const signInReturned = new WeakSet<DeckentError>();
/** The original diagnostic remains the shared error. Command-start evidence is local to this interaction. */
export function markHeadlessLoginReturned(error: unknown): never {
  if (error instanceof DeckentError) signInReturned.add(error);
  throw error;
}

export function didHeadlessLoginReturn(error: unknown): boolean {
  if (!(error instanceof DeckentError)) return false;
  const check = error.params?.['check'];
  return signInReturned.has(error) || error.code === 'HEADLESS_PREFLIGHT_FAILED'
    && (check === 'login-record-write' || check === 'login-record-rename');
}
