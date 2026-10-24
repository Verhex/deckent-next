import type { DispatchLossDecision } from '#domain/core/attempt/index.js';
import { RECOVERY_ESCALATION_CODES, type RecoveryEscalationCode } from './case.js';

type DispatchHoldReason = Extract<DispatchLossDecision, { kind: 'hold-manual' }>['reason'];
/** S6R-3: why the Nervous broker held a Run — a lost-dispatch `hold-manual` reason (no proof released the slot), or the stop list's own hold-run
 * and hand-to-human. Stable codes, no prose; a person reads them only through the EN/TR catalog (S6R-6). */
export const NERVOUS_HOLD_CODES = Object.freeze(['not-lost', 'not-granted', 'fence-required', 'fence-mismatch', 'termination-required', 'termination-mismatch',
  'hold-run', 'hand-to-human'] as const satisfies readonly (DispatchHoldReason | 'hold-run' | 'hand-to-human')[]);
export type NervousHoldCode = typeof NERVOUS_HOLD_CODES[number];
// Every dispatch hold-manual reason is a Nervous hold code (a new reason fails the type check until it has catalog text).
type MissingDispatchReason = Exclude<DispatchHoldReason, NervousHoldCode>;
export const NERVOUS_HOLD_CODES_COMPLETE: [MissingDispatchReason] extends [never] ? true : never = true;

/** The first characters of a case id a hold note carries, so a person can find the case (`run inspect`, audit). */
export const HOLD_NOTE_CASE_CHARS = 12;
const CASE = /^[a-f0-9]{12}$/u, RULE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/**
 * S6R-6: the one structured reading of a system safety-hold note (written by the recovery decision and the Nervous broker, s5b hold source
 * `nervous`). `recovery`/`nervous`: a known code; `system`: a note of either family this release does not know (a newer writer) — shown as a
 * generic safety hold, never as raw text; `text`: anything else (an operator's own words, shown as they are).
 */
export type RunHoldNote = Readonly<{ kind: 'recovery'; code: RecoveryEscalationCode; caseRef: string }>
  | Readonly<{ kind: 'nervous'; code: NervousHoldCode; ruleId: string; caseRef: string }>
  | Readonly<{ kind: 'system'; family: 'recovery' | 'nervous'; caseRef: string | null }>
  | Readonly<{ kind: 'text'; text: string }>;

/** The hold note of a recovery escalation (`recovery:<code>:<case12>`). */
export const recoveryHoldNote = (code: RecoveryEscalationCode, caseId: string) => `recovery:${code}:${caseId.slice(0, HOLD_NOTE_CASE_CHARS)}`;
/** The hold note of a Nervous broker hold (`nervous:<code>:<rule>:<case12>`). */
export const nervousHoldNote = (code: NervousHoldCode, ruleId: string, caseId: string) => `nervous:${code}:${ruleId}:${caseId.slice(0, HOLD_NOTE_CASE_CHARS)}`;

/** Pure: the structured reading of a hold note (see `RunHoldNote`). Only a system-source hold is read as coded; an operator's text is text. */
export function readRunHoldNote(note: string, source: 'operator' | 'nervous' | 'auditor' = 'nervous'): RunHoldNote {
  const parts = note.split(':'), family = parts[0];
  if (source === 'operator' || (family !== 'recovery' && family !== 'nervous')) return Object.freeze({ kind: 'text' as const, text: note });
  const caseRef = parts.at(-1) ?? '', ref = CASE.test(caseRef) ? caseRef : null, code = parts[1] ?? '';
  if (family === 'recovery' && parts.length === 3 && ref && (RECOVERY_ESCALATION_CODES as readonly string[]).includes(code))
    return Object.freeze({ kind: 'recovery' as const, code: code as RecoveryEscalationCode, caseRef: ref });
  if (family === 'nervous' && parts.length === 4 && ref && RULE.test(parts[2]!) && (NERVOUS_HOLD_CODES as readonly string[]).includes(code))
    return Object.freeze({ kind: 'nervous' as const, code: code as NervousHoldCode, ruleId: parts[2]!, caseRef: ref });
  return Object.freeze({ kind: 'system' as const, family, caseRef: ref });
}
