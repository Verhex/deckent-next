import { t } from '#platform/index.js';
import type { MonitorInstall } from '#engine/index.js';
import { span, type MonitorBlock, type MonitorCardEntry, type MonitorLine, type MonitorRole, type MonitorSpan } from '#surfaces/core/monitor-view/index.js';
import { installStatusLabel } from './labels.js';
import type { Words } from './view.js';

/** `current` is the folder the monitor runs in: shown by its folder name (`project (current)`), every other install by its configured id. */
export const installName = (install: MonitorInstall) => {
  const folder = install.path.split(/[\\/]/).filter(Boolean).at(-1);
  return install.id === 'current' && folder ? `${folder} (${install.id})` : install.id;
};
/** One status word for the whole install: reachable and serving, stopped, unknown, or why it cannot be read. */
export function installState(w: Words, install: MonitorInstall): MonitorSpan {
  const { locale } = w;
  if (install.status === 'unavailable') return span(t('monitor.installState.unavailable', {}, locale), 'error');
  if (install.status === 'denied') return span(t('monitor.installState.denied', {}, locale), 'error');
  const state = install.service?.state;
  return state === 'running' ? span(t('monitor.installState.running', {}, locale), 'success') : state === 'stopped' ? span(t('monitor.installState.stopped', {}, locale), 'muted')
    : state === 'unknown' ? span(t('monitor.installState.unknown', {}, locale), 'warning') : span(t('monitor.installState.none', {}, locale), 'muted');
}
/** The warning count (or "no problems") the header and the card heading show. */
export function problemsSpan(w: Words, install: MonitorInstall): MonitorSpan {
  const count = w.problemCount(install);
  return count ? span(`${w.marks.warn} ${t('monitor.diagnostics', { count }, w.locale)}`, 'warning') : span(`${w.marks.ok} ${t('monitor.install.noProblems', {}, w.locale)}`, 'success');
}

/** Durum: service, ledger and worker image as ✓/!/○ checks (the image check only when the install reports one). */
function checks(w: Words, install: MonitorInstall): MonitorLine {
  const { locale, marks } = w, codes = install.diagnostics.map(code => code.replace(/^info:/, '').split(':')[0]);
  const check = (mark: string, role: MonitorRole, text: string) => span(`${mark} ${text}`, role);
  const service = install.service?.state === 'running' ? check(marks.ok, 'success', t('monitor.check.serviceRunning', {}, locale))
    : install.service?.state === 'stopped' ? check(marks.off, 'muted', t('monitor.check.serviceStopped', {}, locale))
      : install.service?.state === 'unknown' ? check(marks.warn, 'warning', t('monitor.check.serviceUnknown', {}, locale)) : check(marks.off, 'muted', t('monitor.check.serviceNone', {}, locale));
  const stale = codes.includes('ledger-version-older') || codes.includes('ledger-version-unsupported');
  const ledger = install.ledgerVersion === null ? check(marks.warn, 'warning', t('monitor.check.ledgerUnknown', {}, locale))
    : stale ? check(marks.warn, 'warning', t('monitor.check.ledgerOlder', { version: install.ledgerVersion }, locale))
      : check(marks.ok, 'success', t('monitor.check.ledger', { version: install.ledgerVersion }, locale));
  const image = codes.includes('image-refresh-failed') || codes.includes('image-refresh-unreadable') ? [check(marks.warn, 'warning', t('monitor.check.imageFailed', {}, locale))]
    : codes.includes('image-updating') ? [check(marks.off, 'muted', t('monitor.check.imageUpdating', {}, locale))]
      : codes.includes('image-current') ? [check(marks.ok, 'success', t('monitor.check.imageCurrent', {}, locale))] : [];
  return [service, ledger, ...image].flatMap((part, index) => index ? [span(w.sep, 'muted'), part] : [part]);
}

/**
 * Kurulumlar (PB-MON-UX, owner-accepted mock): one framed card per install. The heading says whether it runs and how many problems it
 * has; the first section is the status checks, then each problem with its next step; then workload, scope and folder; developer details
 * (build, service process) last. Enter on the heading opens every detail as sentences.
 */
export function installsBlocks(w: Words, installs: readonly MonitorInstall[]): MonitorBlock[] {
  const { locale, marks, sep } = w;
  const label = (text: string, role?: MonitorRole) => span(text, role);
  const entry = (name: string, value: MonitorLine | string, role?: MonitorRole): MonitorCardEntry => ({ label: label(name, role), value: typeof value === 'string' ? [span(value, role === 'keyLabel' ? undefined : role)] : value });
  const detail = (install: MonitorInstall) => (): readonly MonitorLine[] => [
    [span(t('monitor.detail.install', { install: install.id, status: installStatusLabel(install.status, locale) }, locale), 'strong')],
    [span(t('monitor.detail.path', { path: install.path }, locale))],
    [span(t('monitor.detail.scopes', { scopes: install.scopeIds.join(', ') || '—' }, locale))],
    [span(`${w.serviceText(install)}${sep}${t('monitor.detail.instance', { instance: install.service?.instanceId ?? '—' }, locale)}`)],
    [span(w.buildText(install))], [span(w.ledgerText(install))],
    [span(t('monitor.detail.counts', { runs: install.runs.length, workers: install.workers.length, approvals: install.approvals.length, pools: install.pools.length }, locale), 'muted')],
    ...w.warnings(install).map(entry => [span(`${marks.warn} ${entry.text}`, 'warning')]),
    ...w.notes(install).map(entry => [span(`${t('monitor.note', {}, locale)} ${entry.text}`, 'muted')]),
  ];
  // Image notes are already a status check; every other note keeps its own line.
  const IMAGE = new Set(['image-current', 'image-updating']);
  const cards = installs.map((install): MonitorBlock => {
    const pending = install.approvals.filter(approval => approval.status === undefined || approval.status === 'pending').length;
    const problems = w.warnings(install).flatMap(item => [entry(`${marks.warn} ${t('monitor.card.warning', {}, locale)}`, item.text, 'warning'),
      ...(item.action ? [entry(`${marks.next} ${t('monitor.card.action', {}, locale)}`, item.action, 'info')] : [])]);
    const notes = w.notes(install).filter(item => !IMAGE.has(item.code)).flatMap(item => [entry(`${marks.off} ${t('monitor.card.note', {}, locale)}`, item.text, 'muted'),
      ...(item.action ? [entry(`${marks.next} ${t('monitor.card.action', {}, locale)}`, item.action, 'info')] : [])]);
    const workload = [span(t('monitor.card.workloadValue', { runs: install.runs.length, workers: install.workers.length, approvals: pending, pools: install.pools.length }, locale)),
      ...(install.hiddenPools ? [span(`${sep}${t('monitor.card.hiddenPools', { count: install.hiddenPools }, locale)}`, 'muted')] : [])];
    const service = install.service?.processId || install.service?.instanceId
      ? [entry(t('monitor.card.service', {}, locale), t('monitor.card.serviceValue', { pid: install.service.processId ?? '—', instance: install.service.instanceId ?? '—' }, locale), 'keyLabel')] : [];
    return { kind: 'card', head: [span(`${install.status === 'available' ? marks.on : marks.off} ${installName(install)}`, 'sectionHeader'), span('   '), installState(w, install),
      span('   '), problemsSpan(w, install)],
    sections: [[entry(t('monitor.card.status', {}, locale), checks(w, install), 'keyLabel'), ...problems, ...notes],
      [entry(t('monitor.card.workload', {}, locale), workload, 'keyLabel'), entry(t('monitor.card.scopes', {}, locale), install.scopeIds.join(', ') || '—', 'keyLabel'),
        entry(t('monitor.card.folder', {}, locale), install.path, 'keyLabel')],
      [entry(t('monitor.card.version', {}, locale), w.buildText(install), 'keyLabel'), ...service]],
    row: { key: install.id, cells: [span(install.id), installState(w, install)], detail: detail(install), facets: { state: install.status, install: install.id.toLowerCase() },
      signature: `${install.status}|${install.service?.state ?? ''}|${install.service?.build?.sourceCommit ?? ''}|${w.problemCount(install)}` } };
  });
  if (!installs.length) return [{ kind: 'line', line: [span(`  ${t('monitor.empty.installs', {}, locale)}`, 'muted')] }];
  return [...cards.flatMap((card, index) => index ? [{ kind: 'line' as const, line: [span('')] }, card] : [card]),
    ...(installs.length === 1 && installs[0]!.id === 'current' ? [{ kind: 'line' as const, line: [span('')] }, { kind: 'line' as const, line: [span(t('monitor.empty.otherInstalls', {}, locale), 'muted')] }] : [])];
}
