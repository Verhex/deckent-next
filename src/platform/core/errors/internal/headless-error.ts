import type { Locale } from '#platform/core/i18n/index.js';
import { readHeadlessDiagnosticCase, readHeadlessDiagnosticIdentifier, readLegacyHeadlessDiagnosticCase, type HeadlessDiagnosticArgs } from './headless-diagnostics.js';
import { DeckentError } from './error.js';
import { ErrorRegistry } from './registry.js';

/** Short failure codes whose registered sentence holds for every producer that can store them as a worker's or parked Run's reason. Not here:
 * NATIVE_AGENT_LOGIN_REQUIRED (readiness stores it when sign-in was only unobserved), HEADLESS_CREDITS_REQUIRED ("nothing was accepted" is not
 * established after tool effects), NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED (chat wording; malformed init), NATIVE_WORKER_STOP_UNCONFIRMED (also
 * without a stop request), NATIVE_WORKER_OUTPUT_LIMIT (the parser bound also counts call arguments). */
const FAILURE_REASON_SENTENCES: ReadonlySet<string> = new Set(['NATIVE_CLI_WORKER_UNAVAILABLE', 'NATIVE_WORKER_DEADLINE_REACHED',
  'NATIVE_WORKER_TERMINATION_UNKNOWN', 'NATIVE_WORKER_EFFECTS_UNKNOWN', 'NATIVE_WORKER_CUSTODY_UNKNOWN', 'NATIVE_WORKER_NOT_STARTED', 'APPROVAL_EXPIRED',
  'SIWC_USAGE_UNAVAILABLE', 'SIWC_SERVICE_UNAVAILABLE', 'HEADLESS_PLAN_UNAVAILABLE']);
/** A recorded failure identifier in words: an encoded diagnostic; an allowlisted code's sentence; any other registered code as the recorded code
 * whose cause was not determined; undefined for an unregistered value. */
export function readFailureReasonText(value: string, locale: Locale): string | undefined {
  const encoded = readHeadlessDiagnosticIdentifier(value, locale);
  if (encoded || !ErrorRegistry.has(value)) return encoded;
  return ErrorRegistry.get(FAILURE_REASON_SENTENCES.has(value) ? value : 'TERMINAL_CHAT_RECORDED_FAILURE', locale, { code: value })!.message;
}

/** A provider-program refusal carries only the checked diagnostic fields. */
export function headlessDiagnostic(...[code, params]: HeadlessDiagnosticArgs) {
  return ErrorRegistry.createError(code, { params: params ?? {} });
}
export function refuseHeadlessDiagnostic(...args: HeadlessDiagnosticArgs): never {
  throw headlessDiagnostic(...args);
}

export function readHeadlessDiagnosticRecord(refusal: unknown, legacyCheck: unknown): DeckentError {
  const diagnostic = readHeadlessDiagnosticCase(refusal) ?? readLegacyHeadlessDiagnosticCase(refusal, legacyCheck);
  if (diagnostic) return ErrorRegistry.createError(diagnostic.code, { params: diagnostic.params });
  // Y30: a check-only historical record names its operation (83cff36f8 wrote `launcher` and `executable-recheck` too).
  if (refusal === 'HEADLESS_ISOLATION_UNAVAILABLE' && (legacyCheck === 'login-lock' || legacyCheck === 'limits' || legacyCheck === 'launcher'))
    return headlessDiagnostic(refusal, { check: legacyCheck, reason: 'legacy-unverified' });
  if (refusal === 'HEADLESS_PREFLIGHT_FAILED' && (legacyCheck === 'version' || legacyCheck === 'flags'
    || legacyCheck === 'spawn' || legacyCheck === 'config-dir' || legacyCheck === 'executable-recheck'))
    return headlessDiagnostic(refusal, { check: legacyCheck, reason: 'legacy-unverified' });
  if (refusal === 'HEADLESS_LIMIT_REACHED' && legacyCheck === null) return headlessDiagnostic(refusal, { limit: 'legacy-unverified' });
  if (refusal === 'HEADLESS_LOGIN_BUSY' && legacyCheck === null) return headlessDiagnostic(refusal, { holder: 'legacy-family-unverified' });
  if (refusal === 'HEADLESS_LOGIN_REQUIRED' && legacyCheck === null) return headlessDiagnostic(refusal, { reason: 'legacy-unverified' });
  const family = refusal === 'HEADLESS_ISOLATION_UNAVAILABLE' ? refusal : 'HEADLESS_PREFLIGHT_FAILED';
  return ErrorRegistry.createError(family, { params: { check: 'diagnostic-unverified' } });
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
