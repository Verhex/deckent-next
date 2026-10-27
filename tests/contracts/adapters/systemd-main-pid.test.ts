import { expect, it } from 'vitest';
import { querySystemdMainPid, type SystemdQueryExec } from '#adapters/index.js';

// CI-108: the manager's own answer to "which process is this unit's main process" (`systemctl show -p MainPID --value`), bounded, no shell, a
// minimal environment (only what reaches the manager's bus), never a secret in argv or env. Anything but one positive process id is no answer.
const bounds = { timeoutMs: 1_500, outputBytes: 256 };
const recording = (answer: () => Promise<string>) => {
  const calls: { file: string; args: readonly string[]; options: Parameters<SystemdQueryExec>[2] }[] = [];
  const exec: SystemdQueryExec = async (file, args, options) => { calls.push({ file, args, options }); return answer(); };
  return { calls, exec };
};
const ENV = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', HOME: '/home/u',
  DECKENT_ANTHROPIC_KEY: 'synthetic-canary-never-passed', SSH_AUTH_SOCK: '/tmp/agent' };

it('asks the user manager for a user unit and the system manager for a system unit, bounded, with only the bus environment', async () => {
  const user = recording(async () => '1820462\n');
  await expect(querySystemdMainPid({ scope: 'user', unit: 'deckent-n1.service' }, bounds, ENV, user.exec)).resolves.toBe(1820462);
  expect(user.calls).toEqual([{ file: 'systemctl', args: ['--user', 'show', '-p', 'MainPID', '--value', '--', 'deckent-n1.service'],
    options: { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }, timeout: 1_500, maxBuffer: 256 } }]);
  const system = recording(async () => '977\n');
  await expect(querySystemdMainPid({ scope: 'system', unit: 'hosted-compute-agent.service' }, bounds, { PATH: '/usr/bin' }, system.exec)).resolves.toBe(977);
  expect(system.calls[0]!.args).toEqual(['show', '-p', 'MainPID', '--value', '--', 'hosted-compute-agent.service']);
  expect(system.calls[0]!.options.env).toEqual({ PATH: '/usr/bin' });
});
it('no main process (0), an empty, multi-line or non-numeric answer, a failed, absent or timed-out manager is no answer', async () => {
  for (const answer of [async () => '0\n', async () => '', async () => '12 13\n', async () => '12\n13\n', async () => '-4\n', async () => 'MainPID=12\n',
    async () => '99999999999999999999\n', async (): Promise<string> => { throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' }); },
    async (): Promise<string> => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }); }]) {
    await expect(querySystemdMainPid({ scope: 'user', unit: 'a.service' }, bounds, ENV, recording(answer).exec)).resolves.toBeNull();
  }
});
it('a unit name that is not one plain `.service` word is never passed to the manager', async () => {
  for (const unit of ['-H.service', 'a b.service', 'a.scope', '', 'a\n.service']) {
    const probe = recording(async () => '1\n');
    await expect(querySystemdMainPid({ scope: 'user', unit }, bounds, ENV, probe.exec)).resolves.toBeNull(); expect(probe.calls).toEqual([]);
  }
});
it('alpha.56.1: a cleared environment (a launcher\'s `env -i`) still reaches the user manager through this user\'s standard runtime directory; a given one is kept', async () => {
  const cleared = recording(async () => '77\n');
  await expect(querySystemdMainPid({ scope: 'user', unit: 'deckent-proje.service' }, bounds, { PATH: '/usr/bin', HOME: '/home/u' }, cleared.exec)).resolves.toBe(77);
  expect(cleared.calls[0]!.options.env).toEqual({ PATH: '/usr/bin', XDG_RUNTIME_DIR: `/run/user/${process.getuid!()}` });
  const system = recording(async () => '5\n');
  await querySystemdMainPid({ scope: 'system', unit: 'deckent.service' }, bounds, { PATH: '/usr/bin' }, system.exec);
  expect(system.calls[0]!.options.env).toEqual({ PATH: '/usr/bin' });
});
