import { t, type Locale } from '#platform/index.js';
import { humanRecordText } from '#surfaces/core/terminal-render/index.js';
import type { DecisionArmLabels } from '#surfaces/core/terminal-window/index.js';
export interface ProjectInstructionLabels {
  readonly trustTitle: string; readonly trustBody: string; readonly skip: string; readonly trust: string;
  readonly source: string; readonly blocked: string; readonly hints: string; readonly position: string;
  readonly initTitle: string; readonly external: string;
  readonly confirm: string; readonly cancel: string; readonly done: string;
  readonly lineTrustRequired: string;
  /** Hint-row words of the standalone init window; inside the Workline its own provider speaks. */
  readonly decisionArm: DecisionArmLabels;
}
export function projectInstructionLabels(locale: Locale): ProjectInstructionLabels {
  return {
    trustTitle: t('instructions.trustTitle', {}, locale),
    trustBody: t('instructions.trustBody', {}, locale),
    skip: t('instructions.skip', {}, locale),
    trust: t('instructions.trust', {}, locale),
    source: t('instructions.source', {}, locale),
    blocked: t('instructions.blocked', {}, locale),
    hints: t('instructions.hints', {}, locale),
    position: t('instructions.position', {}, locale),
    initTitle: t('instructions.initTitle', {}, locale),
    external: t('setup.instructions.external', {}, locale),
    confirm: t('instructions.confirm', {}, locale),
    cancel: t('instructions.cancel', {}, locale),
    done: t('instructions.done', {}, locale),
    lineTrustRequired: t('instructions.lineTrustRequired', {}, locale),
    decisionArm: { arming: t('terminal.decision.arming', {}, locale), ignored: t('terminal.decision.ignored', {}, locale), typedText: t('terminal.decision.typedText', {}, locale), unchosen: t('terminal.decision.unchosen', {}, locale) },
  };
}
/** Package strings are sanitized facts; command lines contain only detected, validated npm script names. */
export function projectSkeleton(locale: Locale) {
  return (name: string, commands: readonly string[]) => t('instructions.skeleton', { name: humanRecordText(name).replace(/[\r\n]/g, ' '), commands: commands.map(command => `- \`${command}\``).join('\n') || t('instructions.noCommands', {}, locale) }, locale);
}
