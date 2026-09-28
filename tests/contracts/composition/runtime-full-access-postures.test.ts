import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { landlockShellSandbox, probeShellCapabilities, type ShellSandboxFactory } from '#adapters/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// Merge boundary of Astra 2170 (three write postures of an unattended sandboxed call) and MODES-3 (full access), owner 2026-09-29: full access
// is comprehensive — a full-access call is owner-authorized by the launched mode, so inside a sandbox realm it writes the project, the write
// floor (existing and new names) and `.git`, while the configuration file stays read-only and the product state stays masked. In standart and
// full-auto the three Astra 2170 postures are unchanged: a full-auto sandbox relaxation sees the whole project read-only; an owner-approved
// call writes. Real runtime service, real policy/bindings files, real bubblewrap and the real Landlock helper (forced as the only provider).
afterEach(closeModeRuntimes);
const measured = await probeShellCapabilities();
const bwrapReady = measured.bubblewrap === 'available' && measured.userNamespace === 'available';
const landlockAbi = measured.landlock.status === 'available' ? measured.landlock.abi ?? 0 : 0;
const landlockOnly: ShellSandboxFactory = layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable({ platform: 'linux',
  bubblewrap: 'unavailable', userNamespace: 'available', landlock: { status: 'available', abi: landlockAbi } }) }];
const sandboxed = { schemaVersion: 1, realm: 'require-sandbox' };
const REALMS = { bubblewrap: { shell: sandboxed }, landlock: { shell: sandboxed, sandboxes: landlockOnly } } as const;
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const GRANTS = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS];
const DATA = '.deckent/data';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });
const COMMIT = 'git add -A src && git -c user.name=agent -c user.email=agent@example.invalid commit -qm';

describe.skipIf(process.platform !== 'linux')('full access composed with the Astra 2170 write postures in a sandbox realm', () => {
  for (const realm of ['bubblewrap', 'landlock'] as const) {
    it.skipIf(realm === 'bubblewrap' ? !bwrapReady : landlockAbi < 6)(`${realm}: full access writes a new floor name and commits; full-auto stays project read-only; standart owner-approved writes`, async () => {
      const f = await modeRuntime({ grants: GRANTS, mode: 'full-auto', dataRoot: DATA, ...REALMS[realm] });
      await writeFile(join(f.project, '.gitignore'), '.deckent/\n');
      await writeFile(join(f.project, 'package.json'), '{}\n');
      git(f.project, 'init', '-q'); git(f.project, 'add', '-A'); git(f.project, 'commit', '-qm', 'base');
      const config = await readFile(join(f.project, '.deckent/config.json'), 'utf8');
      const fa = { fullAccess: true } as const;

      // (1) Full access, no card: a NEW write-floor name (built at run time), an existing floor file and a commit to .git all land.
      const wrote = await f.call('run_shell', { command: `f=pack; echo '{"n":1}' > src/\${f}age.json && echo '{"v":2}' > package.json && ${COMMIT} full-access-floor` }, 'deny', fa);
      expect({ card: wrote.card, status: wrote.status, readOnly: wrote.text.includes('the project was read-only') }).toEqual({ card: false, status: 'ok', readOnly: false });
      expect(wrote.text).toMatch(new RegExp(`^\\[deckent\\] run_shell: sandbox: ${realm}; exit 0`, 'u'));
      expect(await readFile(join(f.project, 'src/package.json'), 'utf8')).toBe('{"n":1}\n');
      expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe('{"v":2}\n');
      expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe('full-access-floor');
      // …while the configuration file stays read-only and the product state stays masked, even by an expanded name.
      const overwrite = await f.call('run_shell', { command: 'echo {} > "$(printf .deck)ent/config.json"' }, 'deny', fa);
      expect({ card: overwrite.card, exit: /exit [1-9]/u.test(overwrite.text) }).toEqual({ card: false, exit: true });
      expect(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).toBe(config);
      const peek = await f.call('run_shell', { command: 'cat "$(printf .deck)ent/data/policy.json"' }, 'deny', fa);
      expect(peek.card).toBe(false);
      expect(peek.text).not.toContain('schemaVersion');
      // Full access never reads as the unattended read-only posture (no read-only note on its failures).
      expect(overwrite.text).not.toContain('the project was read-only');
      const calls = f.audit().map(record => record.event.subject).filter(subject => subject['kind'] === 'full-access-call');
      expect(calls).toHaveLength(3);

      // (2) Full-auto (no launch flag) in the same setup: the sandbox relaxation runs without a card but cannot create any project file,
      // nor commit (Astra 2170 R1 holds).
      await writeFile(join(f.project, 'src/b.ts'), 'export const b = 2;\n');
      for (const command of ['f=pack; echo x > src/${f}age2.json', 'n=notes; echo hi > src/${n}.txt', `${COMMIT} full-auto-commit`]) {
        const result = await f.call('run_shell', { command });
        expect({ command, card: result.card, status: result.status }).toEqual({ command, card: false, status: 'error' });
        expect(result.text).toContain('the project was read-only for this unattended run');
      }
      for (const path of ['src/package2.json', 'src/notes.txt']) await expect(access(join(f.project, path))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe('full-access-floor');

      // (3) Standart: an owner-approved call (card answered allow) writes the project, a new floor name included.
      await f.writeAuthority(GRANTS, null, 'standart');
      const approved = await f.call('run_shell', { command: 'm=Make; echo x > src/${m}file' }, 'allow');
      expect({ card: approved.card, status: approved.status }).toEqual({ card: true, status: 'ok' });
      expect(await readFile(join(f.project, 'src/Makefile'), 'utf8')).toBe('x\n');
    }, 180_000);
  }
});
