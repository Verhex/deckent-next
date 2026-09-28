import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { landlockShellSandbox, probeShellCapabilities, type ShellSandboxFactory } from '#adapters/index.js';
import { STANDING_GRANT_KIND } from '#domain/index.js';
import { closeModeRuntimes, modeRuntime, rule, type Mode } from '../support/agent-turn-modes.js';

// SHELL-AUTONOMY (owner 2026-09-28 live test, session ffc7277c): in full-auto, a command the classifier cannot bound (compound, variable
// or command expansion, a path outside the project) runs without a card only inside a real sandbox realm — bubblewrap or enforced
// Landlock — where the realm draws the boundary. Host, a `prefer-sandbox` host fallback and degraded Landlock keep asking; ask and
// auto-edit are unchanged; the destructive table asks in every mode; the write floor and the product state never go silent.
// Real runtime service, real policy/bindings files, real bwrap and the real Landlock helper (forced as the only provider).
afterEach(closeModeRuntimes);
const measured = await probeShellCapabilities();
const bwrapReady = measured.bubblewrap === 'available' && measured.userNamespace === 'available';
const landlockAbi = measured.landlock.status === 'available' ? measured.landlock.abi ?? 0 : 0;
const landlockAt = (abi: number): ShellSandboxFactory => layout => [{ kind: 'landlock', usable: () => landlockShellSandbox(layout).usable({ platform: 'linux',
  bubblewrap: 'unavailable', userNamespace: 'available', landlock: { status: 'available', abi } }) }];
const sandboxed = { schemaVersion: 1, realm: 'require-sandbox' };
const REALMS = {
  bubblewrap: { shell: sandboxed },
  landlock: { shell: sandboxed, sandboxes: landlockAt(landlockAbi) },
  degraded: { shell: sandboxed, sandboxes: landlockAt(5) },
  host: { shell: { schemaVersion: 1, realm: 'host' } },
  fallback: { shell: { schemaVersion: 1, realm: 'prefer-sandbox' }, sandboxes: (() => []) as ShellSandboxFactory },
} as const;
/** The live policy's shape: `run_shell` require-approval marked mode-eligible, `host.shell.run` allowed. */
const LIVE = [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')];
/** The owner's exact commands from the live session. */
const OWNER_UNBOUNDED = ['touch /tmp/deckent-policy-test-$$ && ls -la /tmp/deckent-policy-test-$$', 'echo "policy test $(date +%H:%M:%S)"',
  'echo "full-auto otonom test: run_shell otomatik mi?" && date && whoami',
  'touch /tmp/full-auto-test && echo "full-auto aktif mi? test dosyası oluştu: $(ls /tmp/full-auto-test)"'];
const OWNER_DESTRUCTIVE = ['rm -f /tmp/deckent-policy-test-mode', 'rm -f auto-edit-test.txt && echo "silindi"'];

async function matrix(realm: keyof typeof REALMS, mode: Mode, commands: readonly string[]) {
  const f = await modeRuntime({ grants: LIVE, mode, ...REALMS[realm] });
  const results = [];
  for (const command of commands) results.push({ command, ...(await f.call('run_shell', { command })) });
  return { f, results };
}

describe.skipIf(process.platform !== 'linux')('full-auto shell autonomy inside a real sandbox (SHELL-AUTONOMY)', () => {
  it.skipIf(!bwrapReady)('bubblewrap: the owner\'s compound and expanding commands run without a card; rm -f still asks; each relaxation is audited', async () => {
    const leak = `/tmp/deckent-autonomy-${randomUUID()}`;
    const { f, results } = await matrix('bubblewrap', 'full-auto', [...OWNER_UNBOUNDED, `touch ${leak} && ls ${leak}`, ...OWNER_DESTRUCTIVE]);
    for (const result of results.slice(0, 5)) {
      expect(result).toMatchObject({ card: false, status: 'ok' });
      expect(result.text).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; exit 0/u);
    }
    // `/tmp` is the sandbox's own tmpfs: the file the command made is not on the host.
    await expect(access(leak)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const result of results.slice(5)) expect(result).toMatchObject({ card: true, status: 'denied' });
    const events = f.audit().map(record => record.event.subject);
    expect(events).toHaveLength(5);
    for (const event of events) expect(event).toMatchObject({ kind: 'permission-mode', mode: 'full-auto', cell: 'shell-modify', grants: { company: 'shell-tool', person: 'me-mode' } });
  }, 120_000);

  it.skipIf(landlockAbi < 6)('enforced Landlock: the same commands run without a card (the realm refuses /tmp writes itself); rm -f asks', async () => {
    const { f, results } = await matrix('landlock', 'full-auto', [...OWNER_UNBOUNDED, ...OWNER_DESTRUCTIVE]);
    for (const result of results.slice(0, 4)) {
      expect(result.card).toBe(false);
      expect(result.text).toMatch(/^\[deckent\] run_shell: sandbox: landlock; exit /u);
    }
    // Outside the project and the scratch area the Landlock realm refuses the write: the command ran, the realm drew the line.
    expect(results[0]!.status).toBe('error');
    expect(results.slice(1, 3).map(result => result.status)).toEqual(['ok', 'ok']);
    for (const result of results.slice(4)) expect(result).toMatchObject({ card: true, status: 'denied' });
    expect(f.audit()).toHaveLength(4);
  }, 120_000);

  it('host, a prefer-sandbox host fallback and degraded Landlock keep asking for every one of them in full-auto', async () => {
    for (const realm of ['host', 'fallback', ...(landlockAbi >= 1 ? ['degraded' as const] : [])] as const) {
      const { f, results } = await matrix(realm, 'full-auto', [...OWNER_UNBOUNDED, ...OWNER_DESTRUCTIVE]);
      for (const result of results) expect({ realm, ...result }).toMatchObject({ realm, card: true, status: 'denied' });
      expect(f.audit()).toEqual([]);
    }
  }, 180_000);

  it.skipIf(!bwrapReady)('ask and auto-edit are unchanged inside bubblewrap: every one of them asks', async () => {
    for (const mode of ['ask', 'auto-edit'] as const) {
      const { f, results } = await matrix('bubblewrap', mode, [...OWNER_UNBOUNDED, ...OWNER_DESTRUCTIVE]);
      for (const result of results) expect({ mode, ...result }).toMatchObject({ mode, card: true, status: 'denied' });
      expect(f.audit()).toEqual([]);
    }
  }, 120_000);

  for (const realm of ['bubblewrap', 'landlock'] as const) {
    it.skipIf(realm === 'bubblewrap' ? !bwrapReady : landlockAbi < 6)(`${realm}: the write floor never goes silent — a named floor path asks, a hidden one meets a read-only floor, an approved one writes`, async () => {
      const f = await modeRuntime({ grants: LIVE, mode: 'full-auto', ...REALMS[realm] });
      const manifest = join(f.project, 'package.json'), config = join(f.project, '.deckent/config.json');
      await writeFile(manifest, '{"name":"floor"}\n');
      const configured = await readFile(config, 'utf8');
      expect(await f.call('run_shell', { command: 'echo x >> package.json && echo done' })).toMatchObject({ card: true, status: 'denied' });
      expect(await f.call('run_shell', { command: 'cd src && echo x >> ../package.json' })).toMatchObject({ card: true, status: 'denied' });
      expect(await f.call('run_shell', { command: 'mkdir -p .github/workflows && echo x > .github/workflows/ci.yml' })).toMatchObject({ card: true, status: 'denied' });
      // Past the classifier (the name is built at run time): the call runs without a card and the realm keeps the floor read-only.
      const hidden = await f.call('run_shell', { command: 'f=pack; echo x >> ${f}age.json; echo "manifest=$?"; d=.deck; echo x >> ${d}ent/config.json; echo "config=$?"' });
      expect(hidden.card).toBe(false);
      expect(hidden.text).toContain('manifest=1'); expect(hidden.text).toContain('config=1');
      expect(await readFile(manifest, 'utf8')).toBe('{"name":"floor"}\n');
      expect(await readFile(config, 'utf8')).toBe(configured);
      // The floor means "the owner approves", not "never": an approved call still writes it.
      expect(await f.call('run_shell', { command: 'echo \'{"name":"approved"}\' > package.json' }, 'allow')).toMatchObject({ card: true, status: 'ok' });
      expect(await readFile(manifest, 'utf8')).toBe('{"name":"approved"}\n');
    }, 120_000);
  }

  it.skipIf(!bwrapReady)('the product state is refused in the plan without a card in full-auto, and a hidden reach to it asks', async () => {
    const f = await modeRuntime({ grants: LIVE, mode: 'full-auto', ...REALMS.bubblewrap, dataRoot: '.cache/deckent' });
    const literal = await f.call('run_shell', { command: 'ls && cat .cache/deckent/state/ledger.db' });
    expect(literal.card).toBe(false);
    expect(literal.text).toMatch(/^\[deckent\] run_shell: error=PRODUCT_STATE_PROTECTED \(\.cache\/deckent\/state\/ledger\.db\)/u);
    expect(await f.call('run_shell', { command: 'echo "$(cat .cache/deckent/state/ledger.db)"' })).toMatchObject({ card: true, status: 'denied' });
    // Program floor: an interpreter, a package manager and a network tool still ask inside the sandbox (checkpoint C1).
    for (const command of ['echo "$(python3 -c 1)"', 'npm test && echo ok', 'curl -s http://127.0.0.1:9/ || true']) {
      expect({ command, ...(await f.call('run_shell', { command })) }).toMatchObject({ command, card: true, status: 'denied' });
    }
  }, 120_000);

  // The owner's layout: the data root inside the write floor (`.deckent/live-data`), so the floor's read-only bind/rule and the deny masks
  // of the product state beneath it stack on one tree.
  for (const realm of ['bubblewrap', 'landlock'] as const) {
    it.skipIf(realm === 'bubblewrap' ? !bwrapReady : landlockAbi < 6)(`${realm}: with the data root inside .deckent, the product state stays refused and a compound still runs`, async () => {
      const f = await modeRuntime({ grants: LIVE, mode: 'full-auto', ...REALMS[realm], dataRoot: '.deckent/live-data' });
      const literal = await f.call('run_shell', { command: 'ls && cat .deckent/live-data/state/ledger.db' });
      expect(literal.card).toBe(false);
      expect(literal.text).toMatch(/^\[deckent\] run_shell: error=PRODUCT_STATE_PROTECTED/u);
      const benign = await f.call('run_shell', { command: 'echo "x $(date +%s)" && ls src' });
      expect(benign).toMatchObject({ card: false, status: 'ok' });
      expect(benign.text).toMatch(new RegExp(`^\\[deckent\\] run_shell: sandbox: ${realm}; exit 0`, 'u'));
      const config = join(f.project, '.deckent/config.json'), before = await readFile(config, 'utf8');
      const hidden = await f.call('run_shell', { command: 'd=.deck; echo x >> ${d}ent/config.json; echo "config=$?"; s=.deckent/live-data/sta; cat ${s}te/ledger.db > /dev/null; echo "ledger=$?"' });
      expect(hidden.card).toBe(false);
      expect(hidden.text).toContain('config=1'); expect(hidden.text).toContain('ledger=1');
      expect(await readFile(config, 'utf8')).toBe(before);
    }, 120_000);
  }

  // Merge with PERSISTENT-APPROVALS (lead 2026-09-29): a call a standing approval lowered was not approved by the owner either, so the realm
  // keeps the write floor read-only for it, as for a mode relaxation; an owner-approved call sees the floor writable.
  it.skipIf(!bwrapReady)('bubblewrap: a standing-approved call sees the write floor read-only, an owner-approved one writable; the audit names the standing path', async () => {
    const standingCommand = 'find . -maxdepth 1 -name package.json -writable', approvedCommand = 'find . -maxdepth 1 -writable -name package.json';
    const f = await modeRuntime({ grants: [...LIVE, rule('standing-1', STANDING_GRANT_KIND, [`v1:run_shell:command:${standingCommand}`], 'allow')], mode: 'ask', ...REALMS.bubblewrap });
    await writeFile(join(f.project, 'package.json'), '{}\n');
    const standing = await f.call('run_shell', { command: standingCommand });
    expect(standing).toMatchObject({ card: false, status: 'ok' });
    expect(standing.text).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; exit 0/u);
    expect(standing.text).not.toContain('./package.json');
    const approved = await f.call('run_shell', { command: approvedCommand }, 'allow');
    expect(approved).toMatchObject({ card: true, status: 'ok' });
    expect(approved.text).toContain('./package.json');
    expect(f.audit().map(record => record.event.subject)).toEqual([expect.objectContaining({ kind: 'standing-approval', phase: 'used', source: 'grant', grantId: 'standing-1' })]);
  }, 120_000);

  // Astra 2170 R1: a name the classifier cannot see (built at run time) must not create a write-floor path without a card. A full-auto sandbox
  // relaxation runs with the whole project read-only (only the scratch area and bubblewrap's private /tmp stay writable): a boundary, not a
  // list of names. The narrow set keeps writing (its literal targets pass the write check); an owner-approved call writes the floor.
  for (const realm of ['bubblewrap', 'landlock'] as const) {
    it.skipIf(realm === 'bubblewrap' ? !bwrapReady : landlockAbi < 6)(`${realm}: no new floor path (or any project file) appears from an unattended unbounded run; the narrow set still writes`, async () => {
      const f = await modeRuntime({ grants: LIVE, mode: 'full-auto', ...REALMS[realm] });
      const created = ['src/package.json', '.github/workflows/x.yml', 'Makefile', 'sub/Dockerfile', 'notes.txt'];
      for (const command of ['f=pack; echo X > src/${f}age.json', 'd=.git; mkdir -p ${d}hub/workflows && echo x > ${d}hub/workflows/x.yml', 'm=Make; echo x > ${m}file',
        'mkdir -p sub && d=Docker; echo x > sub/${d}file', 'echo hi > notes.txt && cat notes.txt']) {
        const result = await f.call('run_shell', { command });
        expect({ command, card: result.card, status: result.status }).toEqual({ command, card: false, status: 'error' });
        expect(result.text).toContain('the project was read-only for this unattended run');
      }
      for (const path of created) await expect(access(join(f.project, path))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(f.project, 'sub'))).rejects.toMatchObject({ code: 'ENOENT' });
      // Reading and writing outside the project stay silent and work; the narrow set writes the project as before.
      expect(await f.call('run_shell', { command: 'cat src/a.ts && echo "$(date +%s)" > "$TMPDIR/stamp" 2>/dev/null; ls src' })).toMatchObject({ card: false });
      // (`src/`: the Landlock realm's project root cannot gain entries — its carve, unchanged by this slice.)
      expect(await f.call('run_shell', { command: 'cp src/a.ts src/out.ts' })).toMatchObject({ card: false, status: 'ok' });
      expect(await readFile(join(f.project, 'src/out.ts'), 'utf8')).toBe('export const a = 1;\n');
    }, 120_000);
  }

  it.skipIf(!bwrapReady)('bubblewrap: an owner-approved compound command still writes a new floor path', async () => {
    const f = await modeRuntime({ grants: LIVE, mode: 'ask', ...REALMS.bubblewrap });
    expect(await f.call('run_shell', { command: 'f=pack; echo \'{}\' > src/${f}age.json' }, 'allow')).toMatchObject({ card: true, status: 'ok' });
    expect(await readFile(join(f.project, 'src/package.json'), 'utf8')).toBe('{}\n');
  }, 60_000);
});
