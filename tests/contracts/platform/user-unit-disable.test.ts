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
    const calls: string[][] = [], exec = async (args: readonly string[]) => { calls.push([...args]);
      if (args[0] === 'show') return { stdout: `FragmentPath=${fragment}\nNames=deckent.service\nDropInPaths=\nUnitFileState=enabled\nActiveState=active\n`, stderr: '' };
      // systemd removes the persistent links it matched (here: all three) and reports them.
      for (const entry of links) await unlink(entry.split(' -> ')[0]!);
      return { stdout: '', stderr: `Removed "${join(units, 'mine.service')}".\n` }; };
    const confirmed = { unit: 'deckent.service', links, unitFile: await userUnitFile('deckent.service', exec) };
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
    calls.length = 0;
    const done = await disableUserUnit(confirmed, exec, receipts, env);
    expect(done).toMatchObject({ unit: 'deckent.service', previous: 'enabled', links });
    expect(JSON.parse(await readFile(join(receipts, 'unit-deckent.service.intent.json'), 'utf8'))).toMatchObject({ links, previous: 'enabled', active: 'active' });
    expect(JSON.parse(await readFile(join(receipts, 'unit-deckent.service.result.json'), 'utf8'))).toMatchObject({ ok: true, links, linksAfter: [], stderr: expect.stringContaining('Removed') });
    // The undo recreates exactly the links that went (shell-quoted, idempotent); the systemctl steps after it are the person's.
    expect(done.undo.endsWith(' && systemctl --user daemon-reload && systemctl --user start deckent.service')).toBe(true);
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
