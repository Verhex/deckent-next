import { expect, it } from 'vitest';
import { detectServiceManager } from '#platform/index.js';

// inbox 2026-10-21: a terminal restart must not start a second service beside one a service manager (systemd unit) runs. The signal is the
// process's own manager marker (INVOCATION_ID in its environment) plus its control group; both are read from injected proc files here.
const files = (map: Record<string, string>) => (path: string) => map[path] ?? null;
const USER_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/deckent-runtime.service\n';
const SYSTEM_CGROUP = '0::/system.slice/deckent-runtime.service\n';

it('names a systemd user unit with its restart command', () => {
  const found = detectServiceManager(4242, files({ '/proc/4242/environ': 'PATH=/bin\0INVOCATION_ID=abc123\0', '/proc/4242/cgroup': USER_CGROUP }));
  expect(found).toEqual({ manager: 'systemd', scope: 'user', unit: 'deckent-runtime.service' });
});
it('names a systemd system unit', () => {
  expect(detectServiceManager(7, files({ '/proc/7/environ': 'INVOCATION_ID=x\0', '/proc/7/cgroup': SYSTEM_CGROUP })))
    .toEqual({ manager: 'systemd', scope: 'system', unit: 'deckent-runtime.service' });
});
it('a hand-started service (no marker) or an unreadable process is not managed', () => {
  expect(detectServiceManager(9, files({ '/proc/9/environ': 'PATH=/bin\0', '/proc/9/cgroup': USER_CGROUP }))).toBeNull();
  expect(detectServiceManager(9, files({}))).toBeNull();
  expect(detectServiceManager(undefined, files({}))).toBeNull();
});
it('a marker without a service unit in the control group (a scope or session) is not claimed as managed', () => {
  expect(detectServiceManager(9, files({ '/proc/9/environ': 'INVOCATION_ID=x\0', '/proc/9/cgroup': '0::/user.slice/user-1000.slice/session-3.scope\n' }))).toBeNull();
});
