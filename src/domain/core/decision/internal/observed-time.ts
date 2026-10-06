import { DecisionError } from './contract.js';

/** Pure Gregorian civil-day arithmetic; the caller supplies the observation clock. */
export function decisionObservationIsFuture(input: string, nowMs: number): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(input);
  if (!match) throw new DecisionError('DECISION_CASE_INVALID');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  // A calendar-impossible instant (2023-02-30, month 13, 24:00, second 60) is refused, never normalised into another day.
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > monthDays || Number(match[4]) > 23 || Number(match[5]) > 59
    || Number(match[6] ?? 0) > 59) throw new DecisionError('DECISION_CASE_INVALID');
  const adjustedYear = year - (month <= 2 ? 1 : 0), era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146_097 + dayOfEra - 719_468;
  const offsetHours = Number(match[10] ?? 0), offsetMinutes = Number(match[11] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) throw new DecisionError('DECISION_CASE_INVALID');
  const offset = (offsetHours * 60 + offsetMinutes) * (match[9] === '-' ? -1 : 1);
  const wholeMs = ((days * 24 + Number(match[4])) * 60 + Number(match[5]) - offset) * 60_000 + Number(match[6] ?? 0) * 1_000;
  const fraction = match[7] ?? '', firstMillis = Number(fraction.slice(0, 3).padEnd(3, '0'));
  const millis = wholeMs + firstMillis;
  // Preserve sub-millisecond evidence: truncating it could accept an observation after the supplied clock.
  return millis > nowMs || (millis === nowMs && /[1-9]/.test(fraction.slice(3)));
}
