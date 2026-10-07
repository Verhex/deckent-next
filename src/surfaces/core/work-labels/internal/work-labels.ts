import { t, type Locale } from '#platform/index.js';
import type { WorkSurfaceLabels, LedgerCardLabels } from '#surfaces/core/terminal/index.js';
import { phaseLabel, processLabel } from '#surfaces/core/monitor/index.js';

// Kept apart from `terminal.ts`: that module reaches Ink/React through the terminal barrel and is loaded only when a terminal opens
// (STARTUP-COST), while these two stay importable from the CLI barrel without it.

/** Words of the run and worker cards: task phase counts, process state and who observed the worker. */
function ledgerCardLabels(locale: Locale): LedgerCardLabels {
  const states = ['running', 'paused', 'created', 'exited', 'missing', 'unknown', 'present-unverified', 'absent-unverified', 'denied'] as const;
  return { runHead: t('terminal.ledger.run.head', {}, locale), runRevision: t('terminal.ledger.run.revision', {}, locale), runCancelRequested: t('terminal.ledger.run.cancelRequested', {}, locale),
    runPhases: { pending: t('terminal.ledger.run.phase.pending', {}, locale), active: t('terminal.ledger.run.phase.active', {}, locale), evaluating: t('terminal.ledger.run.phase.evaluating', {}, locale),
      accepted: t('terminal.ledger.run.phase.accepted', {}, locale), failed: t('terminal.ledger.run.phase.failed', {}, locale), cancelled: t('terminal.ledger.run.phase.cancelled', {}, locale),
      reconciling: t('terminal.ledger.run.phase.reconciling', {}, locale), skipped: t('terminal.ledger.run.phase.skipped', {}, locale),
      'awaiting-decision': t('terminal.ledger.run.phase.awaitingDecision', {}, locale) },
    runPhaseOther: t('terminal.ledger.run.phase.other', {}, locale), runNoTasks: t('terminal.ledger.run.noTasks', {}, locale),
    workerProcess: Object.fromEntries(states.map(state => [state, processLabel(state, locale)])),
    notice: { info: t('terminal.notice.info', {}, locale), warning: t('terminal.notice.warning', {}, locale), error: t('terminal.notice.error', {}, locale) },
    workerAuthority: { 'next-ledger': t('terminal.ledger.worker.authorityLedger', {}, locale), 'legacy-activity': t('terminal.ledger.worker.authorityLegacy', {}, locale) } };
}

/** Catalog-backed labels for the work surface (worker live line, transcript, approvals, run cancel). */
export function workSurfaceLabels(locale: Locale): WorkSurfaceLabels {
  const phases = ['starting', 'thinking', 'reading', 'editing', 'running', 'searching', 'fetching', 'delegating', 'finished', 'failed'] as const;
  return {
    workerLine: { numberLocale: locale, ordinal: t('terminal.worker.ordinal', {}, locale),
      phases: Object.fromEntries(phases.map(phase => [phase, phaseLabel(phase, locale)])) as WorkSurfaceLabels['workerLine']['phases'],
      durationSeconds: t('terminal.duration.seconds', {}, locale), durationMinutes: t('terminal.duration.minutes', {}, locale), durationHours: t('terminal.duration.hours', {}, locale),
      ago: t('terminal.worker.ago', {}, locale), tokens: t('terminal.worker.tokens', {}, locale), tokensCache: t('terminal.worker.tokensCache', {}, locale),
      reported: t('terminal.worker.reported', {}, locale), eventsTruncated: t('terminal.worker.eventsTruncated', {}, locale), dropped: t('terminal.worker.dropped', {}, locale),
      unmapped: t('terminal.worker.unmapped', {}, locale), card: ledgerCardLabels(locale) },
    panel: { title: t('terminal.worker.panelTitle', {}, locale), more: t('terminal.worker.panelMore', {}, locale) },
    unavailable: t('terminal.work.unavailable', {}, locale),
    transcriptUsage: t('terminal.transcript.usage', {}, locale), transcriptNotFound: t('terminal.transcript.notFound', {}, locale),
    transcriptNoAttempt: t('terminal.transcript.noAttempt', {}, locale), transcriptHeader: t('terminal.transcript.header', {}, locale),
    transcriptDetail: t('terminal.transcript.detail', {}, locale),
    transcriptPage: { more: t('terminal.transcript.pageMore', {}, locale), end: t('terminal.transcript.pageEnd', {}, locale), range: t('terminal.transcript.pageRange', {}, locale) },
    sessionStandingClear: { cleared: t('terminal.approval.sessionCleared', {}, locale), unconfirmed: t('terminal.approval.sessionClearUnconfirmed', {}, locale) },
    approvalsNone: t('terminal.approval.none', {}, locale), approvalItem: t('terminal.approval.item', {}, locale), approvalsTruncated: t('terminal.approval.truncated', {}, locale),
    approvalNotFound: t('terminal.approval.notFound', {}, locale), approvalTitle: t('terminal.approval.title', {}, locale), approvalSubject: t('terminal.approval.subject', {}, locale),
    approvalPreviewMore: t('terminal.approval.previewMore', {}, locale),
    approvalExpires: t('terminal.approval.expires', {}, locale), approvalPrompt: t('terminal.approval.prompt', {}, locale), approvalPending: t('terminal.approval.pending', {}, locale),
    approvalAllowed: t('terminal.approval.allowed', {}, locale), approvalDenied: t('terminal.approval.denied', {}, locale),
    approvalUnsettled: t('terminal.approval.unsettled', {}, locale), approvalIdentity: t('terminal.approval.identity', {}, locale), approvalMore: t('terminal.approval.more', {}, locale),
    approvalNotify: t('terminal.approval.notify', {}, locale), approvalPollFailed: t('terminal.approval.pollFailed', {}, locale),
    approvalCard: { risk: t('terminal.approval.card.risk', {}, locale), notDeclared: t('terminal.approval.card.notDeclared', {}, locale),
      onExpiry: t('terminal.approval.card.onExpiry', {}, locale), assuranceTurnHere: t('terminal.approval.card.assuranceTurnHere', {}, locale),
      assuranceTurnElsewhere: t('terminal.approval.card.assuranceTurnElsewhere', {}, locale), assurancePeer: t('terminal.approval.card.assurancePeer', {}, locale),
      assuranceOther: t('terminal.approval.card.assuranceOther', {}, locale) },
    approvalStanding: { covers: t('terminal.approval.standing.covers', {}, locale), promptBoth: t('terminal.approval.standing.promptBoth', {}, locale),
      promptSession: t('terminal.approval.standing.promptSession', {}, locale), promptAlways: t('terminal.approval.standing.promptAlways', {}, locale),
      savedSession: t('terminal.approval.standing.savedSession', {}, locale), savedAlways: t('terminal.approval.standing.savedAlways', {}, locale),
      unconfirmedSession: t('terminal.approval.standing.unconfirmedSession', {}, locale), notSavedSession: t('terminal.approval.standing.notSavedSession', {}, locale), notSavedAlways: t('terminal.approval.standing.notSavedAlways', {}, locale) },
    window: {
      position: t('terminal.window.position', {}, locale),
      pick: t('terminal.window.pick', {}, locale),
      approvalsTitle: t('terminal.window.approvalsTitle', {}, locale),
      resumeTitle: t('terminal.window.resumeTitle', {}, locale),
      restartTitle: t('terminal.window.restartTitle', {}, locale),
      restartDetail: t('terminal.window.restartDetail', {}, locale),
      restartPrompt: t('terminal.window.restartPrompt', {}, locale),
      restartKept: t('terminal.window.restartKept', {}, locale) },
    approvalWindow: approvalWindowLabels(locale),
    cancelUsage: t('terminal.cancel.usage', {}, locale), cancelTitle: t('terminal.cancel.title', {}, locale), cancelDetail: t('terminal.cancel.detail', {}, locale),
    cancelAlreadyRequested: t('terminal.cancel.alreadyRequested', {}, locale), cancelPrompt: t('terminal.cancel.prompt', {}, locale), cancelPending: t('terminal.cancel.pending', {}, locale),
    cancelKept: t('terminal.cancel.kept', {}, locale), cancelIdentity: t('terminal.cancel.identity', {}, locale),
  };
}

/** The approval window's catalog (terminal.approval.window.*): field names, tool names and sentences, rule/risk/undo/mode dictionaries. */
function approvalWindowLabels(locale: Locale): WorkSurfaceLabels['approvalWindow'] {
  return { title: t('terminal.approval.window.title', {}, locale), titleUnknown: t('terminal.approval.window.titleUnknown', {}, locale),
    field: {
      what: t('terminal.approval.window.field.what', {}, locale),
      command: t('terminal.approval.window.field.command', {}, locale),
      file: t('terminal.approval.window.field.file', {}, locale),
      address: t('terminal.approval.window.field.address', {}, locale),
      target: t('terminal.approval.window.field.target', {}, locale),
      where: t('terminal.approval.window.field.where', {}, locale),
      onBehalf: t('terminal.approval.window.field.onBehalf', {}, locale),
      scope: t('terminal.approval.window.field.scope', {}, locale),
      why: t('terminal.approval.window.field.why', {}, locale),
      risk: t('terminal.approval.window.field.risk', {}, locale),
      undo: t('terminal.approval.window.field.undo', {}, locale),
      time: t('terminal.approval.window.field.time', {}, locale),
      preview: t('terminal.approval.window.field.preview', {}, locale),
      detail: t('terminal.approval.window.field.detail', {}, locale) },
    tool: {
      shell: t('terminal.approval.window.tool.shell', {}, locale),
      edit: t('terminal.approval.window.tool.edit', {}, locale),
      write: t('terminal.approval.window.tool.write', {}, locale),
      fetch: t('terminal.approval.window.tool.fetch', {}, locale),
      mcp: t('terminal.approval.window.tool.mcp', {}, locale),
      other: t('terminal.approval.window.tool.other', {}, locale) },
    what: {
      shell: t('terminal.approval.window.what.shell', {}, locale),
      edit: t('terminal.approval.window.what.edit', {}, locale),
      write: t('terminal.approval.window.what.write', {}, locale),
      fetch: t('terminal.approval.window.what.fetch', {}, locale),
      mcp: t('terminal.approval.window.what.mcp', {}, locale),
      other: t('terminal.approval.window.what.other', {}, locale),
      changes: t('terminal.approval.window.what.changes', {}, locale) },
    where: t('terminal.approval.window.where', {}, locale), whereUnknown: t('terminal.approval.window.whereUnknown', {}, locale), onBehalfSelf: t('terminal.approval.window.onBehalfSelf', {}, locale),
    scope: t('terminal.approval.window.scope', {}, locale), why: t('terminal.approval.window.why', {}, locale),
    rule: {
      read: t('terminal.approval.window.rule.read', {}, locale),
      edit: t('terminal.approval.window.rule.edit', {}, locale),
      'edit-floor': t('terminal.approval.window.rule.edit-floor', {}, locale),
      'edit-self-source': t('terminal.approval.window.rule.edit-self-source', {}, locale),
      'edit-authority': t('terminal.approval.window.rule.edit-authority', {}, locale),
      'shell-read-none': t('terminal.approval.window.rule.shell-read-none', {}, locale),
      'shell-read-low': t('terminal.approval.window.rule.shell-read-low', {}, locale),
      'shell-narrow-mutating': t('terminal.approval.window.rule.shell-narrow-mutating', {}, locale),
      'shell-destructive': t('terminal.approval.window.rule.shell-destructive', {}, locale),
      'shell-always-ask': t('terminal.approval.window.rule.shell-always-ask', {}, locale),
      'shell-other-modify': t('terminal.approval.window.rule.shell-other-modify', {}, locale),
      'fetch-listed': t('terminal.approval.window.rule.fetch-listed', {}, locale),
      'fetch-unlisted': t('terminal.approval.window.rule.fetch-unlisted', {}, locale),
      'mcp-call': t('terminal.approval.window.rule.mcp-call', {}, locale),
      'mcp-floor': t('terminal.approval.window.rule.mcp-floor', {}, locale),
      unknown: t('terminal.approval.window.rule.unknown', {}, locale) },
    mode: {
      standart: t('terminal.approval.window.mode.standart', {}, locale),
      'ask-edits': t('terminal.approval.window.mode.ask-edits', {}, locale),
      'full-auto': t('terminal.approval.window.mode.full-auto', {}, locale),
      'full-access': t('terminal.approval.window.mode.full-access', {}, locale),
      unknown: t('terminal.approval.window.mode.unknown', {}, locale) },
    risk: {
      read: t('terminal.approval.window.risk.read', {}, locale),
      edit: t('terminal.approval.window.risk.edit', {}, locale),
      'edit-floor': t('terminal.approval.window.risk.edit-floor', {}, locale),
      'edit-self-source': t('terminal.approval.window.risk.edit-self-source', {}, locale),
      'edit-authority': t('terminal.approval.window.risk.edit-authority', {}, locale),
      'shell-read-none': t('terminal.approval.window.risk.shell-read-none', {}, locale),
      'shell-read-low': t('terminal.approval.window.risk.shell-read-low', {}, locale),
      'shell-narrow-mutating': t('terminal.approval.window.risk.shell-narrow-mutating', {}, locale),
      'shell-destructive': t('terminal.approval.window.risk.shell-destructive', {}, locale),
      'shell-always-ask': t('terminal.approval.window.risk.shell-always-ask', {}, locale),
      'shell-other-modify': t('terminal.approval.window.risk.shell-other-modify', {}, locale),
      'fetch-listed': t('terminal.approval.window.risk.fetch-listed', {}, locale),
      'fetch-unlisted': t('terminal.approval.window.risk.fetch-unlisted', {}, locale),
      'mcp-call': t('terminal.approval.window.risk.mcp-call', {}, locale),
      'mcp-floor': t('terminal.approval.window.risk.mcp-floor', {}, locale),
      'effect-read': t('terminal.approval.window.risk.effect-read', {}, locale),
      'effect-write': t('terminal.approval.window.risk.effect-write', {}, locale),
      'effect-irreversible': t('terminal.approval.window.risk.effect-irreversible', {}, locale),
      authority: t('terminal.approval.window.risk.authority', {}, locale),
      unknown: t('terminal.approval.window.risk.unknown', {}, locale) },
    undo: {
      irreversible: t('terminal.approval.window.undo.irreversible', {}, locale),
      none: t('terminal.approval.window.undo.none', {}, locale),
      compensation: t('terminal.approval.window.undo.compensation', {}, locale),
      unknown: t('terminal.approval.window.undo.unknown', {}, locale) },
    time: t('terminal.approval.window.time', {}, locale), expired: t('terminal.approval.window.expired', {}, locale), ageUnknown: t('terminal.approval.window.ageUnknown', {}, locale), previewCut: t('terminal.approval.window.previewCut', {}, locale), valueMore: t('terminal.approval.window.valueMore', {}, locale),
    detail: {
      id: t('terminal.approval.window.detail.id', {}, locale),
      binding: t('terminal.approval.window.detail.binding', {}, locale),
      digest: t('terminal.approval.window.detail.digest', {}, locale),
      kept: t('terminal.approval.window.detail.kept', {}, locale),
      notKept: t('terminal.approval.window.detail.notKept', {}, locale),
      classifier: t('terminal.approval.window.detail.classifier', {}, locale),
      run: t('terminal.approval.window.detail.run', {}, locale),
      cell: t('terminal.approval.window.detail.cell', {}, locale),
      compensation: t('terminal.approval.window.detail.compensation', {}, locale),
      assurance: t('terminal.approval.window.detail.assurance', {}, locale),
      requester: t('terminal.approval.window.detail.requester', {}, locale),
      engine: t('terminal.approval.window.detail.engine', {}, locale) },
    sessionCovers: t('terminal.approval.window.sessionCovers', {}, locale), alwaysCovers: t('terminal.approval.window.alwaysCovers', {}, locale),
    keys: {
      once: t('terminal.approval.window.keys.once', {}, locale),
      session: t('terminal.approval.window.keys.session', {}, locale),
      always: t('terminal.approval.window.keys.always', {}, locale),
      deny: t('terminal.approval.window.keys.deny', {}, locale),
      reason: t('terminal.approval.window.keys.reason', {}, locale),
      scroll: t('terminal.approval.window.keys.scroll', {}, locale) },
    reason: {
      label: t('terminal.approval.window.reason.label', {}, locale),
      hint: t('terminal.approval.window.reason.hint', {}, locale),
      empty: t('terminal.approval.window.reason.empty', {}, locale) } };
}

/** A terminal from a compiled build talking to a service from another (or an unknown, older) build. Source runs never warn. */
export function runtimeBuildSkew(own: { readonly sourceTreeSha256: string } | null, service: { readonly sourceTreeSha256: string } | null):
  { readonly service: string | null; readonly terminal: string } | null {
  if (!own || service?.sourceTreeSha256 === own.sourceTreeSha256) return null;
  return { service: service ? service.sourceTreeSha256.slice(0, 12) : null, terminal: own.sourceTreeSha256.slice(0, 12) };
}

