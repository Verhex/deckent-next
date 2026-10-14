import type { AuditVerification } from '#domain/index.js';
import { t, type Locale } from '#platform/index.js';
export function renderAuditStatus(status: AuditVerification['status'], locale: Locale): string {
  return { match: t('cli.audit.status.match', {}, locale), truncated: t('cli.audit.status.truncated', {}, locale),
    'possible-wipe': t('cli.audit.status.possible-wipe', {}, locale),
    'policy-changed': t('cli.audit.status.policy-changed', {}, locale), 'producers-changed': t('cli.audit.status.producers-changed', {}, locale),
    'chain-broken': t('cli.audit.status.chain-broken', {}, locale), unknown: t('cli.audit.status.unknown', {}, locale) }[status];
}
export function renderAuditReason(reason: AuditVerification['reason'], locale: Locale): string {
  return { verified: t('cli.audit.reason.verified', {}, locale), 'no-checkpoint-yet': t('cli.audit.reason.no-checkpoint-yet', {}, locale),
    unavailable: t('cli.audit.reason.unavailable', {}, locale), limit: t('cli.audit.reason.limit', {}, locale),
    'foreign-witness': t('cli.audit.reason.foreign-witness', {}, locale), 'key-unavailable': t('cli.audit.reason.key-unavailable', {}, locale),
    integrity: t('cli.audit.reason.integrity', {}, locale), 'head-missing': t('cli.audit.reason.head-missing', {}, locale),
    'checkpoints-missing': t('cli.audit.reason.checkpoints-missing', {}, locale),
    policy: t('cli.audit.reason.policy', {}, locale), producers: t('cli.audit.reason.producers', {}, locale) }[reason];
}
