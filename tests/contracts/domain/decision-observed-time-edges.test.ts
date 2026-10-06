import { expect, it } from 'vitest';
import { decisionObservationIsFuture as isFuture, DecisionError } from '#domain/index.js';

const T = Date.UTC(2024, 5, 15, 12, 0, 0);
const invalid = (input: string) => {
  try { isFuture(input, T); } catch (error) {
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).code).toBe('DECISION_CASE_INVALID');
    return;
  }
  throw new Error(`expected throw for ${input}`);
};

it('applies Z, +HH:MM and -HHMM offsets to the instant', () => {
  expect(isFuture('2024-06-15T12:00Z', T)).toBe(false);
  expect(isFuture('2024-06-15T14:00+02:00', T)).toBe(false);
  expect(isFuture('2024-06-15T14:00:01+02:00', T)).toBe(true);
  expect(isFuture('2024-06-15T07:00-0500', T)).toBe(false);
  expect(isFuture('2024-06-15T07:00:01-0500', T)).toBe(true);
});

it('treats seconds as optional', () => {
  expect(isFuture('2024-06-15T12:00Z', T)).toBe(false);
  expect(isFuture('2024-06-15T12:01Z', T)).toBe(true);
  expect(isFuture('2024-06-15T12:00:00Z', T)).toBe(false);
});

it('is not future at exactly nowMs and future one millisecond later', () => {
  expect(isFuture('2024-06-15T12:00:00.000Z', T)).toBe(false);
  expect(isFuture('2024-06-15T12:00:00.001Z', T)).toBe(true);
  expect(isFuture('2024-06-15T11:59:59.999Z', T)).toBe(false);
});

it('treats non-zero sub-millisecond digits at exactly nowMs as future', () => {
  expect(isFuture('2024-06-15T12:00:00.0000001Z', T)).toBe(true);
  expect(isFuture('2024-06-15T12:00:00.000500Z', T)).toBe(true);
  expect(isFuture('2024-06-15T12:00:00.000000Z', T)).toBe(false);
  expect(isFuture('2024-06-15T11:59:59.999999Z', T)).toBe(false);
});

it('pads short fractions as milliseconds', () => {
  expect(isFuture('2024-06-15T12:00:00.5Z', T)).toBe(true);
  expect(isFuture('2024-06-15T11:59:59.5Z', T - 500)).toBe(false);
  expect(isFuture('2024-06-15T11:59:59.5Z', T - 501)).toBe(true);
});

it('computes leap days correctly', () => {
  const feb29 = Date.UTC(2024, 1, 29, 0, 0, 0);
  expect(isFuture('2024-02-29T00:00Z', feb29)).toBe(false);
  expect(isFuture('2024-02-29T00:00:01Z', feb29)).toBe(true);
  expect(isFuture('2024-03-01T00:00Z', feb29 + 86_400_000)).toBe(false);
  expect(isFuture('2024-03-01T00:00:01Z', feb29 + 86_400_000)).toBe(true);
});

it('handles century and 400-year rules', () => {
  const y2000 = Date.UTC(2000, 1, 29, 12);
  expect(isFuture('2000-02-29T12:00Z', y2000)).toBe(false);
  expect(isFuture('2000-03-01T00:00Z', y2000)).toBe(true);
  const mar1900 = Date.UTC(1900, 2, 1, 0);
  expect(isFuture('1900-03-01T00:00Z', mar1900)).toBe(false);
  expect(isFuture('1900-03-01T00:00:01Z', mar1900)).toBe(true);
  expect(isFuture('2100-03-01T00:00Z', Date.UTC(2100, 2, 1))).toBe(false);
  expect(isFuture('1600-12-31T23:59Z', Date.UTC(1600, 11, 31, 23, 59))).toBe(false);
});

it('rejects offsets beyond 23:59', () => {
  invalid('2024-06-15T12:00+24:00');
  invalid('2024-06-15T12:00-2400');
  invalid('2024-06-15T12:00+00:60');
  expect(isFuture('2024-06-15T12:00+23:59', T)).toBe(false);
});

it('rejects calendar-impossible dates and times instead of rolling them into another day', () => {
  for (const bad of ['2023-02-30T00:00Z', '2023-02-29T00:00Z', '1900-02-29T00:00Z', '2024-04-31T00:00Z', '2024-13-01T00:00Z',
    '2024-00-10T00:00Z', '2024-06-00T00:00Z', '2024-06-15T24:00Z', '2024-06-15T12:60Z', '2024-06-15T12:00:60Z'])
    invalid(bad);
  expect(isFuture('2024-02-29T00:00Z', T)).toBe(false);
  expect(isFuture('2000-02-29T00:00Z', T)).toBe(false);
});

it('throws DECISION_CASE_INVALID for malformed inputs', () => {
  for (const bad of ['', 'not a date', '2024-06-15', '2024-06-15T12:00', '2024-06-15 12:00Z', '2024-6-15T12:00Z', '2024-06-15T12:00:00.Z', '2024-06-15T12:00+2Z', ' 2024-06-15T12:00Z'])
    invalid(bad);
});
