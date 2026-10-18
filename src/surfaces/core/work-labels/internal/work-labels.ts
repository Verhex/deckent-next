import { queueWindowLabels } from './queue-labels.js';
import { t, type Locale } from '#platform/index.js';
import type { WorkSurfaceLabels, LedgerCardLabels } from '#surfaces/core/terminal/index.js';
import type { PickerLabels } from '#surfaces/core/terminal-picker/index.js';
import type { DeliveryWindowLabels } from '#surfaces/core/terminal-delivery/index.js';
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
/** T2-FOLLOWUP: the approval window's undo words (REVERSIBILITY) and its structured sandbox posture words (POSTURE). */
function approvalWindowFactLabels(locale: Locale): Pick<WorkSurfaceLabels['approvalWindow'], 'undo' | 'posture'> {
  return {
    undo: {
      none: t('terminal.approval.window.undo.none', {}, locale),
      compensation: t('terminal.approval.window.undo.compensation', {}, locale),
      unknown: t('terminal.approval.window.undo.unknown', {}, locale),
      irreversible: t('terminal.approval.window.undo.irreversible', {}, locale),
      unverified: t('terminal.approval.window.undo.unverified', {}, locale),
      'may-change': t('terminal.approval.window.undo.may-change', {}, locale),
      'no-change': t('terminal.approval.window.undo.no-change', {}, locale),
      'server-read-only': t('terminal.approval.window.undo.server-read-only', {}, locale),
      'server-additive': t('terminal.approval.window.undo.server-additive', {}, locale),
      'server-destructive': t('terminal.approval.window.undo.server-destructive', {}, locale),
      'server-silent': t('terminal.approval.window.undo.server-silent', {}, locale) },
    posture: {
      sandbox: t('terminal.approval.window.posture.sandbox', {}, locale), host: t('terminal.approval.window.posture.host', {}, locale),
      degraded: t('terminal.approval.window.posture.degraded', {}, locale), passedOver: t('terminal.approval.window.posture.passedOver', {}, locale),
      project: { writable: t('terminal.approval.window.posture.project.writable', {}, locale),
        'writable-except-floor': t('terminal.approval.window.posture.project.writable-except-floor', {}, locale),
        'read-only': t('terminal.approval.window.posture.project.read-only', {}, locale), 'write-set': t('terminal.approval.window.posture.project.write-set', {}, locale) },
      git: { writable: t('terminal.approval.window.posture.git.writable', {}, locale), 'read-only': t('terminal.approval.window.posture.git.read-only', {}, locale) },
      network: { reachable: t('terminal.approval.window.posture.network.reachable', {}, locale), closed: t('terminal.approval.window.posture.network.closed', {}, locale) } }
  };
}

export function workSurfaceLabels(locale: Locale): WorkSurfaceLabels {
  const phases = ['starting', 'thinking', 'reading', 'editing', 'running', 'searching', 'fetching', 'delegating', 'finished', 'failed'] as const;
  return {
    runControl: { hints: t('terminal.runControl.hints', {}, locale), keyHold: t('terminal.runControl.keyHold', {}, locale),
      keyResume: t('terminal.runControl.keyResume', {}, locale), keyClose: t('terminal.runControl.keyClose', {}, locale),
      noKeys: t('terminal.runControl.noKeys', {}, locale), holdTitle: t('terminal.runControl.holdTitle', {}, locale),
      resumeTitle: t('terminal.runControl.resumeTitle', {}, locale), closeTitle: t('terminal.runControl.closeTitle', {}, locale),
      holdDetail: t('terminal.runControl.holdDetail', {}, locale), resumeDetail: t('terminal.runControl.resumeDetail', {}, locale),
      closeDetail: t('terminal.runControl.closeDetail', {}, locale), state: t('terminal.runControl.state', {}, locale),
      identity: t('terminal.runControl.identity', {}, locale), prompt: t('terminal.runControl.prompt', {}, locale),
      holdPrompt: t('terminal.runControl.holdPrompt', {}, locale), pending: t('terminal.runControl.pending', {}, locale), kept: t('terminal.runControl.kept', {}, locale),
      gone: t('terminal.runControl.gone', {}, locale), reason: { label: t('terminal.runControl.reason.label', {}, locale), hint: t('terminal.runControl.reason.hint', {}, locale), empty: t('terminal.runControl.reason.empty', {}, locale) } },
    jobs: {
      locale, completed: t('terminal.jobs.completed', {}, locale), deliveryCounts: t('terminal.jobs.deliveryCounts', {}, locale), deliveryPatch: t('terminal.jobs.deliveryPatch', {}, locale), deliveryNext: t('terminal.jobs.deliveryNext', {}, locale),
      detailsUnavailable: t('terminal.jobs.detailsUnavailable', {}, locale), trackingFull: t('terminal.jobs.trackingFull', {}, locale),
      hints: t('terminal.jobs.hints', {}, locale), watchStatus: t('terminal.jobs.watchStatus', {}, locale), push: t('terminal.jobs.push', {}, locale), poll: t('terminal.jobs.poll', {}, locale),
      system: t('terminal.info.systemLabel', {}, locale), cancelPickerTitle: t('terminal.jobs.cancelPickerTitle', {}, locale), runTitle: t('terminal.jobs.runTitle', {}, locale), runFallback: t('terminal.jobs.runFallback', {}, locale),
      transcriptTitle: t('terminal.jobs.transcriptTitle', {}, locale), state: t('terminal.jobs.state', {}, locale), tasks: t('terminal.jobs.tasks', {}, locale),
      attempts: t('terminal.jobs.attempts', {}, locale), delivery: t('terminal.jobs.delivery', {}, locale), unknown: t('terminal.jobs.unknown', {}, locale),
      clearSession: t('terminal.jobs.clearSession', {}, locale), clearDetail: t('terminal.jobs.clearDetail', {}, locale), kept: t('terminal.jobs.kept', {}, locale),
      closed: t('terminal.jobs.closed', {}, locale), opening: t('terminal.jobs.opening', {}, locale),
      runStates: { 'running': t('terminal.jobs.state.running', {}, locale), 'parked': t('terminal.jobs.state.parked', {}, locale), 'completed': t('terminal.jobs.state.completed', {}, locale), 'incomplete': t('terminal.jobs.state.incomplete', {}, locale), 'failed': t('terminal.jobs.state.failed', {}, locale), 'cancelled': t('terminal.jobs.state.cancelled', {}, locale), 'unknown': t('terminal.jobs.state.unknown', {}, locale), 'integrating': t('terminal.jobs.state.integrating', {}, locale), 'integrated': t('terminal.jobs.state.integrated', {}, locale), 'delivering': t('terminal.jobs.state.delivering', {}, locale), 'delivered': t('terminal.jobs.state.delivered', {}, locale), 'adopting': t('terminal.jobs.state.adopting', {}, locale), 'adopted': t('terminal.jobs.state.adopted', {}, locale), 'rolling-back': t('terminal.jobs.state.rolling-back', {}, locale), 'rolled-back': t('terminal.jobs.state.rolled-back', {}, locale) },
      parkReasons: { 'dependency-failed': t('terminal.jobs.parked.dependency-failed', {}, locale), 'dependency-cancelled': t('terminal.jobs.parked.dependency-cancelled', {}, locale),
        'awaiting-decision': t('terminal.jobs.parked.awaiting-decision', {}, locale), 'evaluation-not-ready': t('terminal.jobs.parked.evaluation-not-ready', {}, locale),
        'needs-input': t('terminal.jobs.parked.needs-input', {}, locale), 'operator-hold': t('terminal.jobs.parked.operator-hold', {}, locale),
        'progression-failed': t('terminal.jobs.parked.progression-failed', {}, locale), 'quota-exhausted': t('terminal.jobs.parked.quota-exhausted', {}, locale) },
      parkCode: t('terminal.jobs.parkCode', {}, locale), parkNote: t('terminal.jobs.parkNote', {}, locale) },
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
    activeWork: { title: t('terminal.activeWork.title', {}, locale), focused: t('terminal.activeWork.focused', {}, locale), doTitle: t('terminal.activeWork.doTitle', {}, locale),
      planning: t('terminal.activeWork.planning', {}, locale), waiting: t('terminal.activeWork.waiting', {}, locale), expired: t('terminal.activeWork.expired', {}, locale),
      evaluating: t('terminal.activeWork.evaluating', {}, locale), needsYou: t('terminal.activeWork.needsYou', {}, locale), more: t('terminal.activeWork.more', {}, locale),
      deliveryWaiting: t('terminal.activeWork.deliveryWaiting', {}, locale) },
    live: { monitorTitle: t('terminal.live.monitorTitle', {}, locale), runsTitle: t('terminal.live.runsTitle', {}, locale), tasksTitle: t('terminal.live.tasksTitle', {}, locale),
      hints: t('terminal.live.hints', {}, locale), tasksHints: t('terminal.live.tasksHints', {}, locale), watchHints: t('terminal.live.watchHints', {}, locale), monitorHints: t('terminal.live.monitorHints', {}, locale), statusWorkers: t('terminal.live.statusWorkers', {}, locale),
      statusRuns: t('terminal.live.statusRuns', {}, locale), statusTasks: t('terminal.live.statusTasks', {}, locale), empty: t('terminal.live.empty', {}, locale),
      runsMore: t('terminal.live.runsMore', {}, locale), closedWorkers: t('terminal.live.closedWorkers', {}, locale), closedRuns: t('terminal.live.closedRuns', {}, locale),
      closedTasks: t('terminal.live.closedTasks', {}, locale), closedMonitor: t('terminal.live.closedMonitor', {}, locale), monitorFailed: t('terminal.live.monitorFailed', {}, locale) },
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
    config: { title: t('terminal.approval.window.config.title', {}, locale), scope: t('terminal.approval.window.config.scope', {}, locale),
      why: t('terminal.approval.window.config.why', {}, locale), undo: t('terminal.approval.window.config.undo', {}, locale),
      layers: { project: t('config.surface.source.project', {}, locale), global: t('config.surface.source.global', {}, locale) } },
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
    ...approvalWindowFactLabels(locale),
    time: t('terminal.approval.window.time', {}, locale), expired: t('terminal.approval.window.expired', {}, locale), ageUnknown: t('terminal.approval.window.ageUnknown', {}, locale), previewCut: t('terminal.approval.window.previewCut', {}, locale), valueMore: t('terminal.approval.window.valueMore', {}, locale),
    fullCommand: t('terminal.approval.window.fullCommand', {}, locale), noStructured: t('terminal.approval.window.noStructured', {}, locale),
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
      scroll: t('terminal.approval.window.keys.scroll', {}, locale), choose: t('terminal.approval.window.keys.choose', {}, locale) },
    choices: { once: t('terminal.approval.window.choice.once', {}, locale), session: t('terminal.approval.window.choice.session', {}, locale),
      always: t('terminal.approval.window.choice.always', {}, locale), no: t('terminal.approval.window.choice.no', {}, locale) },
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


/** Catalog words of the list picker (filter, paging, scope step, blocked rows); one set for every picker, EN and TR. */
export function pickerLabels(locale: Locale): PickerLabels {
  return { hintList: t('tui.picker.hint_pick', {}, locale), hintFilter: t('tui.picker.hint_filter_esc', {}, locale), hintScope: t('tui.picker.hint_scope', {}, locale),
    filter: t('tui.picker.hint_filter', {}, locale), noMatches: t('tui.picker.no_matches', {}, locale), empty: t('tui.picker.empty', {}, locale),
    blocked: t('tui.picker.state.blocked', {}, locale), position: t('tui.picker.position', {}, locale) };
}

/** TESLIM-PENCERESI: the words of the terminal delivery window; `next` names the next step of the typed refusals it explains (others: `nextDefault`). */
export function deliveryWindowLabels(locale: Locale): DeliveryWindowLabels {
  return { queue: queueWindowLabels(locale),
    title: t('terminal.delivery.title', {}, locale), ids: t('terminal.delivery.ids', {}, locale), loading: t('terminal.delivery.loading', {}, locale),
    check: t('terminal.delivery.check', {}, locale), outOfScope: t('terminal.delivery.outOfScope', {}, locale), summary: t('terminal.delivery.summary', {}, locale),
    file: t('terminal.delivery.file', {}, locale), moreFiles: t('terminal.delivery.moreFiles', {}, locale), where: t('terminal.delivery.where', {}, locale),
    adoptionLater: t('terminal.delivery.adoptionLater', {}, locale), hints: t('terminal.delivery.hints', {}, locale),
    working: t('terminal.delivery.working', {}, locale), confirmBody: t('terminal.delivery.confirmBody', {}, locale),
    confirmRef: t('terminal.delivery.confirmRef', {}, locale), confirmHints: t('terminal.delivery.confirmHints', {}, locale),
    delivered: t('terminal.delivery.delivered', {}, locale), adoptPrompt: t('terminal.delivery.adoptPrompt', {}, locale),
    adoptTarget: t('terminal.delivery.adoptTarget', {}, locale), adoptHints: t('terminal.delivery.adoptHints', {}, locale),
    adopting: t('terminal.delivery.adopting', {}, locale), adopted: t('terminal.delivery.adopted', {}, locale), doneHints: t('terminal.delivery.doneHints', {}, locale),
    failedHints: t('terminal.delivery.failedHints', {}, locale), summaryDelivered: t('terminal.delivery.summaryDelivered', {}, locale),
    summaryAdopted: t('terminal.delivery.summaryAdopted', {}, locale), summaryLeft: t('terminal.delivery.summaryLeft', {}, locale),
    summaryFailed: t('terminal.delivery.summaryFailed', {}, locale), summaryAdoptFailed: t('terminal.delivery.summaryAdoptFailed', {}, locale), summaryNotAdopted: t('terminal.delivery.summaryNotAdopted', {}, locale), nextDefault: t('terminal.delivery.nextDefault', {}, locale),
    pickerTitle: t('terminal.delivery.pickerTitle', {}, locale), none: t('terminal.delivery.none', {}, locale),
    fallbackTitle: t('terminal.delivery.fallbackTitle', {}, locale),
    verifyTitle: t('terminal.delivery.verifyTitle', {}, locale), verifyRow: t('terminal.delivery.verifyRow', {}, locale), verifyWithout: t('terminal.delivery.verifyWithout', {}, locale),
    verifyLoading: t('terminal.delivery.verifyLoading', {}, locale), verifyNone: t('terminal.delivery.verifyNone', {}, locale), verifyHow: t('terminal.delivery.verifyHow', {}, locale),
    verifyCheck: t('terminal.delivery.verifyCheck', {}, locale), verifyHints: t('terminal.delivery.verifyHints', {}, locale), verifyNoneHints: t('terminal.delivery.verifyNoneHints', {}, locale),
    verifiedBy: t('terminal.delivery.verifiedBy', {}, locale), notVerified: t('terminal.delivery.notVerified', {}, locale),
    diffListHints: t('terminal.delivery.diffListHints', {}, locale), diffHints: t('terminal.delivery.diffHints', {}, locale), diffHeader: t('terminal.delivery.diffHeader', {}, locale),
    diffUnavailable: t('terminal.delivery.diffUnavailable', {}, locale), diffEmpty: t('terminal.delivery.diffEmpty', {}, locale),
    diffHidden: t('terminal.delivery.diffHidden', {}, locale), diffPosition: t('terminal.delivery.diffPosition', {}, locale),
    next: {
      PATCH_BASE_ADVANCED: t('terminal.delivery.next.PATCH_BASE_ADVANCED', {}, locale),
      PATCH_CONFLICT: t('terminal.delivery.next.PATCH_CONFLICT', {}, locale),
      POLICY_DENIED: t('terminal.delivery.next.POLICY_DENIED', {}, locale),
      DELIVERY_INTERACTIVE_REQUIRED: t('terminal.delivery.next.DELIVERY_INTERACTIVE_REQUIRED', {}, locale),
      DELIVERY_CONFIRMATION_DECLINED: t('terminal.delivery.next.DELIVERY_CONFIRMATION_DECLINED', {}, locale),
      ADOPTION_TARGET_DENIED: t('terminal.delivery.next.ADOPTION_TARGET_DENIED', {}, locale),
      ADOPTION_NOT_VERIFIED: t('terminal.delivery.next.ADOPTION_NOT_VERIFIED', {}, locale) } };
}
