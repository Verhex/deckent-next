import { expect, it } from 'vitest';
import { detectServiceManager, type ServiceMainPidQuery } from '#platform/index.js';

// inbox 2026-10-21: a terminal restart must not start a second service beside one a service manager (systemd unit) runs. The candidate unit comes
// from the process's control group alone (never its environment: that can hold credentials); the proc file is injected here. CI-108: a `.service`
// control group only names a candidate — the GitHub runner runs every job process inside `hosted-compute-agent.service` — so the process counts as
// manager-run only when it IS that unit's main process, as the manager itself reports it (the MainPID query is injected here).
const cgroup = (text: string | null) => (path: string) => (path === '/proc/4242/cgroup' ? text : null);
const USER_UNIT = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/deckent-runtime.service\n';
const SYSTEM_UNIT = '0::/system.slice/deckent-runtime.service\n';
const RUNNER_AGENT = '0::/system.slice/hosted-compute-agent.service\n';
const mainPid = (pid: number | null): ServiceMainPidQuery & { asked: unknown[] } => {
  const asked: unknown[] = []; return Object.assign(async (unit: unknown) => { asked.push(unit); return pid; }, { asked });
};

it('names a systemd user unit whose main process the service is, with its restart command inputs', async () => {
  const query = mainPid(4242);
  await expect(detectServiceManager(4242, query, cgroup(USER_UNIT))).resolves.toEqual({ manager: 'systemd', scope: 'user', unit: 'deckent-runtime.service' });
  expect(query.asked).toEqual([{ manager: 'systemd', scope: 'user', unit: 'deckent-runtime.service' }]);
});
it('names a systemd system unit whose main process the service is', async () => {
  await expect(detectServiceManager(4242, mainPid(4242), cgroup(SYSTEM_UNIT))).resolves.toEqual({ manager: 'systemd', scope: 'system', unit: 'deckent-runtime.service' });
});
it('CI-108: a service started inside another unit (the CI runner agent, a test run in a transient unit) is not that unit\'s main process, so it stays restartable', async () => {
  for (const text of [RUNNER_AGENT, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-u212.service\n', USER_UNIT]) {
    const query = mainPid(1171); await expect(detectServiceManager(4242, query, cgroup(text))).resolves.toBeNull(); expect(query.asked).toHaveLength(1);
  }
});
it('an unprovable main process (manager unreachable, timed out, no main process) is not managed: the refusal needs the manager\'s own answer', async () => {
  await expect(detectServiceManager(4242, mainPid(null), cgroup(USER_UNIT))).resolves.toBeNull();
  await expect(detectServiceManager(4242, async () => { throw new Error('bus unavailable'); }, cgroup(USER_UNIT))).resolves.toBeNull();
});
it('never reads the process environment', async () => {
  const read: string[] = []; await detectServiceManager(4242, mainPid(4242), path => { read.push(path); return USER_UNIT; });
  expect(read).toEqual(['/proc/4242/cgroup']);
});
it('a terminal-started service (app-*.scope, session scope, the user manager itself) is not managed and the manager is never asked', async () => {
  for (const text of ['0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal-123.scope\n',
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope\n',
    '0::/user.slice/user-1000.slice/session-3.scope\n', '0::/user.slice/user-1000.slice/user@1000.service/init.scope\n',
    '0::/user.slice/user-1000.slice/user@1000.service\n', '0::/\n', '0::/non-systemd\n']) {
    const query = mainPid(4242); await expect(detectServiceManager(4242, query, cgroup(text))).resolves.toBeNull(); expect(query.asked).toEqual([]);
  }
});
it('an unreadable or unknown process is not managed', async () => {
  await expect(detectServiceManager(4242, mainPid(4242), cgroup(null))).resolves.toBeNull();
  await expect(detectServiceManager(undefined, mainPid(4242), cgroup(USER_UNIT))).resolves.toBeNull();
});
