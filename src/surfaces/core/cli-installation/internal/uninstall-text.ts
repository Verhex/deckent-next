import { t, type Locale } from '#platform/index.js';

/** Closed, translated projection vocabulary; unknown extension codes keep their machine value in JSON. */
export function uninstallMessages(locale: Locale): Readonly<Record<string, string>> {
  return {
    'blocker.backup-destination': t('cli.uninstall.blocker.backup-destination', {}, locale),
    'state.claimed': t('cli.uninstall.state.claimed', {}, locale),
    'state.settled': t('cli.uninstall.state.settled', {}, locale),
    'state.unknown': t('cli.uninstall.state.unknown', {}, locale),
    'state.refused': t('cli.uninstall.state.refused', {}, locale),
    'state.kept': t('cli.uninstall.state.kept', {}, locale),
    'reason.absent': t('cli.uninstall.reason.absent', {}, locale),
    'reason.protected': t('cli.uninstall.reason.protected', {}, locale),
    'reason.ownership': t('cli.uninstall.reason.ownership', {}, locale),
    'reason.durable': t('cli.uninstall.reason.durable', {}, locale),
    'reason.protected-session': t('cli.uninstall.reason.protected-session', {}, locale),
    'reason.non-exportable': t('cli.uninstall.reason.non-exportable', {}, locale),
    'reason.observation-unknown': t('cli.uninstall.reason.observation-unknown', {}, locale),
    'reason.unsupported': t('cli.uninstall.reason.unsupported', {}, locale),
    'reason.backup-coverage': t('cli.uninstall.reason.backup-coverage', {}, locale),
    'reason.owned': t('cli.uninstall.reason.owned', {}, locale),
    'reason.unsafe-path': t('cli.uninstall.reason.unsafe-path', {}, locale),
    'reason.service-unresolved': t('cli.uninstall.reason.service-unresolved', {}, locale),
    'reason.retained-overlap': t('cli.uninstall.reason.retained-overlap', {}, locale),
    'reason.dependency-unresolved': t('cli.uninstall.reason.dependency-unresolved', {}, locale),
    'reason.resume': t('cli.uninstall.reason.resume', {}, locale),
  };
}

export function uninstallStatusMessage(status: import('#engine/index.js').UninstallResult['status'], locale: Locale): string {
  return {
    completed: t('cli.uninstall.status.completed', {}, locale),
    noop: t('cli.uninstall.status.noop', {}, locale),
    cancelled: t('cli.uninstall.status.cancelled', {}, locale),
    partial: t('cli.uninstall.status.partial', {}, locale),
    unknown: t('cli.uninstall.status.unknown', {}, locale),
  }[status];
}
