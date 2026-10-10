import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeModeRuntimes, modeRuntime, rule, type Mode } from '../support/agent-turn-modes.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

// MODES-3 (owner 2026-09-29) on the real runtime service: a turn launched in full access (`chatTurn.fullAccess`) runs everything without a
// card — open sandbox shell, the destructive table, the write floor, `.git` — only on the company grant `permission-mode`/`set` `full-access`, with a
// sealed `full-access-turn` event before the turn and a `full-access-call` event before every effect. Deny rules hold in every mode; a
// company require-approval that is not mode-eligible still asks; the hard floor (product state, credentials, the configuration write) stays
// closed in every mode. Real policy/bindings files, real host shell and — where available — real bubblewrap.
afterEach(closeModeRuntimes);
const measured = await measureTestShellHost();
const bwrapReady = measured.bubblewrap.status === 'available';
// W3-SANDBOX: full access requires the real open sandbox; host and host fallback refuse before execution.
const SANDBOX = { shell: { schemaVersion: 1, realm: 'require-sandbox' } };
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const TOOLS = [rule('read', 'agent-tool', ['read_file', 'list_dir', 'glob', 'grep'], 'allow'),
  rule('edit-tools', 'agent-tool', ['edit_file', 'write_file'], 'require-approval', true), rule('file-write', 'operation', ['workspace.file.write'], 'allow'),
  rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')];
const DATA = '.deckent/data';
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });
const subjects = (f: Awaited<ReturnType<typeof modeRuntime>>) => f.audit().map(record => record.event.subject);

describe.skipIf(process.platform !== 'linux')('full access through the runtime service (MODES-3)', () => {
  it('refuses explicit host full access before running the unchanged destructive command', async () => {
    const f = await modeRuntime({ shell: { schemaVersion: 1, realm: 'host' }, grants: [...TOOLS, FULL_ACCESS], mode: null });
    const result = await f.call('run_shell', { command: 'rm -rf src' }, 'allow', { fullAccess: true });
    expect(result).toMatchObject({ card: false, status: 'error', text: expect.stringContaining('SHELL_SANDBOX_UNAVAILABLE') });
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(subjects(f).filter(event => event['kind'] === 'full-access-call')).toEqual([]);
  });
  it('refuses a full-access turn without the company grant before anything runs, and records the refusal', async () => {
    const f = await modeRuntime({ ...SANDBOX, grants: TOOLS, mode: { mode: 'full-access' } });
    await expect(f.call('run_shell', { command: 'rm src/a.ts' }, 'deny', { fullAccess: true })).rejects.toMatchObject({ code: 'PERMISSION_MODE_DENIED', params: { mode: 'full-access' } });
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(subjects(f)).toEqual([expect.objectContaining({ kind: 'full-access-turn', decision: { effect: 'deny', ruleId: null } })]);
    expect(f.rows('SELECT * FROM effect_intents')).toEqual([]);
  }, 60_000);

  it('runs the destructive table, the write floor and .git without a card in the open sandbox, auditing the turn and every effect call first', async () => {
    const f = await modeRuntime({ ...SANDBOX, grants: [...TOOLS, FULL_ACCESS], mode: null, dataRoot: DATA });
    git(f.project, 'init', '-q');
    const fa = { fullAccess: true } as const;
    expect(await f.call('run_shell', { command: 'rm -rf src' }, 'deny', fa)).toMatchObject({ card: false, status: 'ok' });
    await expect(access(join(f.project, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.call('write_file', { path: 'package.json', content: '{}\n' }, 'deny', fa)).toMatchObject({ card: false, status: 'ok' });
    expect(await f.call('write_file', { path: '.git/deckent-full-access', content: 'x\n' }, 'deny', fa)).toMatchObject({ card: false, status: 'ok' });
    const head = await f.call('read_file', { path: '.git/HEAD' }, 'deny', fa);
    expect(head).toMatchObject({ card: false, status: 'ok' });
    expect(head.text).toContain('ref: refs/heads/');
    const events = subjects(f);
    expect(events.filter(event => event['kind'] === 'full-access-turn')).toHaveLength(4);
    expect(events.filter(event => event['kind'] === 'full-access-turn').every(event => (event['decision'] as { effect: string }).effect === 'allow')).toBe(true);
    expect(events.filter(event => event['kind'] === 'full-access-call')).toEqual([
      expect.objectContaining({ cell: 'shell-destructive', policy: 'require-approval', raised: false, company: 'shell-tool', grant: 'full-access', summary: expect.objectContaining({ kind: 'shell', head: 'rm -rf src' }) }),
      expect.objectContaining({ cell: 'edit-floor', grant: 'full-access', summary: { kind: 'edit', path: 'package.json' } }),
      expect.objectContaining({ cell: 'edit', grant: 'full-access', summary: { kind: 'edit', path: '.git/deckent-full-access' } })]);
    // The same calls without the launch flag — even with the grant and a stored full-access start mode — are standart: cards and deny paths.
    await f.writeAuthority([...TOOLS, FULL_ACCESS], { mode: 'full-access' }, 'stored');
    await mkdir(join(f.project, 'src')); await writeFile(join(f.project, 'src/a.ts'), 'export const a = 1;\n');
    expect(await f.call('run_shell', { command: 'rm -rf src' })).toMatchObject({ card: true, status: 'denied' });
    expect(await f.call('write_file', { path: 'package.json', content: '{"x":1}\n' })).toMatchObject({ card: true, status: 'denied' });
    expect((await f.call('read_file', { path: '.git/HEAD' })).status).not.toBe('ok');
  }, 120_000);

  it('keeps the hard floor closed in every mode: product state, credentials and the configuration write (card), never a silent run', async () => {
    const f = await modeRuntime({ ...SANDBOX, grants: [...TOOLS, FULL_ACCESS], mode: null, dataRoot: DATA });
    await writeFile(join(f.project, '.env'), 'TOKEN=secret-value\n');
    const config = await readFile(join(f.project, '.deckent/config.json'), 'utf8');
    const modes: readonly [string, Mode | null, boolean][] = [['standart', null, false], ['full-auto', 'full-auto', false], ['full-access', null, true]];
    for (const [label, mode, fullAccess] of modes) {
      await f.writeAuthority([...TOOLS, FULL_ACCESS], mode, label);
      const options = { fullAccess }, policy = await readFile(join(f.project, DATA, 'policy.json'), 'utf8');
      const read = await f.call('read_file', { path: `${DATA}/policy.json` }, 'allow', options);
      expect({ label, card: read.card, ok: read.status === 'ok', leaked: read.text.includes('schemaVersion') }).toEqual({ label, card: false, ok: false, leaked: false });
      const shell = await f.call('run_shell', { command: `cat ${DATA}/policy.json` }, 'allow', options);
      expect({ label, card: shell.card }).toEqual({ label, card: false });
      expect(shell.text).toContain('PRODUCT_STATE_PROTECTED');
      const written = await f.call('write_file', { path: `${DATA}/policy.json`, content: '{}' }, 'allow', options);
      expect({ label, card: written.card, ok: written.status === 'ok' }).toEqual({ label, card: false, ok: false });
      expect(await readFile(join(f.project, DATA, 'policy.json'), 'utf8')).toBe(policy);
      const secret = await f.call('read_file', { path: '.env' }, 'allow', options);
      expect({ label, ok: secret.status === 'ok', leaked: secret.text.includes('secret-value') }).toEqual({ label, ok: false, leaked: false });
      // The configuration decides where policy and approvals live: a write asks the owner in every mode (answered deny here).
      expect({ label, ...(await f.call('write_file', { path: '.deckent/config.json', content: '{}' }, 'deny', options)) }).toMatchObject({ label, card: true, status: 'denied' });
    }
    expect(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).toBe(config);
  }, 180_000);

  it('never lowers a deny, and a company require-approval that is not mode-eligible still asks in full access (the Enterprise lever)', async () => {
    const denied = [rule('edit-tools', 'agent-tool', ['edit_file', 'write_file'], 'deny'), rule('file-write', 'operation', ['workspace.file.write'], 'allow'),
      rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval'), rule('shell-run', 'operation', ['host.shell.run'], 'allow'), FULL_ACCESS];
    const f = await modeRuntime({ ...SANDBOX, grants: denied, mode: { mode: 'full-access' } });
    expect(await f.call('write_file', { path: 'src/b.ts', content: 'x' }, 'allow', { fullAccess: true })).toMatchObject({ card: false, status: 'denied' });
    expect(await f.call('run_shell', { command: 'touch made.txt' }, 'deny', { fullAccess: true })).toMatchObject({ card: true, status: 'denied' });
    await expect(access(join(f.project, 'src/b.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(f.project, 'made.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(subjects(f).filter(event => event['kind'] === 'full-access-call')).toEqual([]);
  }, 60_000);

  it('runs nothing when the full-access call cannot be audited, and refuses the turn when its admission cannot be recorded', async () => {
    const f = await modeRuntime({ ...SANDBOX, grants: [...TOOLS, FULL_ACCESS], mode: null });
    f.exec("CREATE TRIGGER audit_refuses BEFORE INSERT ON audit_events WHEN NEW.kind = 'full-access-call' BEGIN SELECT RAISE(ABORT,'unavailable'); END;");
    const refused = await f.call('run_shell', { command: 'rm src/a.ts' }, 'deny', { fullAccess: true });
    expect(refused).toMatchObject({ card: false, status: 'error' });
    expect(refused.text).toContain('audit-unavailable');
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    f.exec('DROP TRIGGER audit_refuses');
    f.exec("CREATE TRIGGER audit_refuses BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'unavailable'); END;");
    await expect(f.call('run_shell', { command: 'rm src/a.ts' }, 'deny', { fullAccess: true })).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  }, 60_000);

  it.skipIf(!bwrapReady)('inside bubblewrap full access commits to .git, while the product state stays unreadable even by an expanded name', async () => {
    const f = await modeRuntime({ shell: { schemaVersion: 1, realm: 'require-sandbox' }, grants: [...TOOLS, FULL_ACCESS], mode: null, dataRoot: DATA });
    await writeFile(join(f.project, '.gitignore'), '.deckent/\n');
    git(f.project, 'init', '-q'); git(f.project, 'add', '-A'); git(f.project, 'commit', '-qm', 'base');
    await mkdir(join(f.project, 'src', 'new'), { recursive: true });
    await writeFile(join(f.project, 'src/new/b.ts'), 'export const b = 2;\n');
    const commit = await f.call('run_shell', { command: 'git add -A src && git -c user.name=agent -c user.email=agent@example.invalid commit -qm full-access-commit && git log --oneline -1' },
      'deny', { fullAccess: true });
    expect(commit).toMatchObject({ card: false, status: 'ok' });
    expect(commit.text).toMatch(/^\[deckent\] run_shell: sandbox: bubblewrap; exit 0/u);
    expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe('full-access-commit');
    // A name the classifier cannot see (expansion) still meets the realm's mask: nothing of the product state is readable.
    const peek = await f.call('run_shell', { command: `cat "$(printf .deck)ent/data/policy.json"` }, 'deny', { fullAccess: true });
    expect(peek.card).toBe(false);
    expect(peek.text).toMatch(/sandbox: bubblewrap; exit [1-9]/u);
    expect(peek.text).not.toContain('schemaVersion');
    // The configuration file stays read-only in the realm for a call the owner did not approve.
    const config = await readFile(join(f.project, '.deckent/config.json'), 'utf8');
    const overwrite = await f.call('run_shell', { command: 'echo {} > "$(printf .deck)ent/config.json"' }, 'deny', { fullAccess: true });
    expect(overwrite.text).toMatch(/exit [1-9]/u);
    expect(await readFile(join(f.project, '.deckent/config.json'), 'utf8')).toBe(config);
    // Without the launch flag (full-auto), `.git` is masked inside the sandbox and the same commit does not land.
    await f.writeAuthority([...TOOLS, FULL_ACCESS], 'full-auto', 'auto');
    await writeFile(join(f.project, 'src/new/c.ts'), 'export const c = 3;\n');
    const blocked = await f.call('run_shell', { command: 'git add -A src && git -c user.name=agent -c user.email=agent@example.invalid commit -qm second' }, 'deny');
    expect(blocked.status).not.toBe('ok');
    expect(git(f.project, 'log', '--format=%s', '-1').trim()).toBe('full-access-commit');
  }, 180_000);
});
