import { t, type Locale } from '#platform/index.js';

/**
 * Install diagnostics in words (MONITOR v1.1). A data-lane code is `name[:detail]` (split on the first `:` only — `scope-unavailable:<scope>:<CODE>`
 * keeps its second part in the detail). An `info:` prefix makes it a neutral note (never a ⚠ warning, never counted as a problem). An unknown
 * code stays visible as itself, so a new code from the data lane is never hidden.
 */
export interface MonitorDiagnostic { readonly code: string; readonly note: boolean; readonly text: string }

export function describeDiagnostic(raw: string, locale: Locale): MonitorDiagnostic {
  const note = raw.startsWith('info:'), body = note ? raw.slice(5) : raw, at = body.indexOf(':');
  const code = at < 0 ? body : body.slice(0, at), detail = at < 0 ? '' : body.slice(at + 1);
  const words: Readonly<Record<string, () => string>> = {
    'service-unavailable': () => t('monitor.diagnostic.serviceUnavailable', { detail }, locale),
    'ledger-unavailable': () => t('monitor.diagnostic.ledgerUnavailable', { detail }, locale),
    'ledger-version-older': () => t('monitor.diagnostic.ledgerVersionOlder', { detail }, locale),
    'scope-denied': () => t('monitor.diagnostic.scopeDenied', { detail }, locale),
    // `scope-unavailable:<scope>:<CODE>`: the scope, then why.
    'scope-unavailable': () => t('monitor.diagnostic.scopeUnavailable', { detail: detail.split(':')[0]!, code: detail.includes(':') ? ` (${detail.split(':').slice(1).join(':')})` : '' }, locale),
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
    'ledger-only': () => t('monitor.diagnostic.ledgerOnly', { detail }, locale),
    'ledger-version-unsupported': () => t('monitor.diagnostic.ledgerVersionUnsupported', { detail }, locale),
    'approvals-denied': () => t('monitor.diagnostic.approvalsDenied', { detail }, locale),
    'map-config-global-unavailable': () => t('monitor.diagnostic.mapConfigGlobalUnavailable', {}, locale),
    'map-policy-unavailable': () => t('monitor.diagnostic.mapPolicyUnavailable', { detail }, locale),
    'output-denied': () => t('monitor.diagnostic.outputDenied', {}, locale),
    'observation-unavailable': () => t('monitor.diagnostic.observationUnavailable', {}, locale),
    // `attempt-files-unavailable:<attempt key>:<CODE>`: the key may itself hold `/`; the code is the last part.
    'attempt-files-unavailable': () => t('monitor.diagnostic.attemptFilesUnavailable', { detail: detail.includes(':') ? detail.slice(0, detail.lastIndexOf(':')) : detail,
      code: detail.includes(':') ? ` (${detail.slice(detail.lastIndexOf(':') + 1)})` : '' }, locale),
  };
  return { code, note, text: Object.hasOwn(words, code) ? words[code]!() : body };
}
export const describeDiagnostics = (codes: readonly string[], locale: Locale) => codes.map(code => describeDiagnostic(code, locale));
