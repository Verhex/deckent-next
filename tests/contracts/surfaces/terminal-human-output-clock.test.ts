import { afterEach, describe, expect, it } from 'vitest';
import { clockText } from '#surfaces/core/monitor/index.js';

// TUI2 L3: the monitor shows the person's own clock with the zone offset (Z at UTC), not UTC with a Z suffix.
const original = process.env['TZ'];
afterEach(() => { if (original === undefined) delete process.env['TZ']; else process.env['TZ'] = original; });
const moment = Date.UTC(2026, 9, 7, 21, 30, 5);
describe('monitor clock', () => {
  it.each([['UTC', '2026-10-07 21:30:05Z'], ['Europe/Istanbul', '2026-10-08 00:30:05+03'], ['America/New_York', '2026-10-07 17:30:05-04'],
    ['Asia/Kolkata', '2026-10-08 03:00:05+0530'], ['America/St_Johns', '2026-10-07 19:00:05-0230']])('%s', (zone, expected) => {
    process.env['TZ'] = zone;
    expect(clockText(moment)).toBe(expected);
  });
});
