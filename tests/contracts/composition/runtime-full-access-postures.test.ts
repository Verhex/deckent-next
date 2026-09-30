import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { landlockShellSandbox, type ShellSandboxFactory } from '#adapters/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { measureTestShellHost, linuxShellHost } from '../../fixtures/shell-host.js';

// Merge boundary of Astra 2170 (three write postures of an unattended sandboxed call) and MODES-3 (full access), owner 2026-09-29: full access
// is comprehensive — a full-access call is owner-authorized by the launched mode, so inside a sandbox realm it writes the project, the write
// floor (existing and new names) and `.git`, while the configuration file stays read-only and the product state stays masked. In standart and
// full-auto the three Astra 2170 postures are unchanged: a full-auto sandbox relaxation sees the whole project read-only; an owner-approved
// call writes. Real runtime service, real policy/bindings files, real bubblewrap and the real Landlock helper (forced as the only provider).
afterEach(closeModeRuntimes);
const measured = await measureTestShellHost();
const bwrapReady = measured.bubblewrap.status === 'available';
const landlockAbi = measured.landlock.status === 'available' ? measured.landlock.abi ?? 0 : 0;
const landlockOnly: ShellSandboxFactory = layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable(linuxShellHost({ landlock: { status: 'available', abi: landlockAbi } })) }];
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
      // FA-TRACKED-WARN: the call overwrites the tracked package.json, so the counts lead the line and the tracked line names it.
      expect(wrote.text).toMatch(new RegExp(`^\\[deckent\\] run_shell: tracked: deleted=0 overwritten=1; sandbox: ${realm}; exit 0`, 'u'));
      expect(wrote.text).toContain('[deckent] tracked files changed: deleted 0, overwritten 1 (package.json)');
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
      // nor commit (Astra 2170 R1 holds). SHELL-OVERLAY × BWRAP-SELECT: where the selected bubblewrap has overlay the writes go to a write
      // set, each decided like an edit (no write grant here: refused, nothing applied) and `.git` stays read-only inside the overlay view.
      await writeFile(join(f.project, 'src/b.ts'), 'export const b = 2;\n');
      const writeSet = realm === 'bubblewrap' && measured.bubblewrap.launcher?.overlay === true;
      for (const [command, path] of [['f=pack; echo x > src/${f}age2.json', 'src/package2.json'], ['n=notes; echo hi > src/${n}.txt', 'src/notes.txt'],
        [`${COMMIT} full-auto-commit`, null]] as const) {
        const result = await f.call('run_shell', { command });
        const applied = writeSet && path !== null;
        expect({ command, card: result.card, status: result.status }).toEqual({ command, card: false, status: applied ? 'ok' : 'error' });
        expect(result.text).toContain(!writeSet ? 'the project was read-only for this unattended run'
          : path ? `[deckent] write set: not applied: ${path} (denied by policy).` : 'Read-only file system');
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

// A company rule that is `require-approval` but not `modeEligible`: `decideAgentToolCall` never lowers it (`lowerable` fails before the
// full-access grant is even consulted), so it asks in a full-access turn too. Once the owner answers such a card, `execute` runs the call
// as `owner-approved` (mode.ts), the same authority any other card gets — never `full-access` — so the card's write text must read like
// any other owner-approved card except for `.git`, which still follows the turn's layout (MODES-3).
const NOT_ELIGIBLE = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval'), rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS];

describe.skipIf(process.platform !== 'linux')('the approval card describes the write posture the call will actually get, not a static per-realm line', () => {
  for (const realm of ['bubblewrap', 'landlock'] as const) {
    it.skipIf(realm === 'bubblewrap' ? !bwrapReady : landlockAbi < 6)(`${realm}: a standart owner-approved card says .git read-only; the same authority in a full-access turn says .git writable`, async () => {
      // Standart (no stored permission mode: a require-approval rule never lowers on its own): an ordinary owner-approved card. Outside a
      // full-access turn `.git` is never writable, whatever approves the call.
      const standart = await modeRuntime({ grants: GRANTS, mode: null, dataRoot: DATA, ...REALMS[realm] });
      const approvedStandart = await standart.call('run_shell', { command: 'echo hi' }, 'allow');
      expect(approvedStandart.card).toBe(true);
      const standartCard = approvedStandart.events.find(event => event.kind === 'approval.requested');
      if (standartCard?.kind !== 'approval.requested') throw new Error('no card was requested');
      expect(standartCard.preview).toContain(realm === 'bubblewrap' ? 'bubblewrap' : 'Landlock');
      expect(standartCard.preview).toContain('the project is writable');
      expect(standartCard.preview).toContain('.git read-only');
      expect(standartCard.preview).not.toContain('.git writable');

      // Full access, a non-eligible company rule: the call still asks. Approved, it runs as `owner-approved` (never `full-access`), so
      // the card already said what the effect will do: the project (write floor included) writes, and this turn also writes `.git`.
      const forced = await modeRuntime({ grants: NOT_ELIGIBLE, mode: 'full-auto', dataRoot: DATA, ...REALMS[realm] });
      const approvedForced = await forced.call('run_shell', { command: 'echo hi' }, 'allow', { fullAccess: true });
      expect(approvedForced.card).toBe(true);
      const forcedCard = approvedForced.events.find(event => event.kind === 'approval.requested');
      if (forcedCard?.kind !== 'approval.requested') throw new Error('no card was requested');
      const noCalls = forced.audit().map(record => record.event.subject).filter(subject => subject['kind'] === 'full-access-call');
      expect(noCalls).toHaveLength(0); // owner-approved, never the audited full-access-call authority.
      expect(forcedCard.preview).toContain('the project is writable');
      expect(forcedCard.preview).toContain('.git writable');
      expect(forcedCard.preview).not.toContain('.git read-only');
      // OPEN-SANDBOX: the card of a full-access turn names the open view (bubblewrap) or says it is not available (Landlock, require-sandbox).
      expect(forcedCard.preview).toContain(realm === 'bubblewrap' ? 'network on, HOME visible, Deckent state and credentials hidden/read-only' : 'full access: no open sandbox');

      // The card's "write floor included" is not just wording: an owner-approved call in this same full-access turn actually opens the
      // installation's own configuration file for writing — `>>` with zero bytes only succeeds under O_WRONLY, content unchanged either
      // way — the exact fact the standart card above does not have to say (its write floor is never approved open).
      const configPath = join(forced.project, '.deckent/config.json');
      const before = await readFile(configPath, 'utf8');
      const probe = await forced.call('run_shell', { command: 'printf "" >> .deckent/config.json && echo CONFIG_OPEN_RW' }, 'allow', { fullAccess: true });
      expect({ card: probe.card, status: probe.status, open: probe.text.includes('CONFIG_OPEN_RW') }).toEqual({ card: true, status: 'ok', open: true });
      expect(await readFile(configPath, 'utf8')).toBe(before);
    }, 60_000);
  }
});
