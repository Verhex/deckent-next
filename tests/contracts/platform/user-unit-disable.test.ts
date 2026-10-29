import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { disableUserUnit, observeUserUnit, userUnitFile, userUnitLinks, HOST_LIMITS_REGISTRY, type UserUnitExec } from '#platform/index.js';

async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(); try { await work(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-k4-unit-')), units = join(root, 'manager'), unit = 'deckent-k4-test.service';
  await mkdir(units); const fragment = join(units, unit), link = join(units, 'default.target.wants', unit), receipts = join(root, 'receipts');
  await mkdir(join(units, 'default.target.wants')); await writeFile(fragment, '[Service]\nExecStart=/bin/true\n[Install]\nWantedBy=default.target\n'); await symlink(fragment, link);
  const state: Record<string, string> = { UnitPath: units, FragmentPath: fragment, Names: unit, DropInPaths: '', NeedDaemonReload: 'no', LoadState: 'loaded',
    MainPID: '41', ControlGroup: '/fixture', ActiveState: 'active', UnitFileState: 'enabled' }, paths = [link], calls: string[][] = [];
  const query = async () => paths, exec: UserUnitExec = async args => { calls.push([...args]);
    if (args[0] === 'disable') { for (const path of paths) await unlink(path); const gone = paths.splice(0); return { stdout: '', stderr: gone.map(path => `Removed "${path}".`).join('\n') }; }
    return { stdout: Object.entries(state).map(([key, value]) => `${key}=${value}`).join('\n'), stderr: '' };
  };
  const observe = () => observeUserUnit({ scope: 'user', unit }, 41, exec, query, () => '41\n');
  const stop = () => { state['MainPID'] = '0'; state['ControlGroup'] = ''; state['ActiveState'] = 'inactive'; };
  return { root, units, unit, fragment, link, receipts, state, paths, calls, query, exec, observe, stop, fence: { assert: async () => {} } };
}
it.skipIf(process.platform !== 'linux')('K4: the manager view supplies the approved links, exact effect receipt and undo; the fragment stays', async () => fixture(async f => {
  const approved = { unit: f.unit, ...await f.observe() }; expect(approved.unitDisable).toBe('eligible'); f.stop();
  const result = await disableUserUnit(approved, f.exec, f.receipts, f.query, f.fence);
  expect(result).toEqual({ unit: f.unit, previous: 'enabled', links: [`${f.link} -> ${f.fragment}`], undo: `mkdir -p -- '${join(f.units, 'default.target.wants')}' && ln -s -- '${f.fragment}' '${f.link}'` });
  const receipt = JSON.parse(await readFile(join(f.receipts, `unit-${f.unit}.result.json`), 'utf8'));
  expect(receipt.changed).toEqual([f.link]); expect(receipt.undo).toBe(result.undo); expect(await readFile(f.fragment, 'utf8')).toContain('ExecStart');
  expect(f.calls.filter(args => args[0] === 'disable')).toEqual([['disable', '--now', '--', f.unit]]);
}));
it.skipIf(process.platform !== 'linux')('F2: caller XDG divergence cannot redirect manager evidence; an overriding Also unit is refused before disable', async () => fixture(async f => {
  const caller = join(f.root, 'caller'); await mkdir(caller); await writeFile(join(caller, f.unit), '[Install]\nAlso=foreign.service\n');
  // Caller paths never enter the manager observation port.
  const approved = { unit: f.unit, ...await f.observe() }; expect(approved.unitDisable).toBe('eligible');
  const override = join(f.root, 'override'); await mkdir(override); await writeFile(join(override, f.unit), '[Install]\nAlso=foreign.service\n');
  f.state['UnitPath'] = `${override} ${f.units}`; f.stop();
  await expect(disableUserUnit(approved, f.exec, f.receipts, f.query, f.fence)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(f.calls.some(args => args[0] === 'disable')).toBe(false); expect(await readdir(f.root)).not.toContain('receipts');
  expect(await readFile(join(caller, f.unit), 'utf8')).toContain('Also=foreign.service');
}));
it.skipIf(process.platform !== 'linux')('F2: manager reload-needed, loaded drop-ins and Also/Alias directives refuse automatic observation', async () => fixture(async f => {
  f.state['NeedDaemonReload'] = 'yes'; expect((await f.observe()).unitDisable).toBe('command-only');
  f.state['NeedDaemonReload'] = 'no'; f.state['DropInPaths'] = join(f.units, 'override.conf'); expect((await f.observe()).unitDisable).toBe('command-only');
  f.state['DropInPaths'] = ''; await writeFile(f.fragment, '[Install]\nAlias=other.service\n'); expect(await userUnitFile(f.unit, f.exec)).toBeNull();
  await writeFile(f.fragment, '[Install]\nAlso=other.service\n'); expect((await f.observe()).unitDisable).toBe('command-only');
  await writeFile(f.fragment, 'x'.repeat(HOST_LIMITS_REGISTRY.processFileReadBytes + 1)); expect(await userUnitFile(f.unit, f.exec)).toBeNull();
}));
it.skipIf(process.platform !== 'linux')('F4: startup custody is required; a new instance after the intent receipt prevents --now', async () => fixture(async f => {
  const approved = { unit: f.unit, ...await f.observe() }; f.stop();
  await expect(disableUserUnit(approved, f.exec, f.receipts, f.query)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  let checks = 0;
  await expect(disableUserUnit(approved, f.exec, f.receipts, f.query, { async assert() { if (++checks === 2) { f.state['MainPID'] = '55'; f.state['ActiveState'] = 'active'; } } }))
    .rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(checks).toBe(2); expect(f.calls.some(args => args[0] === 'disable')).toBe(false);
  expect(await readdir(f.receipts)).toEqual([`unit-${f.unit}.intent.json`]);
}));
it.skipIf(process.platform !== 'linux')('F5: manager-resolved external dangling aliases are included in the changed set and exact undo', async () => fixture(async f => {
  const external = join(f.root, 'external'); await mkdir(external);
  await symlink(join(f.root, 'missing', f.unit), join(external, 'alias.service'));
  const first = join(f.units, 'first.service'); await symlink(join(external, 'alias.service'), first); f.paths.push(first);
  const approved = { unit: f.unit, ...await f.observe() }; expect(approved.links).toContain(`${first} -> ${join(external, 'alias.service')}`); f.stop();
  const result = await disableUserUnit(approved, f.exec, f.receipts, f.query, f.fence);
  expect(result.links).toEqual([`${f.link} -> ${f.fragment}`, `${first} -> ${join(external, 'alias.service')}`].sort());
  expect(JSON.parse(await readFile(join(f.receipts, `unit-${f.unit}.result.json`), 'utf8')).changed).toEqual([f.link, first].sort());
  expect(await readdir(f.units)).not.toContain('first.service'); expect(await readdir(external)).toEqual(['alias.service']);
}));
it.skipIf(process.platform !== 'linux')('K4: foreign intent and result receipts are preserved before any effect', async () => fixture(async f => {
  const approved = { unit: f.unit, ...await f.observe() }; f.stop(); await mkdir(f.receipts);
  const intent = join(f.receipts, `unit-${f.unit}.intent.json`); await writeFile(intent, 'PERSON DATA');
  await expect(disableUserUnit(approved, f.exec, f.receipts, f.query, f.fence)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(await readFile(intent, 'utf8')).toBe('PERSON DATA'); await unlink(intent);
  const result = join(f.receipts, `unit-${f.unit}.result.json`); await writeFile(result, 'PERSON DATA');
  await expect(disableUserUnit(approved, f.exec, f.receipts, f.query, f.fence)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(await readFile(result, 'utf8')).toBe('PERSON DATA'); expect(f.calls.some(args => args[0] === 'disable')).toBe(false);
}));
it.skipIf(process.platform !== 'linux')('F5: a partial disable keeps an unknown receipt whose undo covers only the reported changed links', async () => fixture(async f => {
  const second = join(f.units, 'second.service'); await symlink(f.fragment, second); f.paths.push(second);
  const approved = { unit: f.unit, ...await f.observe() }; f.stop();
  const failing: UserUnitExec = async args => { if (args[0] !== 'disable') return f.exec(args);
    await unlink(f.link); throw Object.assign(new Error('manager stopped replying'), { stderr: `Removed "${f.link}".` }); };
  await expect(disableUserUnit(approved, failing, f.receipts, f.query, f.fence)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  const result = JSON.parse(await readFile(join(f.receipts, `unit-${f.unit}.result.json`), 'utf8'));
  expect(result.outcome).toBe('unknown'); expect(result.changed).toEqual([f.link]); expect(result.undo).toContain(`'${f.link}'`); expect(result.undo).not.toContain(second);
  expect(await readFile(second, 'utf8')).toContain('ExecStart');
}));

it('K4: missing manager link evidence refuses even an old eligible card, with no executor call', async () => {
  let calls = 0;
  await expect(disableUserUnit({ unit: 'deckent-k4-test.service', links: [], unitFile: 'a'.repeat(64) }, async () => { calls++; return { stdout: '', stderr: '' }; }, '/unused'))
    .rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' }); expect(calls).toBe(0);
});
it.skipIf(process.platform !== 'linux')('F5: an unprovable link or a changed manager link set refuses before the effect', async () => fixture(async f => {
  await expect(userUnitLinks(f.unit, async () => [join(f.root, 'absent')])).rejects.toMatchObject({ code: 'ENOENT' });
  const approved = { unit: f.unit, ...await f.observe() }; f.stop(); f.paths.length = 0;
  await expect(disableUserUnit(approved, f.exec, f.receipts, f.query, f.fence)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(f.calls.some(args => args[0] === 'disable')).toBe(false);
}));

it.skipIf(process.env['DECKENT_K4_SYSTEMD_TEST'] !== '1')('K4 real manager: caller XDG divergence, stopped-service custody, exact disable links and retained fragment', async () => {
  const { randomUUID } = await import('node:crypto'), { nativeServiceExec, nativeUserUnitLinks, acquireLedgerLock } = await import('#adapters/index.js');
  const root = await mkdtemp(join(tmpdir(), 'deckent-k4-manager-')), unit = `deckent-k4-test-${randomUUID()}.service`, fragment = join(root, unit);
  const env = { HOME: join(root, 'caller'), XDG_CONFIG_HOME: join(root, 'caller-config'), DBUS_SESSION_BUS_ADDRESS: process.env['DBUS_SESSION_BUS_ADDRESS'] };
  const exec = nativeServiceExec({ timeoutMs: 10000, outputBytes: 65536 }, env), query = nativeUserUnitLinks({ timeoutMs: 10000, outputBytes: 65536 }, env);
  await mkdir(env.HOME); await mkdir(env.XDG_CONFIG_HOME);
  await writeFile(fragment, '[Unit]\nDescription=Deckent K4 throwaway safety test\n[Service]\nType=exec\nExecStart=/usr/bin/sleep infinity\nRestart=no\n[Install]\nWantedBy=default.target\n', { mode: 0o600 });
  try {
    await exec(['link', '--no-reload', '--', fragment]); await exec(['enable', '--', unit]); await exec(['start', '--', unit]);
    const main = Number((await exec(['show', '--property', 'MainPID', '--value', '--', unit])).stdout.trim()); expect(main).toBeGreaterThan(0);
    const observation = await observeUserUnit({ scope: 'user', unit }, main, exec, query);
    console.info('K4 manager observation', JSON.stringify({ unit, main, processes: await query.processes(unit), unitFile: await userUnitFile(unit, exec), observation,
      manager: (await exec(['show', '--property', 'UnitPath'])).stdout,
      loaded: (await exec(['show', '--property', 'FragmentPath', '--property', 'Names', '--property', 'DropInPaths', '--property', 'NeedDaemonReload', '--property', 'LoadState', '--', unit])).stdout }));
    expect(observation.unitDisable).toBe('eligible');
    expect(observation.links.length).toBeGreaterThan(0); expect(observation.links.some(link => link.includes(env.HOME))).toBe(false);
    await exec(['stop', '--', unit]);
    const path = join(root, 'ledger-lock'), custody = acquireLedgerLock(path);
    try {
      const result = await disableUserUnit({ unit, ...observation }, exec, join(root, 'receipts'), query, { async assert() {
        expect(() => acquireLedgerLock(path)).toThrow(expect.objectContaining({ code: 'LOCAL_RUNTIME_ALREADY_RUNNING' }));
      } });
      expect(result.links).toEqual(observation.links); expect(result.undo).not.toContain('enable --now');
      expect(await readFile(fragment, 'utf8')).toContain('ExecStart=/usr/bin/sleep infinity');
      for (const link of observation.links) await expect(readFile(link.split(' -> ')[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
      const receipt = JSON.parse(await readFile(join(root, 'receipts', `unit-${unit}.result.json`), 'utf8'));
      expect(receipt.changed).toEqual(observation.links.map(link => link.split(' -> ')[0]).sort());
      console.info('K4 real-manager evidence', JSON.stringify({ unit, observation, result, changed: receipt.changed }));
    } finally { custody.release(); }
  } finally {
    await exec(['disable', '--now', '--', unit]).catch(() => undefined); await exec(['stop', '--', unit]).catch(() => undefined);
    await exec(['reset-failed', '--', unit]).catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
}, 30000);
