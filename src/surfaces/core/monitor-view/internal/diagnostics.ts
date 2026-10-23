import { t, type Locale } from '#platform/index.js';
import DISPLAY from './display.json' with { type: 'json' };

/**
 * Install diagnostics in words (MONITOR v1.1). A data-lane code is `name[:detail]` (split on the first `:` only — `scopes-unavailable:<n>:<CODE>`
 * keeps its second part in the detail). An `info:` prefix makes it a neutral note (never a ! warning, never counted as a problem). An unknown
 * code stays visible as itself, so a new code from the data lane is never hidden.
 */
export interface MonitorDiagnostic { readonly code: string; readonly note: boolean; readonly text: string;
  /** The next step a person can take, only where one real command answers it (PB-MON-UX "→ Yapılacak"); absent otherwise, never invented. */
  readonly action?: string }

const scopesUnavailable = (count: string, reason: string, locale: Locale) =>
  t('monitor.diagnostic.scopesUnavailable', { count, code: reason ? ` (${reason})` : '' }, locale);
/** MON-NAMES `scope-refused|scope-failed:<CODE>:<scope>`: the reader names a scope only to a viewer holding the scope-diagnostics grant; the
 * code (possibly empty) never holds `:`, the scope id may. */
const namedScope = (refused: boolean, detail: string, locale: Locale) => {
  const at = detail.indexOf(':'), reason = at < 0 ? '' : detail.slice(0, at), params = { scope: at < 0 ? detail : detail.slice(at + 1), code: reason ? ` (${reason})` : '' };
  return refused ? t('monitor.diagnostic.scopeRefused', params, locale) : t('monitor.diagnostic.scopeFailed', params, locale);
};

export function describeDiagnostic(raw: string, locale: Locale): MonitorDiagnostic {
  const note = raw.startsWith('info:'), body = note ? raw.slice(5) : raw, at = body.indexOf(':');
  const code = at < 0 ? body : body.slice(0, at), detail = at < 0 ? '' : body.slice(at + 1);
  const words: Readonly<Record<string, () => string>> = {
    'service-unavailable': () => t('monitor.diagnostic.serviceUnavailable', { detail }, locale),
    'ledger-unavailable': () => t('monitor.diagnostic.ledgerUnavailable', { detail }, locale),
    'ledger-version-older': () => t('monitor.diagnostic.ledgerVersionOlder', { detail }, locale),
    // MON-SCOPE-NAMES: refused scopes arrive as a count only (`scopes-denied:<n>`), never by name.
    'scopes-denied': () => t('monitor.diagnostic.scopesDenied', { count: detail }, locale),
    // `scopes-unavailable:<n>[:<CODE>]`: a scope whose access check failed is a count with its reason, never named (MON-SCOPE-NAMES).
    'scopes-unavailable': () => scopesUnavailable(detail.split(':')[0]!, detail.split(':').slice(1).join(':'), locale),
    // An older reader's `scope-unavailable:<scope>[:<CODE>]`: one scope, its id dropped (an unknown code would show it raw).
    'scope-unavailable': () => scopesUnavailable('1', detail.split(':').slice(1).join(':'), locale),
    'scope-refused': () => namedScope(true, detail, locale),
    'scope-failed': () => namedScope(false, detail, locale),
    // The grant decision itself failed: counts only, reported once and without any scope id (fail-closed).
    'scope-diagnostics-unavailable': () => t('monitor.diagnostic.scopeDiagnosticsUnavailable', { detail }, locale),
    'workers-unavailable': () => t('monitor.diagnostic.workersUnavailable', { detail }, locale),
    'workers-denied': () => t('monitor.diagnostic.workersDenied', { detail }, locale),
    'workers-not-sampled': () => t('monitor.diagnostic.workersNotSampled', { detail }, locale),
    'workers-truncated': () => t('monitor.diagnostic.workersTruncated', { detail }, locale),
    'workers-finished-capped': () => t('monitor.diagnostic.workersFinishedCapped', { detail }, locale),
    'runs-truncated': () => t('monitor.diagnostic.runsTruncated', { detail }, locale),
    'run-corrupt': () => t('monitor.diagnostic.runCorrupt', { detail }, locale),
    'approvals-truncated': () => t('monitor.diagnostic.approvalsTruncated', { detail }, locale),
    'approval-corrupt': () => t('monitor.diagnostic.approvalCorrupt', { detail }, locale),
    'pool-occupancy-corrupt': () => t('monitor.diagnostic.poolOccupancyCorrupt', { detail }, locale),
    'pool-corrupt': () => t('monitor.diagnostic.poolCorrupt', { detail }, locale),
    'pool-decisions-unavailable': () => t('monitor.diagnostic.poolDecisionsUnavailable', { detail }, locale),
    'ledger-only': () => t('monitor.diagnostic.ledgerOnly', { detail }, locale),
    'ledger-version-unsupported': () => t('monitor.diagnostic.ledgerVersionUnsupported', { detail }, locale),
    'approvals-denied': () => t('monitor.diagnostic.approvalsDenied', { detail }, locale),
    'config-restart-required': () => t('monitor.diagnostic.configRestartRequired', {}, locale),
    'image-updating': () => t('monitor.diagnostic.imageUpdating', {}, locale),
    'image-current': () => detail ? t('monitor.diagnostic.imageCurrent', { detail }, locale) : t('monitor.diagnostic.imageCurrentUnversioned', {}, locale),
    'image-refresh-failed': () => t('monitor.diagnostic.imageRefreshFailed', { detail }, locale),
    'image-refresh-unreadable': () => t('monitor.diagnostic.imageRefreshUnreadable', { detail }, locale),
    'map-config-global-unavailable': () => t('monitor.diagnostic.mapConfigGlobalUnavailable', {}, locale),
    'map-policy-unavailable': () => t('monitor.diagnostic.mapPolicyUnavailable', { detail }, locale),
    // M2 (f2): `model-roles-pending:<n>` mirrors the doctor row; a new catalog model refuses every role until a person assigns one.
    'model-roles-pending': () => t('monitor.diagnostic.modelRolesPending', { count: detail }, locale),
    'output-denied': () => t('monitor.diagnostic.outputDenied', {}, locale),
    // f4: the Brain quota wait store (host state): a failed read, waits in scopes the viewer may not read (a count, never a scope), more than the bound.
    'brain-waits-unavailable': () => t('brainwait.monitor.unavailable', { detail: detail ? ` (${detail})` : '' }, locale),
    'brain-waits-hidden': () => t('brainwait.monitor.hidden', { count: detail }, locale),
    'brain-waits-truncated': () => t('brainwait.monitor.truncated', {}, locale),
    'observation-unavailable': () => t('monitor.diagnostic.observationUnavailable', {}, locale),
    // `attempt-files-unavailable:<attempt key>:<CODE>`: the key may itself hold `/`; the code is the last part.
    'attempt-files-unavailable': () => t('monitor.diagnostic.attemptFilesUnavailable', { detail: detail.includes(':') ? detail.slice(0, detail.lastIndexOf(':')) : detail,
      code: detail.includes(':') ? ` (${detail.slice(detail.lastIndexOf(':') + 1)})` : '' }, locale),
  };
  const actions: Readonly<Record<string, () => string>> = {
    'runs-truncated': () => t('monitor.action.runsTruncated', {}, locale),
    'image-refresh-failed': () => t('monitor.action.imageRefreshFailed', {}, locale),
    'model-roles-pending': () => t('monitor.action.modelRolesPending', {}, locale),
  };
  return { code, note, text: Object.hasOwn(words, code) ? words[code]!() : body, ...(Object.hasOwn(actions, code) ? { action: actions[code]!() } : {}) };
}
export const describeDiagnostics = (codes: readonly string[], locale: Locale) => codes.map(code => describeDiagnostic(code, locale));

const NAMED_SCOPE = new Set(['scope-refused', 'scope-failed']);
/**
 * J3 (MON-NAMES item 4): a person's text and window show the first `namedScopeLines` (data: `display.json`) named scope lines in the reader's order,
 * then one "and K more (--verbose)" line; `verbose` shows every one. Other lines and the counts-only form pass through unchanged (JSON is never bounded).
 */
export function boundNamedScopes(entries: readonly MonitorDiagnostic[], locale: Locale, verbose = false): MonitorDiagnostic[] {
  const limit = DISPLAY.namedScopeLines, named = entries.filter(entry => NAMED_SCOPE.has(entry.code)).length;
  if (verbose || named <= limit) return [...entries];
  let shown = 0;
  return entries.flatMap(entry => {
    if (!NAMED_SCOPE.has(entry.code)) return [entry];
    shown += 1;
    return shown <= limit ? [entry] : shown === limit + 1 ? [{ code: 'scope-names-more', note: false, text: t('monitor.diagnostic.scopeNamesMore', { count: named - limit }, locale) }] : [];
  });
}
