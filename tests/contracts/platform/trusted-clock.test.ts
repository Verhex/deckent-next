import { afterEach, expect, it, vi } from 'vitest';
import { SystemTrustedClock } from '#platform/index.js';

afterEach(() => { vi.restoreAllMocks(); });

it('never hands out an earlier wall time in this process when the host clock steps backwards', () => {
  const clock = new SystemTrustedClock(), other = new SystemTrustedClock();
  const base = Date.now() + 10_000;
  const wall = vi.spyOn(Date, 'now');
  wall.mockReturnValue(base);
  expect(clock.sample().wallMs).toBe(base);
  wall.mockReturnValue(base - 2_197); // the measured WSL2 step
  expect(other.sample().wallMs).toBe(base);
  wall.mockReturnValue(base + 5);
  expect(clock.sample().wallMs).toBe(base + 5);
});
