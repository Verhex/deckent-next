import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { disableUserUnit, userUnitLinks } from '#platform/index.js';

it.skipIf(process.platform !== 'linux')('disables a user unit only with the confirmed links, writing the intent before and systemctl\'s own result after', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-unit-'));
  try {
    const config = join(root, 'config'), runtime = join(root, 'runtime'), units = join(config, 'systemd/user'), fragment = join(units, 'deckent.service');
    const env = { HOME: root, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime }, receipts = join(root, 'recovery');
    await mkdir(join(units, 'default.target.wants'), { recursive: true }); await mkdir(join(runtime, 'systemd/user/timers.target.wants'), { recursive: true });
    await writeFile(fragment, '[Service]\nExecStart=/bin/true\n');
    // An [Install] link, a runtime enablement link and a hand-made alias: all three are what `disable` removes, and the undo recreates each.
    await symlink(fragment, join(units, 'default.target.wants/deckent.service')); await symlink(fragment, join(runtime, 'systemd/user/timers.target.wants/deckent.service'));
    await symlink(fragment, join(units, 'mine.service'));
    const links = await userUnitLinks('deckent.service', env);
    expect(links).toEqual([`${join(units, 'default.target.wants/deckent.service')} -> ${fragment}`, `${join(units, 'mine.service')} -> ${fragment}`,
      `${join(runtime, 'systemd/user/timers.target.wants/deckent.service')} -> ${fragment}`]);
    const calls: string[][] = [], exec = async (args: readonly string[]) => { calls.push([...args]);
      return args[0] === 'show' ? { stdout: 'UnitFileState=enabled\nActiveState=active\n', stderr: '' } : { stdout: '', stderr: `Removed "${join(units, 'mine.service')}".\n` }; };
    // Negative: links that changed after the card (here one more) disable nothing.
    await expect(disableUserUnit('deckent.service', exec, links.slice(1), receipts, env)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
    expect(calls.some(args => args[0] === 'disable')).toBe(false);
    const done = await disableUserUnit('deckent.service', exec, links, receipts, env);
    expect(done).toMatchObject({ unit: 'deckent.service', previous: 'enabled', links });
    expect(done.undo).toBe(`${links.map(entry => { const [path, target] = entry.split(' -> '); return `ln -s '${target}' '${path}'`; }).join(' && ')} && systemctl --user daemon-reload && systemctl --user start deckent.service`);
    expect(JSON.parse(await readFile(join(receipts, 'unit-deckent.service.intent.json'), 'utf8'))).toMatchObject({ links, previous: 'enabled', active: 'active' });
    expect(JSON.parse(await readFile(join(receipts, 'unit-deckent.service.result.json'), 'utf8'))).toMatchObject({ ok: true, stderr: expect.stringContaining('Removed') });
    // A failed disable keeps its own messages in the result receipt and is a typed refusal.
    const failing = async (args: readonly string[]) => { if (args[0] === 'show') return { stdout: 'UnitFileState=enabled\nActiveState=active\n', stderr: '' };
      throw Object.assign(new Error('exit 1'), { stderr: 'Failed to disable unit: Access denied' }); };
    await expect(disableUserUnit('deckent.service', failing, links, join(root, 'second'), env)).rejects.toMatchObject({ code: 'UNINSTALL_SERVICE_RUNNING' });
    expect(JSON.parse(await readFile(join(root, 'second/unit-deckent.service.result.json'), 'utf8'))).toMatchObject({ ok: false, stderr: 'Failed to disable unit: Access denied' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
