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
// full-auto an unattended sandbox relaxation sees the whole project read-only or keeps its writes aside; destructive redirection asks
// for approval. W3-SANDBOX refuses full access in Landlock (no open view) and preserves the configuration hard floor even after approval.
// Real runtime service, real policy/bindings files, real bubblewrap and the real Landlock helper (forced as the only provider).
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
    it.skipIf(realm === 'bubblewrap' ? !bwrapReady : landlockAbi < 6)(`${realm}: only an open sandbox admits full-access writes; full-auto retains its approval and write policy; standart owner-approved writes`, async () => {
      const f = await modeRuntime({ grants: GRANTS, mode: 'full-auto', dataRoot: DATA, ...REALMS[realm] });
      await writeFile(join(f.project, '.gitignore'), '.deckent/\n');
      await writeFile(join(f.project, 'package.json'), '{}\n');
      git(f.project, 'init', '-q'); git(f.project, 'add', '-A'); git(f.project, 'commit', '-qm', 'base');
      const config = await readFile(join(f.project, '.deckent/config.json'), 'utf8');
      const fa = { fullAccess: true } as const;

      // (1) The unchanged full-access command lands only in the open bubblewrap view; Landlock refuses before any effect.
      const wrote = await f.call('run_shell', { command: `f=pack; echo '{"n":1}' > src/\${f}age.json && echo '{"v":2}' > package.json && ${COMMIT} full-access-floor` }, 'deny', fa);
      expect({ card: wrote.card, status: wrote.status, readOnly: wrote.text.includes('the project was read-only') }).toEqual({ card: false, status: realm === 'bubblewrap' ? 'ok' : 'error', readOnly: false });
      if (realm === 'bubblewrap') {
        // FA-TRACKED-WARN: the call overwrites the tracked package.json, so the counts lead the line and the tracked line names it.
        expect(wrote.text).toMatch(new RegExp(`^\\[deckent\\] run_shell: tracked: deleted=0 overwritten=1; sandbox: ${realm}; exit 0`, 'u'));
        expect(wrote.text).toContain('[deckent] tracked files changed: deleted 0, overwritten 1 (package.json)');
        expect(await readFile(join(f.project, 'src/package.json'), 'utf8')).toBe('{"n":1}\n');
        expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe('{"v":2}\n');
        expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe('full-access-floor');
      } else {
        // W3-SANDBOX: Landlock has no open view. The same destructive command is refused before any filesystem or Git effect.
        expect(wrote.text).toContain('SHELL_SANDBOX_UNAVAILABLE');
        await expect(access(join(f.project, 'src/package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe('{}\n');
        expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe('base');
      }
      // …while the configuration file stays read-only and the product state stays masked, even by an expanded name.
      const overwrite = await f.call('run_shell', { command: 'echo {} > "$(printf .deck)ent/config.json"' }, 'deny', fa);
      expect({ card: overwrite.card, exit: /exit [1-9]/u.test(overwrite.text) }).toEqual({ card: false, exit: realm === 'bubblewrap' });
      if (realm === 'landlock') expect(overwrite.text).toContain('SHELL_SANDBOX_UNAVAILABLE');
      expect(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).toBe(config);
      const peek = await f.call('run_shell', { command: 'cat "$(printf .deck)ent/data/policy.json"' }, 'deny', fa);
      expect(peek.card).toBe(false);
      expect(peek.text).not.toContain('schemaVersion');
      // Full access never reads as the unattended read-only posture (no read-only note on its failures).
      expect(overwrite.text).not.toContain('the project was read-only');
      const calls = f.audit().map(record => record.event.subject).filter(subject => subject['kind'] === 'full-access-call');
      expect(calls).toHaveLength(realm === 'bubblewrap' ? 3 : 0);

      // (2) Full-auto (no launch flag): destructive redirection still asks; a denied card writes nothing. After approval, bubblewrap overlay
      // keeps each write aside for its file policy (no write grant here: refused, nothing applied). Without a write set approved writes are
      // direct, the accepted PLAN boundary. The unattended Git command cannot commit; `.git` stays read-only.
      await writeFile(join(f.project, 'src/b.ts'), 'export const b = 2;\n');
      const writeSet = realm === 'bubblewrap' && measured.bubblewrap.launcher?.overlay === true;
      for (const [command, path] of [['f=pack; echo x > src/${f}age2.json', 'src/package2.json'], ['n=notes; echo hi > src/${n}.txt', 'src/notes.txt'],
        [`${COMMIT} full-auto-commit`, null]] as const) {
        if (path !== null) {
          const denied = await f.call('run_shell', { command }, 'deny');
          expect(denied).toMatchObject({ card: true, status: 'denied' });
          await expect(access(join(f.project, path))).rejects.toMatchObject({ code: 'ENOENT' });
        }
        // Truncating redirection is destructive in every mode: approve its actual card before asserting containment/settlement.
        const result = await f.call('run_shell', { command }, 'allow');
        expect({ command, card: result.card, status: result.status }).toEqual({ command, card: path !== null, status: path !== null ? 'ok' : 'error' });
        expect(result.text).toContain(!writeSet && path !== null ? `sandbox: ${realm}; exit 0`
          : !writeSet ? 'the project was read-only for this unattended run'
            : path ? `[deckent] write set: not applied: ${path} (denied by policy).` : 'Read-only file system');
      }
      if (writeSet) {
        for (const path of ['src/package2.json', 'src/notes.txt']) await expect(access(join(f.project, path))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        // Accepted no-write-set limit (PLAN SANDBOX-AUTHORITY-FOLLOWUPS): approved writes are direct.
        expect(await readFile(join(f.project, 'src/package2.json'), 'utf8')).toBe('x\n');
        expect(await readFile(join(f.project, 'src/notes.txt'), 'utf8')).toBe('hi\n');
      }
      expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe(realm === 'bubblewrap' ? 'full-access-floor' : 'base');

      // (3) Standart: an owner-approved call (card answered allow) writes the project, a new floor name included.
      await f.writeAuthority([...GRANTS, rule('file-write', 'operation', ['workspace.file.write'], 'allow')], null, 'standart');
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
      expect(approvedForced.card).toBe(realm === 'bubblewrap');
      if (realm === 'landlock') {
        expect(approvedForced.status).toBe('error');
        expect(approvedForced.text).toContain('SHELL_SANDBOX_UNAVAILABLE');
        expect(forced.audit().map(record => record.event.subject).filter(subject => subject['kind'] === 'full-access-call')).toEqual([]);
        // Keep the original write probe, answered allow if a card exists; an unavailable open realm cannot open configuration content.
        const configPath = join(forced.project, '.deckent/config.json'), before = await readFile(configPath, 'utf8');
        const probe = await forced.call('run_shell', { command: 'printf "" >> .deckent/config.json && echo CONFIG_OPEN_RW' }, 'allow', { fullAccess: true });
        expect(probe).toMatchObject({ card: false, status: 'error', text: expect.stringContaining('SHELL_SANDBOX_UNAVAILABLE') });
        expect(probe.text.split('\n')).not.toContain('CONFIG_OPEN_RW');
        expect(await readFile(configPath, 'utf8')).toBe(before);
        return;
      }
      const forcedCard = approvedForced.events.find(event => event.kind === 'approval.requested');
      if (forcedCard?.kind !== 'approval.requested') throw new Error('no card was requested');
      const noCalls = forced.audit().map(record => record.event.subject).filter(subject => subject['kind'] === 'full-access-call');
      expect(noCalls).toHaveLength(0); // owner-approved, never the audited full-access-call authority.
      expect(forcedCard.preview).toContain('the project is writable');
      expect(forcedCard.preview).toContain('.git writable');
      expect(forcedCard.preview).not.toContain('.git read-only');
      // OPEN-SANDBOX: the card of a full-access turn names the open view (bubblewrap) or says it is not available (Landlock, require-sandbox).
      expect(forcedCard.preview).toContain('network on, HOME visible, Deckent state and credentials hidden/read-only');

      // Approve the original O_WRONLY probe (`>>` with zero bytes), then verify the configuration hard floor still prevents opening it.
      const configPath = join(forced.project, '.deckent/config.json');
      const before = await readFile(configPath, 'utf8');
      const probe = await forced.call('run_shell', { command: 'printf "" >> .deckent/config.json && echo CONFIG_OPEN_RW' }, 'allow', { fullAccess: true });
      // W3 hard floor is independent of the card: approving this exact write must still fail to open the configuration.
      expect({ card: probe.card, status: probe.status, open: probe.text.split('\n').includes('CONFIG_OPEN_RW') }).toEqual({ card: true, status: 'error', open: false });
      expect(probe.text).toMatch(/exit [1-9]/u);
      expect(await readFile(configPath, 'utf8')).toBe(before);
    }, 60_000);
  }
});
