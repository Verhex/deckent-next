import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemdManager, retainManager, restartManaged, stopManaged } from './dev-release-service.mjs';

function fixture(t) {
  const installRoot = mkdtempSync(join(tmpdir(), 'dev-release-unit-'));
  t.after(() => rmSync(installRoot, { recursive: true, force: true }));
  const L = { installRoot, project: process.cwd(), launcher: join(process.cwd(), '.agents/refactor/next-entry.mjs'), globalHome: join(installRoot, 'global') };
  const group = '/user.slice/user-1000.slice/user@1000.service/app.slice/deckent-n1.service';
  const properties = { LoadState: 'loaded', WorkingDirectory: L.project, ControlGroup: group, MainPID: process.pid, UMask: '0022', Restart: 'on-failure',
    ExecStart: `{ path=${process.execPath} ; argv[]=${process.execPath} ${L.launcher} cli runtime serve --json ; }`, Environment: `DECKENT_NEXT_INSTALL_ROOT=${installRoot}` };
  const calls = [];
  const opts = { startTimeoutMs: 1234, readCgroup: () => `0::${group}\n`, systemctl: (args, timeout) => {
    calls.push({ args, timeout });
    return { status: 0, stdout: args[1] === 'show' ? Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') : '' };
  } };
  const fail = (code, detail) => { throw Object.assign(new Error(code), { code, detail }); };
  return { L, opts, properties, calls, group, fail };
}
const unitTest = (name, fn) => test(name, { skip: process.platform !== 'linux' ? 'DEV_RELEASE_PLATFORM_UNSUPPORTED' : false }, fn);

unitTest('running unit binds process, cgroup, project, launcher, install root, mask and restart policy', t => {
  const f = fixture(t);
  const manager = systemdManager(f.L, process.pid, f.opts, f.fail);
  assert.deepEqual(manager, { unit: 'deckent-n1.service' });
  retainManager(f.L, manager);
  assert.deepEqual(JSON.parse(readFileSync(join(f.L.installRoot, 'service-unit.json'), 'utf8')), { ...manager, project: f.L.project, launcher: f.L.launcher, installRoot: f.L.installRoot });
  assert.deepEqual(f.calls[0].args, ['--user', 'show', 'deckent-n1.service', '--property=LoadState,WorkingDirectory,ControlGroup,MainPID,UMask,Restart,ExecStart,Environment']);
});
unitTest('raw process without a retained manager never contacts systemctl', t => {
  const f = fixture(t); f.opts.readCgroup = () => '0::/unmanaged\n';
  assert.equal(systemdManager(f.L, process.pid, f.opts, f.fail), null);
  assert.equal(systemdManager(f.L, undefined, f.opts, f.fail), null); assert.equal(f.calls.length, 0);
});
unitTest('invalid unit properties refuse before any control effect', t => {
  const f = fixture(t);
  for (const [key, value] of [['UMask', '0077'], ['Restart', 'always'], ['WorkingDirectory', f.L.installRoot], ['LoadState', 'not-found'],
    ['ControlGroup', '/foreign/deckent-n1.service'], ['ExecStart', `${f.L.launcher}.foreign cli runtime serve`], ['Environment', 'DECKENT_NEXT_INSTALL_ROOT=/foreign']]) {
    const before = f.properties[key]; f.properties[key] = value;
    assert.throws(() => systemdManager(f.L, process.pid, f.opts, f.fail), { code: 'DEV_RELEASE_SYSTEMD_CUSTODY_INVALID' });
    f.properties[key] = before;
  }
  assert.equal(f.calls.every(call => call.args[1] === 'show'), true);
});
unitTest('MainPID outside the runtime control group is refused', t => {
  const f = fixture(t); f.properties.MainPID = 123456;
  f.opts.readCgroup = pid => `0::${pid === process.pid ? f.group : '/foreign'}\n`;
  assert.throws(() => systemdManager(f.L, process.pid, f.opts, f.fail), { code: 'DEV_RELEASE_SYSTEMD_CUSTODY_INVALID' });
});
unitTest('systemctl unavailability and inaccessible process custody refuse without effects', t => {
  const f = fixture(t);
  f.opts.systemctl = () => ({ status: null, error: { code: 'ENOENT' } });
  assert.throws(() => systemdManager(f.L, process.pid, f.opts, f.fail), { code: 'DEV_RELEASE_SYSTEMD_UNAVAILABLE' });
  f.opts.readCgroup = () => { throw new Error('unavailable'); };
  assert.throws(() => systemdManager(f.L, process.pid, f.opts, f.fail), { code: 'DEV_RELEASE_PROCESS_CUSTODY_UNAVAILABLE' });
});
unitTest('retained manager is revalidated for stopped-service restart and stop, with exact commands and deadline', t => {
  const f = fixture(t); retainManager(f.L, systemdManager(f.L, process.pid, f.opts, f.fail));
  f.properties.MainPID = 0;
  assert.equal(restartManaged(f.L, f.opts, f.fail), null); stopManaged(f.L, f.opts, f.fail);
  assert.deepEqual(f.calls.filter(call => call.args[1] !== 'show'), [
    { args: ['--user', 'restart', 'deckent-n1.service'], timeout: 1234 }, { args: ['--user', 'stop', 'deckent-n1.service'], timeout: 1234 },
  ]);
});
unitTest('failed restart preserves the manager and reports failure instead of raw fallback; failed stop is typed', t => {
  const f = fixture(t); retainManager(f.L, systemdManager(f.L, process.pid, f.opts, f.fail));
  const show = f.opts.systemctl;
  f.opts.systemctl = (args, timeout) => args[1] === 'show' ? show(args, timeout) : { status: 1, stderr: 'test control failure' };
  assert.deepEqual(restartManaged(f.L, f.opts, f.fail), { code: 'SYSTEMCTL_RESTART_FAILED', message: 'test control failure' });
  assert.throws(() => stopManaged(f.L, f.opts, f.fail), { code: 'DEV_RELEASE_SYSTEMD_STOP_FAILED' });
  assert.equal(JSON.parse(readFileSync(join(f.L.installRoot, 'service-unit.json'), 'utf8')).unit, 'deckent-n1.service');
});
unitTest('altered manager hint refuses before contacting a unit', t => {
  const f = fixture(t); retainManager(f.L, systemdManager(f.L, process.pid, f.opts, f.fail));
  const hint = join(f.L.installRoot, 'service-unit.json');
  for (const value of ['{malformed', JSON.stringify({ unit: 'deckent-n1.service', project: '/foreign', launcher: f.L.launcher, installRoot: f.L.installRoot })]) {
    writeFileSync(hint, value); const calls = f.calls.length;
    assert.throws(() => restartManaged(f.L, f.opts, f.fail), { code: 'DEV_RELEASE_SYSTEMD_CUSTODY_INVALID' });
    assert.equal(f.calls.length, calls);
  }
});
