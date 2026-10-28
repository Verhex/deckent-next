import { execFileSync } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { disableUserUnit, userUnitFile, userUnitLinks } from '#platform/index.js';

it.skipIf(process.platform !== 'linux')('disables a user unit only with the confirmed unit file and links, writing the intent before and the links actually gone after', async () => {
  // A quote in the home path: the undo must quote it for the shell.
  const root = await mkdtemp(join(tmpdir(), "deckent-unit-'q-"));
  try {
    const config = join(root, 'config'), runtime = join(root, 'runtime'), units = join(config, 'systemd/user'), fragment = join(units, 'deckent.service');
    const env = { HOME: root, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime }, receipts = join(root, 'recovery');
    await mkdir(join(units, 'default.target.wants'), { recursive: true }); await mkdir(join(runtime, 'systemd/user'), { recursive: true });
    await writeFile(fragment, '[Service]\nExecStart=/bin/true\n');
    // R5: what `disable` removes: an [Install] link, a link under another name whose target is the unit, and a hand-made alias.
    await symlink(fragment, join(units, 'default.target.wants/deckent.service')); await symlink('../deckent.service', join(units, 'default.target.wants/other.service'));
    await symlink(fragment, join(units, 'mine.service'));
    const links = await userUnitLinks('deckent.service', env);
    expect(links).toEqual([`${join(units, 'default.target.wants/deckent.service')} -> ${fragment}`, `${join(units, 'default.target.wants/other.service')} -> ../deckent.service`,
      `${join(units, 'mine.service')} -> ${fragment}`]);
    let activeState = 'inactive';
    const calls: string[][] = [], exec = async (args: readonly string[]) => { calls.push([...args]);
      if (args[0] === 'show') return { stdout: `FragmentPath=${fragment}\nNames=deckent.service\nDropInPaths=\nUnitFileState=enabled\nActiveState=${activeState}\n`, stderr: '' };
      // systemd removes the persistent links it matched (here: all three) and reports them.
      for (const entry of links) await unlink(entry.split(' -> ')[0]!);
      return { stdout: '', stderr: `Removed "${join(units, 'mine.service')}".\n` }; };
    const confirmed = { unit: 'deckent.service', links, unitFile: await userUnitFile('deckent.service', exec, env) };
    expect(confirmed.unitFile).toMatch(/^[a-f0-9]{64}$/u);
    const refusedWith = async (changed: object) => { calls.length = 0;
      await expect(disableUserUnit({ ...confirmed, ...changed }, exec, receipts, env)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
      expect(calls.some(args => args[0] === 'disable')).toBe(false); };
    // Negative: links that changed after the card (here one fewer confirmed) disable nothing.
    await refusedWith({ links: links.slice(1) });
    // R3: Also= added to the unit file after the card (the service already gone, no process to read) is seen right before: nothing disabled.
    await appendFile(fragment, '[Install]\nAlso=other-unit.service\n'); await refusedWith({});
    await writeFile(fragment, '[Service]\nExecStart=/bin/true\n');
    // R5: a runtime link (persistent `disable` keeps it, the undo would not be exact) and an unreadable folder (unknown, never "no links") refuse.
    await symlink(fragment, join(runtime, 'systemd/user/deckent.service'));
    await refusedWith({ links: await userUnitLinks('deckent.service', env) }); await unlink(join(runtime, 'systemd/user/deckent.service'));
    await mkdir(join(units, 'timers.target.wants')); await chmod(join(units, 'timers.target.wants'), 0o000);
    if (process.getuid?.() !== 0) { await expect(userUnitLinks('deckent.service', env)).rejects.toThrow(); await refusedWith({}); }
    await chmod(join(units, 'timers.target.wants'), 0o700);
    // F4: an instance that started after the last absence check (active, activating, unknown) is never stopped by --now.
    for (const state of ['active', 'activating', 'unknown']) { activeState = state; await refusedWith({}); } activeState = 'inactive';
    // F1: a file of someone else's at a receipt's name stays byte for byte and nothing is disabled.
    await mkdir(receipts, { mode: 0o700 }); await writeFile(join(receipts, 'unit-deckent.service.intent.json'), 'PERSON DATA', { mode: 0o600 }); calls.length = 0;
    await expect(disableUserUnit(confirmed, exec, receipts, env)).rejects.toMatchObject({ reason: 'changed' });
    expect(calls.some(args => args[0] === 'disable')).toBe(false); expect(await readFile(join(receipts, 'unit-deckent.service.intent.json'), 'utf8')).toBe('PERSON DATA');
    await unlink(join(receipts, 'unit-deckent.service.intent.json'));
    calls.length = 0;
    const done = await disableUserUnit(confirmed, exec, receipts, env);
    expect(done).toMatchObject({ unit: 'deckent.service', previous: 'enabled', links });
    expect(JSON.parse(await readFile(join(receipts, 'unit-deckent.service.intent.json'), 'utf8'))).toMatchObject({ links, previous: 'enabled', active: 'inactive' });
    expect(JSON.parse(await readFile(join(receipts, 'unit-deckent.service.result.json'), 'utf8'))).toMatchObject({ ok: true, links, linksAfter: [], stderr: expect.stringContaining('Removed') });
    // The undo recreates exactly the links that went (shell-quoted, idempotent); the systemctl steps after it are the person's.
    expect(done.undo.endsWith(' && systemctl --user daemon-reload')).toBe(true);
    const relink = done.undo.slice(0, done.undo.indexOf(' && systemctl'));
    execFileSync('/bin/sh', ['-c', relink]); execFileSync('/bin/sh', ['-c', relink]);
    expect(await userUnitLinks('deckent.service', env)).toEqual(links);
    expect(await readlink(join(units, 'default.target.wants/other.service'))).toBe('../deckent.service');
    // A failed disable keeps its own messages in the result receipt and is a typed refusal; nothing went, so nothing is to undo.
    const failing = async (args: readonly string[]) => { if (args[0] === 'show') return exec(args);
      throw Object.assign(new Error('exit 1'), { stderr: 'Failed to disable unit: Access denied' }); };
    await expect(disableUserUnit(confirmed, failing, join(root, 'second'), env)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
    expect(JSON.parse(await readFile(join(root, 'second/unit-deckent.service.result.json'), 'utf8'))).toMatchObject({ ok: false, links: [], stderr: 'Failed to disable unit: Access denied' });
    // R14: a receipt folder behind a link is refused before anything is disabled; nothing is written through it.
    const outside = join(root, 'outside'); await mkdir(outside); await symlink(outside, join(root, 'linked'));
    calls.length = 0;
    await expect(disableUserUnit(confirmed, exec, join(root, 'linked/recovery'), env)).rejects.toMatchObject({ reason: 'unsafe' });
    expect(calls.some(args => args[0] === 'disable')).toBe(false); await expect(lstat(join(outside, 'recovery'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('F2/F5: disable acts only on the unit file systemd resolves from disk and records every chained link it removed, or nothing is known', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-unit-f2-'));
  try {
    const config = join(root, 'config'), units = join(config, 'systemd/user'), vendor = join(root, 'data/systemd/user'), fragment = join(vendor, 'deckent.service');
    const env = { HOME: root, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: join(root, 'runtime') }, receipts = join(root, 'recovery');
    await mkdir(join(units, 'default.target.wants'), { recursive: true }); await mkdir(vendor, { recursive: true }); await writeFile(fragment, '[Service]\nExecStart=/bin/true\n');
    // F5: `second` names `first`, which names the unit: systemd chases both and removes both.
    await symlink(fragment, join(units, 'default.target.wants/first.service')); await symlink('first.service', join(units, 'default.target.wants/second.service'));
    const links = await userUnitLinks('deckent.service', env);
    expect(links).toEqual([`${join(units, 'default.target.wants/first.service')} -> ${fragment}`, `${join(units, 'default.target.wants/second.service')} -> first.service`]);
    let afterDisable = async () => { for (const entry of links) await unlink(entry.split(' -> ')[0]!); };
    const calls: string[][] = [], exec = async (args: readonly string[]) => { calls.push([...args]);
      // The manager still reports the vendor fragment it loaded at start.
      if (args[0] === 'show') return { stdout: `FragmentPath=${fragment}\nNames=deckent.service\nDropInPaths=\nUnitFileState=enabled\nActiveState=inactive\n`, stderr: '' };
      await afterDisable(); return { stdout: '', stderr: '' }; };
    const confirmed = { unit: 'deckent.service', links, unitFile: await userUnitFile('deckent.service', exec, env) };
    expect(confirmed.unitFile).toMatch(/^[a-f0-9]{64}$/u);
    const refused = async () => { calls.length = 0;
      await expect(disableUserUnit(confirmed, exec, receipts, env)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' }); expect(calls.some(args => args[0] === 'disable')).toBe(false); };
    // F2: a higher-precedence unit of the same name (here with Also=) is what `disable` would read from disk: nothing is disabled.
    await writeFile(join(units, 'deckent.service'), '[Install]\nAlso=other.service\n'); await refused(); await unlink(join(units, 'deckent.service'));
    // ...and so is a mask or a linked unit in front of it, and a drop-in folder for it anywhere on the search path.
    await symlink('/dev/null', join(units, 'deckent.service')); await refused(); await unlink(join(units, 'deckent.service'));
    await mkdir(join(vendor, 'deckent.service.d')); await refused(); await rm(join(vendor, 'deckent.service.d'), { recursive: true });
    // F5: a re-read that fails after `disable` leaves the result unknown: no links counted gone, no undo, a typed refusal.
    if (process.getuid?.() !== 0) {
      afterDisable = async () => { await mkdir(join(units, 'locked')); await chmod(join(units, 'locked'), 0o000); };
      await expect(disableUserUnit(confirmed, exec, receipts, env)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
      expect(JSON.parse(await readFile(join(receipts, 'unit-deckent.service.result.json'), 'utf8'))).toMatchObject({ ok: true, links: null, linksAfter: null, undo: null });
      await chmod(join(units, 'locked'), 0o700); await rm(join(units, 'locked'), { recursive: true });
      afterDisable = async () => { for (const entry of links) await unlink(entry.split(' -> ')[0]!); };
    }
    // Both chained links are recorded as gone and the undo recreates both.
    const done = await disableUserUnit(confirmed, exec, receipts, env);
    expect(done.links).toEqual(links);
    execFileSync('/bin/sh', ['-c', done.undo.slice(0, done.undo.indexOf(' && systemctl'))]);
    expect(await userUnitLinks('deckent.service', env)).toEqual(links);
  } finally { await rm(root, { recursive: true, force: true }); }
});
