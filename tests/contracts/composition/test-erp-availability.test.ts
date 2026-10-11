import { expect, it, vi } from 'vitest';
import { checkFixtureAvailability, fixtureAvailability, loopbackAvailability } from '../../fixtures/test-erp/availability.js';
import { testErpFixture } from '../../fixtures/test-erp/fixture.js';

it.each(['win32', 'darwin'] as const)('refuses %s before loopback, filesystem setup or terminal access', async platform => {
  const probe = vi.fn(async () => { throw new Error('must not access loopback'); });
  const result = { status: 'verify-not-run', reason: 'platform-unsupported', platform };
  expect(fixtureAvailability(platform)).toEqual(result);
  expect(await checkFixtureAvailability(platform, probe)).toEqual(result); expect(probe).not.toHaveBeenCalled();
  // The real setup function enforces the same gate before mkdtemp, rather than relying on describe.skipIf.
  await expect(testErpFixture({ platform })).rejects.toMatchObject({ availability: result });
});
it.each(['EPERM', 'EACCES'])('records %s from the loopback capability without claiming a Core failure', async code => {
  const probe = vi.fn(async () => { throw Object.assign(new Error('listen refused'), { code }); });
  expect(await checkFixtureAvailability('linux', probe)).toEqual({ status: 'verify-not-run', reason: 'loopback-denied', platform: 'linux' });
  expect(probe).toHaveBeenCalledTimes(1);
});
it('keeps Linux execution available after a successful capability probe', async () => {
  const probe = vi.fn(async () => {});
  expect(await checkFixtureAvailability('linux', probe)).toEqual({ status: 'available', platform: 'linux' });
  expect(probe).toHaveBeenCalledTimes(1);
});
it.each(['EADDRINUSE', 'ECONNRESET'])('propagates %s rather than turning an unrelated failure into a skip', async code => {
  const error = Object.assign(new Error('real failure'), { code });
  expect(() => loopbackAvailability(error, 'linux')).toThrow(error);
  await expect(checkFixtureAvailability('linux', async () => { throw error; })).rejects.toBe(error);
});
