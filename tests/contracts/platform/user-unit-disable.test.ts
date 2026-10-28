import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { disableUserUnit, observeUserUnit, userUnitFile, userUnitLinks } from '#platform/index.js';

it.skipIf(process.platform !== 'linux')('F2: a caller/manager XDG mismatch cannot authorize disable, including a previously confirmed plan; foreign receipts and units stay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-unit-f2-'));
  try {
    const caller = join(root, 'caller/systemd/user'), manager = join(root, 'manager/systemd/user'), fragment = join(root, 'data/systemd/user/deckent.service');
    for (const dir of [caller, manager, join(root, 'data/systemd/user')]) await mkdir(dir, { recursive: true });
    await writeFile(fragment, '[Service]\nExecStart=/bin/true\n');
    await writeFile(join(manager, 'deckent.service'), '[Install]\nAlso=other.service\n');
    await symlink(fragment, join(manager, 'other.service'));
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'caller'), XDG_DATA_HOME: join(root, 'data') }, receipts = join(root, 'receipts');
    await mkdir(receipts); await writeFile(join(receipts, 'unit-deckent.service.intent.json'), 'PERSON DATA', { mode: 0o600 });
    const calls: string[][] = [], exec = async (args: readonly string[]) => { calls.push([...args]);
      return { stdout: `FragmentPath=${fragment}\nNames=deckent.service\nDropInPaths=\nUnitFileState=enabled\nActiveState=inactive\n`, stderr: '' }; };
    const confirmed = { unit: 'deckent.service', links: await userUnitLinks('deckent.service', env), unitFile: await userUnitFile('deckent.service', exec, env) };
    expect(confirmed.unitFile).toMatch(/^[a-f0-9]{64}$/u);
    expect(await observeUserUnit({ scope: 'user', unit: confirmed.unit }, process.pid, exec, env)).toMatchObject({ unitDisable: 'command-only', links: [], unitFile: null });
    calls.length = 0;
    await expect(disableUserUnit(confirmed, exec, receipts, env)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
    expect(calls).toEqual([]); expect(await readdir(receipts)).toEqual(['unit-deckent.service.intent.json']);
    expect(await readFile(join(receipts, 'unit-deckent.service.intent.json'), 'utf8')).toBe('PERSON DATA');
    expect(await readFile(join(manager, 'deckent.service'), 'utf8')).toContain('Also=other.service');
    expect(await readdir(manager)).toEqual(['deckent.service', 'other.service']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('F4: even an inactive confirmed unit cannot stop a new instance during receipt/exec; no observation is used as an admission fence', async () => {
  let stopped = false, receiptGapReached = false;
  const exec = async (args: readonly string[]) => { if (args[0] === 'disable') stopped = true;
    // A service starts accepting new work immediately after an inactive answer.
    receiptGapReached = true; return { stdout: 'ActiveState=inactive\nUnitFileState=enabled\n', stderr: '' }; };
  await expect(disableUserUnit({ unit: 'deckent.service', links: [], unitFile: 'a'.repeat(64) }, exec, '/not-used'))
    .rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
  expect(stopped).toBe(false); expect(receiptGapReached).toBe(false);
});

it.skipIf(process.platform !== 'linux')('F5: an external alias chain with a missing final target is unknown; neither disable nor an incomplete receipt is produced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-unit-chain-'));
  try {
    const units = join(root, 'config/systemd/user'), external = join(root, 'external');
    await mkdir(units, { recursive: true }); await mkdir(external);
    await symlink(join(root, 'deckent.service'), join(external, 'alias.service'));
    await symlink(join(external, 'alias.service'), join(units, 'first.service'));
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, 'config') };
    await expect(userUnitLinks('deckent.service', env)).rejects.toMatchObject({ code: 'ENOENT' });
    let calls = 0;
    await expect(disableUserUnit({ unit: 'deckent.service', links: [], unitFile: 'a'.repeat(64) }, async () => { calls++; return { stdout: '', stderr: '' }; }, join(root, 'receipts'), env))
      .rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
    expect(calls).toBe(0); expect(await readdir(units)).toEqual(['first.service']); expect(await readdir(root)).not.toContain('receipts');
  } finally { await rm(root, { recursive: true, force: true }); }
});
