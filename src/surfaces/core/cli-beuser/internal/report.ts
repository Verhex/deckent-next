import { createBeuserReport } from '#engine/index.js';
import { t, ErrorRegistry, terminalSafeText, type Locale } from '#platform/index.js';

/** One typed report for human and JSON consumers. Reading/rendering it grants no walk or acceptance authority. */
export function formatBeuserReport(input: unknown, options: { readonly json: boolean; readonly locale: Locale }): string {
  const report = createBeuserReport(input);
  if (options.json) return JSON.stringify(report);
  const locale = options.locale, safe = (value: string) => terminalSafeText(value).replaceAll('\n', ' ');
  const unknown = t('beuser.report.unknownValue', {}, locale);
  const rows = [t('beuser.report.title', {}, locale), t('beuser.report.disclaimer', {}, locale),
    t('beuser.report.cohort', { cohort: safe(report.cohort) }, locale), t('beuser.report.counts', report.counts, locale),
    t('beuser.report.calibration', { ...report.calibration, revision: safe(report.calibration.revision) }, locale),
    t('beuser.report.reliability', report.reliability, locale),
    t('beuser.report.cost', { cost: report.cost ?? unknown, currency: safe(report.currency), elapsedMs: report.elapsedMs ?? unknown }, locale)];
  const filesystemSources = { 'kernel-proven': t('beuser.report.filesystem.kernel-proven', {}, locale),
    'daemon-attested': t('beuser.report.filesystem.daemon-attested', {}, locale), unknown: t('beuser.report.filesystem.unknown', {}, locale) };
  for (const row of report.cleanup ?? []) rows.push(t('beuser.report.cleanup', { branch: safe(row.branch), state: row.state,
    source: filesystemSources[row.filesystemProof.source] }, locale));
  for (const finding of report.findings ?? []) {
    const values = { branch: safe(finding.branch), persona: safe(finding.persona), outcome: finding.outcome,
      screenRef: safe(finding.screenRef), screen: safe(finding.screen), refs: finding.evidenceRefs.map(safe).join(', ') };
    rows.push(finding.reason === 'observing' ? t('beuser.report.observing', values, locale) : t('beuser.report.stuck', values, locale));
  }
  for (const segment of report.segments) {
    const verdict = segment.verdict;
    rows.push(t('beuser.report.segment', { segment: safe(segment.segment), outcome: verdict?.outcome ?? unknown,
      authorization: verdict?.authorization ?? unknown, safety: verdict?.safety ?? unknown,
      experience: verdict?.experience ?? unknown, validity: verdict?.validity ?? unknown, independence: verdict?.independence ?? unknown }, locale));
    const join = (values: readonly string[]) => values.length ? values.map(safe).join(', ') : t('beuser.report.noneRecorded', {}, locale);
    rows.push(t('beuser.report.findings', { broken: join(segment.broken), friction: join(segment.friction), delight: join(segment.delight) }, locale),
      t('beuser.report.evidence', { refs: join(segment.evidenceRefs), owner: safe(segment.nextOwner) }, locale));
  }
  for (const row of report.criticalCoverage) rows.push(t('beuser.report.coverage', { ...row, criterion: safe(row.criterion) }, locale));
  for (const row of report.unwalked) rows.push(t('beuser.report.unwalked', { branch: safe(row.branch), reason: safe(row.reason) }, locale));
  for (const row of report.unknown) {
    const reason = ErrorRegistry.get(row.reason, locale);
    rows.push(t('beuser.report.unknownBranch', { branch: safe(row.branch), reason: safe(row.reason) }, locale));
    if (reason) rows.push(safe(reason.message));
  }
  const unarranged = { 'witness-required': t('beuser.report.unarranged.witness-required', {}, locale), 'realm-external': t('beuser.report.unarranged.realm-external', {}, locale),
    'driver-limit': t('beuser.report.unarranged.driver-limit', {}, locale), 'no-producer': t('beuser.report.unarranged.no-producer', {}, locale),
    'enterprise-only': t('beuser.report.unarranged.enterprise-only', {}, locale), persona: t('beuser.report.unarranged.persona', {}, locale) };
  for (const row of report.unarranged ?? []) rows.push(t('beuser.report.unarranged', { branch: safe(row.branch), state: safe(row.state), reason: unarranged[row.reason] }, locale));
  return rows.join('\n');
}
