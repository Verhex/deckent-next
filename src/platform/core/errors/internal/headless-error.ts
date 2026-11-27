import { LOCALES, resolveLocale, t, type Locale } from '#platform/core/i18n/index.js';
import { readHeadlessDiagnosticCase, readHeadlessDiagnosticIdentifier, readLegacyHeadlessDiagnosticCase, type HeadlessDiagnosticArgs } from './headless-diagnostics.js';
import { DeckentError } from './error.js';
import { ErrorRegistry } from './registry.js';

/** Short failure codes whose registered sentence holds for every producer that can store them as a worker's or parked Run's reason. Not here:
 * NATIVE_AGENT_LOGIN_REQUIRED (readiness stores it when sign-in was only unobserved), NATIVE_WORKER_STOP_UNCONFIRMED (also without a stop
 * request), NATIVE_WORKER_OUTPUT_LIMIT (the parser bound also counts call arguments). */
const FAILURE_REASON_SENTENCES: ReadonlySet<string> = new Set(['NATIVE_CLI_WORKER_UNAVAILABLE', 'NATIVE_WORKER_DEADLINE_REACHED',
  'NATIVE_WORKER_EFFECTS_UNKNOWN', 'NATIVE_WORKER_NOT_STARTED', 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', 'NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED']);
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

// The sandbox's argument-count refusal stores its writer's sentence: the isolated-process form only (the headless preflight's writer). Only an
// exact catalog round trip in either language over the bound yields its counts; the adapter checks the writer's fixed values (record form).
const SANDBOX_COUNTS = ['count', 'bound', 'home', 'protective', 'pins', 'remounts', 'tail', 'other'] as const;
const sandboxViewText = (counts: Readonly<Record<string, string | number>>, locale: Locale) =>
  `${t('shell.sandboxArgumentCountExceeded', counts, locale)} ${t('shell.sandboxIsolatedArgumentCountRemedy', {}, locale)}`;
function readSandboxViewRecord(stored: unknown): DeckentError | null {
  if (typeof stored !== 'string') return null;
  for (const written of LOCALES) {
    const shape = sandboxViewText(Object.fromEntries(SANDBOX_COUNTS.map((name, index) => [name, `@@${index}@@`])), written);
    const match = new RegExp(`^${shape.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/@@(\d)@@/gu, '(?<c$1>0|[1-9]\\d{0,8})')}$`, 'u').exec(stored);
    if (!match?.groups) continue;
    const [count = 0, bound = 0, home = 0, protective = 0, pins = 0, remounts = 0, tail = 0, other = 0] = SANDBOX_COUNTS.map((_, index) => Number(match.groups![`c${index}`]));
    const counts = Object.freeze({ count, bound, home, protective, pins, remounts, tail, other });
    if (count <= bound || count !== home + protective + pins + remounts + tail + other || sandboxViewText(counts, written) !== stored) continue;
    const localize = (locale: Locale) => ({ message: sandboxViewText(counts, locale) });
    return new DeckentError('SANDBOX_VIEW_TOO_LARGE', localize(resolveLocale()).message, undefined, undefined, undefined, undefined, undefined, 'error', undefined, localize, counts);
  }
  return null;
}
/** The re-read sandbox argument-count refusal: its code with exactly its eight safe counts (no stored text), for display schemas. */
export function isSandboxViewDiagnostic(error: DeckentError): boolean {
  const params = error.params ?? {}, count = (name: string) => params[name] as number;
  return error.code === 'SANDBOX_VIEW_TOO_LARGE' && Object.keys(params).length === SANDBOX_COUNTS.length
    && SANDBOX_COUNTS.every(name => Number.isSafeInteger(params[name]) && count(name) >= 0)
    && count('count') === SANDBOX_COUNTS.slice(2).reduce((sum, name) => sum + count(name), 0);
}

export function readHeadlessDiagnosticRecord(refusal: unknown, legacyCheck: unknown): DeckentError {
  const diagnostic = readHeadlessDiagnosticCase(refusal) ?? readLegacyHeadlessDiagnosticCase(refusal, legacyCheck);
  if (diagnostic) return ErrorRegistry.createError(diagnostic.code, { params: diagnostic.params });
  const sandbox = refusal === 'SANDBOX_VIEW_TOO_LARGE' ? readSandboxViewRecord(legacyCheck) : null;
  if (sandbox) return sandbox;
  // The old check identifies an operation, without a cause that a fresh writer could record.
  if (refusal === 'HEADLESS_PREFLIGHT_FAILED' && legacyCheck === 'state-dir') {
    const localize = (locale: Locale) => ({ message: t('error.headless.stateLegacyUnverified', {}, locale) });
    return new DeckentError(refusal, localize(resolveLocale()).message, undefined, undefined, undefined, undefined, undefined, 'error', undefined, localize);
  }
  // Y30: a check-only historical record names its operation (83cff36f8 wrote `launcher` and `executable-recheck` too).
  if (refusal === 'HEADLESS_ISOLATION_UNAVAILABLE' && (legacyCheck === 'login-lock' || legacyCheck === 'limits' || legacyCheck === 'launcher'))
    return headlessDiagnostic(refusal, { check: legacyCheck, reason: 'legacy-unverified' });
  if (refusal === 'HEADLESS_PREFLIGHT_FAILED' && (legacyCheck === 'version' || legacyCheck === 'flags'
    || legacyCheck === 'spawn' || legacyCheck === 'config-dir' || legacyCheck === 'executable-recheck' || legacyCheck === 'executable-changed'
    || legacyCheck === 'npm-layout-unknown' || legacyCheck === 'npm-payload-missing' || legacyCheck === 'npm-payload-unverified'))
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
