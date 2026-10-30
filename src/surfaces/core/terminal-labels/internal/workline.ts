import { t, type Locale } from '#platform/index.js';
import type { WorklineLabels, SlashWindowLabels } from '#surfaces/core/terminal/index.js';
import { pickerLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { terminalComposerLabels, terminalHandoffLabels, terminalRenderLabels, terminalSessionLabels } from './labels.js';

function modeStopWords(locale: Locale) {
  return { standart: t('terminal.mode.stop.standart', {}, locale), 'ask-edits': t('terminal.mode.stop.ask-edits', {}, locale),
    'full-auto': t('terminal.mode.stop.full-auto', {}, locale), 'full-access': t('terminal.mode.stop.full-access', {}, locale) } as const;
}

/** SLASH-WINDOWS (owner 2026-10-08): the words of the `/reasoning`, `/scratch` and unknown-command windows; absent where the terminal cannot draw a list. */
export function slashWindowLabels(locale: Locale): SlashWindowLabels {
  return { picker: pickerLabels(locale), position: t('terminal.window.position', {}, locale), hints: t('terminal.window.hints', {}, locale), infoHints: t('terminal.window.infoHints', {}, locale), typedArgument: t('terminal.window.typedArgument', {}, locale),
    reasoning: { title: t('terminal.window.reasoning.title', {}, locale), thinkingOn: t('terminal.window.reasoning.thinkingOn', {}, locale), thinkingOnDetail: t('terminal.window.reasoning.thinkingOnDetail', {}, locale), thinkingOff: t('terminal.window.reasoning.thinkingOff', {}, locale),
      thinkingOffDetail: t('terminal.window.reasoning.thinkingOffDetail', {}, locale), previewOn: t('terminal.window.reasoning.previewOn', {}, locale), previewOnDetail: t('terminal.window.reasoning.previewOnDetail', {}, locale), previewOff: t('terminal.window.reasoning.previewOff', {}, locale),
      previewOffDetail: t('terminal.window.reasoning.previewOffDetail', {}, locale), current: t('terminal.window.reasoning.current', {}, locale), statusOn: t('terminal.window.reasoning.statusOn', {}, locale), statusOnHidden: t('terminal.window.reasoning.statusOnHidden', {}, locale),
      statusOff: t('terminal.window.reasoning.statusOff', {}, locale) },
    scratch: { title: t('terminal.window.scratch.title', {}, locale), status: t('terminal.window.scratch.status', {}, locale), folder: t('terminal.window.scratch.folder', {}, locale), more: t('terminal.window.scratch.more', {}, locale), empty: t('terminal.window.scratch.empty', {}, locale), fileDetail: t('terminal.window.scratch.fileDetail', {}, locale),
      clear: t('terminal.window.scratch.clear', {}, locale), clearDetail: t('terminal.window.scratch.clearDetail', {}, locale), clearTitle: t('terminal.window.scratch.clearTitle', {}, locale), clearBody: t('terminal.window.scratch.clearBody', {}, locale), clearPrompt: t('terminal.window.scratch.clearPrompt', {}, locale),
      pathTitle: t('terminal.window.scratch.pathTitle', {}, locale) },
    unknown: { title: t('terminal.window.unknown.title', {}, locale), body: t('terminal.window.unknown.body', {}, locale), closest: t('terminal.window.unknown.closest', {}, locale), none: t('terminal.window.unknown.none', {}, locale),
      all: t('terminal.window.unknown.all', {}, locale), allDetail: t('terminal.window.unknown.allDetail', {}, locale) } };
}


export function worklineLabels(locale: Locale, statusLine: string): WorklineLabels {
  return {
    work: workSurfaceLabels(locale),
    banner: t('terminal.workline.banner', {}, locale), prompt: '', // workline input has no visible prompt prefix (placeholder instead); line mode keeps terminal.session.prompt
    statusReady: t('terminal.workline.statusReady', {}, locale), statusBusy: t('terminal.workline.statusBusy', {}, locale),
    statusCancelling: t('terminal.workline.statusCancelling', {}, locale), hint: t('terminal.workline.hint', {}, locale),
    focus: { composer: t('tui.focus.composer', {}, locale), window: t('tui.focus.window', {}, locale), decide: t('tui.focus.decide', {}, locale) },
    selfSourceFloor: t('terminal.mode.selfSourceFloor', {}, locale),
    roleUser: t('terminal.workline.roleUser', {}, locale), roleAssistant: t('terminal.workline.roleAssistant', {}, locale),
    runCard: t('terminal.ledger.runCard', {}, locale), workerCard: t('terminal.ledger.workerCard', {}, locale),
    watchFailed: t('terminal.workline.watchFailed', {}, locale), commandUnavailable: t('terminal.admin.partUnavailable', {}, locale), // `{part}` stays a template
    watchDelivery: t('terminal.workline.watchDelivery', {}, locale), watchStep: t('terminal.workline.watchStep', {}, locale),
    watchNotInitialized: t('terminal.workline.watchNotInitialized', {}, locale),
    watchAccessDenied: t('terminal.workline.watchAccessDenied', {}, locale), watchAccessStopped: t('terminal.workline.watchAccessStopped', {}, locale),
    watchPushFailed: t('terminal.workline.watchPushFailed', {}, locale), ledgerUnavailable: t('terminal.workline.ledgerUnavailable', {}, locale),
    runNotFound: t('terminal.workline.runNotFound', {}, locale), workersEmpty: t('terminal.workline.workersEmpty', {}, locale),
    runsEmpty: t('terminal.workline.runsEmpty', {}, locale), serviceRestartUnavailable: t('terminal.service.restartUnavailable', {}, locale),
    queued: t('terminal.workline.queued', {}, locale),
    runUsage: t('terminal.slash.runUsage', {}, locale),
    unknownCommand: t('terminal.workline.unknownCommand', {}, locale), statusLine,
    render: terminalRenderLabels(locale), composer: terminalComposerLabels(locale), sessions: terminalSessionLabels(locale), handoff: terminalHandoffLabels(locale),
    mentions: { attached: t('terminal.mention.attached', {}, locale), truncated: t('terminal.mention.truncated', {}, locale),
      refused: t('terminal.mention.refused', {}, locale) },
    mode: { current: t('terminal.mode.current', {}, locale), changed: t('terminal.mode.changed', {}, locale), inert: t('terminal.mode.inert', {}, locale),
      unsupported: t('terminal.mode.unsupported', {}, locale), usage: t('terminal.mode.usage', {}, locale),
      effect: { standart: t('terminal.mode.effect.standart', {}, locale), 'full-auto': t('terminal.mode.effect.full-auto', {}, locale),
        'full-access': t('terminal.mode.effect.full-access', {}, locale) },
      switch: t('terminal.mode.switch', {}, locale), fullAccessGrant: t('terminal.mode.fullAccessGrant', {}, locale), startSaved: t('terminal.mode.startSaved', {}, locale),
      stops: modeStopWords(locale), cycled: t('terminal.mode.cycled', {}, locale), cycledFullAccess: t('terminal.mode.cycledFullAccess', {}, locale),
      askEditsOn: t('terminal.mode.askEditsOn', {}, locale), askEditsOff: t('terminal.mode.askEditsOff', {}, locale), fullAccessLine: t('tui.panel.mode.fullAccessLine', {}, locale),
      fullAutoRevoked: t('terminal.mode.fullAutoRevoked', {}, locale) },
    viewport: { below: t('terminal.viewport.below', {}, locale), newMessages: t('terminal.viewport.newMessages', {}, locale), search: t('terminal.viewport.search', {}, locale),
      searchNone: t('terminal.viewport.searchNone', {}, locale), copied: t('terminal.viewport.copied', {}, locale) },
    decisionArm: { arming: t('terminal.decision.arming', {}, locale), ignored: t('terminal.decision.ignored', {}, locale) },
    reasoning: { on: t('terminal.reasoning.on', {}, locale), off: t('terminal.reasoning.off', {}, locale), usage: t('terminal.reasoning.usage', {}, locale), unsupported: t('tui.model.reason.reasoningOff', {}, locale) },
    copy: { sent: t('tuicopy.sent', {}, locale), none: t('tuicopy.none', {}, locale), range: t('tuicopy.range', {}, locale), usage: t('tuicopy.usage', {}, locale),
      tooLarge: t('tuicopy.tooLarge', {}, locale), unavailable: t('tuicopy.unavailable', {}, locale) },
    scratch: { summary: t('terminal.scratch.summary', {}, locale), empty: t('terminal.scratch.empty', {}, locale), entry: t('terminal.scratch.entry', {}, locale),
      more: t('terminal.scratch.more', {}, locale), path: t('terminal.scratch.path', {}, locale), cleared: t('terminal.scratch.cleared', {}, locale),
      usage: t('terminal.scratch.usage', {}, locale) },
  };
}
