import { readRunHoldNote, type NervousHoldCode, type RecoveryEscalationCode } from '#domain/index.js';
import type { RecoveryConfigMode, RecoveryContinuation, RecoveryGrantState, RecoveryModeState } from '#engine/index.js';
import { t, type Locale } from '#platform/index.js';

type HoldSource = 'operator' | 'nervous' | 'auditor';
type HeldState = Readonly<{ kind: string; reason?: string; note?: string | undefined; holdSource?: HoldSource | undefined;
  operatorHold?: Readonly<{ note: string; source?: HoldSource | undefined }> | undefined }>;

/** Every recovery escalation code in words (one literal key each: the lint-arch i18n rule; the record keeps the map complete by type). */
const recoveryReason = (code: RecoveryEscalationCode, l: Locale): string => ({
  'effects-open': () => t('recovery.hold.recovery.effects-open', {}, l), 'settled-not-idempotent': () => t('recovery.hold.recovery.settled-not-idempotent', {}, l),
  'settled-over-bound': () => t('recovery.hold.recovery.settled-over-bound', {}, l), 'continuation-bound': () => t('recovery.hold.recovery.continuation-bound', {}, l),
  'attempt-ceiling': () => t('recovery.hold.recovery.attempt-ceiling', {}, l), 'run-bound': () => t('recovery.hold.recovery.run-bound', {}, l),
  'same-evidence': () => t('recovery.hold.recovery.same-evidence', {}, l), 'run-closed': () => t('recovery.hold.recovery.run-closed', {}, l),
  'human-chosen': () => t('recovery.hold.recovery.human-chosen', {}, l), 'continuation-not-approved': () => t('recovery.hold.recovery.continuation-not-approved', {}, l),
  'no-eligible-model': () => t('recovery.hold.recovery.no-eligible-model', {}, l), 'consent-required': () => t('recovery.hold.recovery.consent-required', {}, l),
  'model-failed': () => t('recovery.hold.recovery.model-failed', {}, l), 'answer-invalid': () => t('recovery.hold.recovery.answer-invalid', {}, l),
  'breaker-open': () => t('recovery.hold.recovery.breaker-open', {}, l), 'work-class-not-low-risk': () => t('recovery.hold.recovery.work-class-not-low-risk', {}, l),
} satisfies Record<RecoveryEscalationCode, () => string>)[code]();
const nervousReason = (code: NervousHoldCode, l: Locale): string => ({
  'not-lost': () => t('recovery.hold.nervous.not-lost', {}, l), 'not-granted': () => t('recovery.hold.nervous.not-granted', {}, l),
  'fence-required': () => t('recovery.hold.nervous.fence-required', {}, l), 'fence-mismatch': () => t('recovery.hold.nervous.fence-mismatch', {}, l),
  'termination-required': () => t('recovery.hold.nervous.termination-required', {}, l), 'termination-mismatch': () => t('recovery.hold.nervous.termination-mismatch', {}, l),
  'hold-run': () => t('recovery.hold.nervous.hold-run', {}, l), 'hand-to-human': () => t('recovery.hold.nervous.hand-to-human', {}, l),
} satisfies Record<NervousHoldCode, () => string>)[code]();

/**
 * S6R-6: the one renderer of a Run hold note for a person (run inspect, `/runs`, monitor, the resume cards). A system note (recovery decision,
 * Nervous broker) is always its EN/TR catalog text with the short case reference — never the raw code; a note of a family this release does not
 * know is a generic safety-hold sentence. An operator's own words are shown as they are.
 */
export function holdNoteText(note: string, source: HoldSource, locale: Locale): string {
  const read = readRunHoldNote(note, source);
  if (read.kind === 'text') return read.text;
  const reason = read.kind === 'recovery' ? recoveryReason(read.code, locale) : read.kind === 'nervous' ? nervousReason(read.code, locale) : t('recovery.hold.system', {}, locale);
  return read.caseRef ? t('recovery.hold.withCase', { reason, case: read.caseRef }, locale) : reason;
}
/** The hold of a parked Run (the domain `readRunHold` rule over a projected state): its own park, else the overlay on another park. */
function heldNote(state: HeldState | undefined): Readonly<{ note: string; source: HoldSource }> | null {
  if (state?.kind !== 'parked') return null;
  if (state.reason === 'operator-hold') return state.note ? { note: state.note, source: state.holdSource ?? 'operator' } : null;
  return state.operatorHold ? { note: state.operatorHold.note, source: state.operatorHold.source ?? 'operator' } : null;
}
/** The hold of a parked Run — its own `operator-hold` park or the overlay on another park — in words, or null when the Run is not held. */
export function runHoldReasonText(state: HeldState | undefined, locale: Locale): string | null {
  const hold = heldNote(state);
  return hold ? holdNoteText(hold.note, hold.source, locale) : null;
}
/** The next step a person takes on a system hold (null for an operator's own hold or no hold). */
export function runHoldNextText(state: HeldState | undefined, locale: Locale): string | null {
  const hold = heldNote(state);
  return hold && readRunHoldNote(hold.note, hold.source).kind !== 'text' ? t('recovery.hold.next', {}, locale) : null;
}

const modeWord = (mode: RecoveryConfigMode, l: Locale) => mode === 'live' ? t('recovery.mode.live', {}, l) : mode === 'shadow' ? t('recovery.mode.shadow', {}, l) : t('recovery.mode.off', {}, l);
const grantWord = (grant: RecoveryGrantState, l: Locale): string => ({ present: () => t('recovery.grant.present', {}, l), partial: () => t('recovery.grant.partial', {}, l),
  missing: () => t('recovery.grant.missing', {}, l), unknown: () => t('recovery.grant.unknown', {}, l) } satisfies Record<RecoveryGrantState, () => string>)[grant]();
const effectText = (continuation: RecoveryContinuation, l: Locale): string => ({ none: () => t('recovery.state.none', {}, l), recorded: () => t('recovery.state.recorded', {}, l),
  automatic: () => t('recovery.state.automatic', {}, l), person: () => t('recovery.state.person', {}, l), partial: () => t('recovery.state.partial', {}, l),
  unknown: () => t('recovery.state.unknown', {}, l) } satisfies Record<RecoveryContinuation, () => string>)[continuation]();
/** S6R-6: the lost-worker recovery state (doctor, monitor): both protected modes and the standing grant, then what that means for a lost worker. */
export function recoveryStateLines(state: RecoveryModeState, locale: Locale): readonly [string, string] {
  return [t('recovery.state.line', { nervous: modeWord(state.nervous, locale), recovery: modeWord(state.recovery, locale), grant: grantWord(state.grant, locale) }, locale),
    effectText(state.continuation, locale)];
}
