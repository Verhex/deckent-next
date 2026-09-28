import { t, type Locale } from '#platform/index.js';
import type { WorkSurfaceLabels } from '#surfaces/core/terminal/index.js';
import { phaseLabel } from './transcript.js';

// Kept apart from `terminal.ts`: that module reaches Ink/React through the terminal barrel and is loaded only when a terminal opens
// (STARTUP-COST), while these two stay importable from the CLI barrel without it.

/** Catalog-backed labels for the work surface (worker live line, transcript, approvals, run cancel). */
export function workSurfaceLabels(locale: Locale): WorkSurfaceLabels {
  const phases = ['starting', 'thinking', 'reading', 'editing', 'running', 'searching', 'fetching', 'delegating', 'finished', 'failed'] as const;
  return {
    workerLine: { numberLocale: locale, ordinal: t('terminal.worker.ordinal', {}, locale),
      phases: Object.fromEntries(phases.map(phase => [phase, phaseLabel(phase, locale)])) as WorkSurfaceLabels['workerLine']['phases'],
      durationSeconds: t('terminal.duration.seconds', {}, locale), durationMinutes: t('terminal.duration.minutes', {}, locale), durationHours: t('terminal.duration.hours', {}, locale),
      ago: t('terminal.worker.ago', {}, locale), tokens: t('terminal.worker.tokens', {}, locale), tokensCache: t('terminal.worker.tokensCache', {}, locale),
      reported: t('terminal.worker.reported', {}, locale), eventsTruncated: t('terminal.worker.eventsTruncated', {}, locale), dropped: t('terminal.worker.dropped', {}, locale),
      unmapped: t('terminal.worker.unmapped', {}, locale) },
    panel: { title: t('terminal.worker.panelTitle', {}, locale), more: t('terminal.worker.panelMore', {}, locale) },
    unavailable: t('terminal.work.unavailable', {}, locale),
    transcriptUsage: t('terminal.transcript.usage', {}, locale), transcriptNotFound: t('terminal.transcript.notFound', {}, locale),
    transcriptNoAttempt: t('terminal.transcript.noAttempt', {}, locale), transcriptHeader: t('terminal.transcript.header', {}, locale),
    approvalsNone: t('terminal.approval.none', {}, locale), approvalItem: t('terminal.approval.item', {}, locale), approvalsTruncated: t('terminal.approval.truncated', {}, locale),
    approvalNotFound: t('terminal.approval.notFound', {}, locale), approvalTitle: t('terminal.approval.title', {}, locale), approvalSubject: t('terminal.approval.subject', {}, locale),
    approvalPreviewMore: t('terminal.approval.previewMore', {}, locale),
    approvalExpires: t('terminal.approval.expires', {}, locale), approvalPrompt: t('terminal.approval.prompt', {}, locale), approvalPending: t('terminal.approval.pending', {}, locale),
    approvalAllowed: t('terminal.approval.allowed', {}, locale), approvalDenied: t('terminal.approval.denied', {}, locale),
    approvalUnsettled: t('terminal.approval.unsettled', {}, locale), approvalMore: t('terminal.approval.more', {}, locale),
    approvalNotify: t('terminal.approval.notify', {}, locale), approvalPollFailed: t('terminal.approval.pollFailed', {}, locale),
    cancelUsage: t('terminal.cancel.usage', {}, locale), cancelTitle: t('terminal.cancel.title', {}, locale), cancelDetail: t('terminal.cancel.detail', {}, locale),
    cancelAlreadyRequested: t('terminal.cancel.alreadyRequested', {}, locale), cancelPrompt: t('terminal.cancel.prompt', {}, locale), cancelPending: t('terminal.cancel.pending', {}, locale),
    cancelKept: t('terminal.cancel.kept', {}, locale),
  };
}

/** A terminal from a compiled build talking to a service from another (or an unknown, older) build. Source runs never warn. */
export function runtimeBuildSkew(own: { readonly sourceTreeSha256: string } | null, service: { readonly sourceTreeSha256: string } | null):
  { readonly service: string | null; readonly terminal: string } | null {
  if (!own || service?.sourceTreeSha256 === own.sourceTreeSha256) return null;
  return { service: service ? service.sourceTreeSha256.slice(0, 12) : null, terminal: own.sourceTreeSha256.slice(0, 12) };
}

