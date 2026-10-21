import { expect, it } from 'vitest';
import { detectServiceManager } from '#platform/index.js';

// inbox 2026-10-21: a terminal restart must not start a second service beside one a service manager (systemd unit) runs. The signal is the
// process's control group alone (never its environment: that can hold credentials); the proc file is injected here.
const cgroup = (text: string | null) => (path: string) => (path === '/proc/4242/cgroup' ? text : null);
const USER_UNIT = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/deckent-runtime.service\n';
const SYSTEM_UNIT = '0::/system.slice/deckent-runtime.service\n';

it('names a systemd user unit with its restart command inputs', () => {
  expect(detectServiceManager(4242, cgroup(USER_UNIT))).toEqual({ manager: 'systemd', scope: 'user', unit: 'deckent-runtime.service' });
});
it('names a systemd system unit', () => {
  expect(detectServiceManager(4242, cgroup(SYSTEM_UNIT))).toEqual({ manager: 'systemd', scope: 'system', unit: 'deckent-runtime.service' });
});
it('never reads the process environment', () => {
  const read: string[] = []; detectServiceManager(4242, path => { read.push(path); return USER_UNIT; });
  expect(read).toEqual(['/proc/4242/cgroup']);
});
it('a terminal-started service (app-*.scope, session scope, the user manager itself) is not managed, so terminal restart still works', () => {
  for (const text of ['0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal-123.scope\n',
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope\n',
    '0::/user.slice/user-1000.slice/session-3.scope\n', '0::/user.slice/user-1000.slice/user@1000.service/init.scope\n',
    '0::/user.slice/user-1000.slice/user@1000.service\n', '0::/\n']) expect(detectServiceManager(4242, cgroup(text))).toBeNull();
});
it('an unreadable or unknown process is not managed', () => {
  expect(detectServiceManager(4242, cgroup(null))).toBeNull(); expect(detectServiceManager(undefined, cgroup(USER_UNIT))).toBeNull();
});
