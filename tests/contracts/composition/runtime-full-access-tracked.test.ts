import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';
import { agentTurnStreamEventSchema } from '#domain/index.js';
import { trackedChangesOfToolResult } from '#surfaces/core/terminal-kit/index.js';

// FA-TRACKED-WARN (owner 2026-09-30, option A) on the real runtime service: a full-access shell call runs without asking (MODES-3 stays), but
// a git-tracked file it deleted or overwrote is shown — streamed, in the result the model reads, and as trusted leading metadata of that
// result that the finished tool line reads (protocol v18 carries no typed field: lead decision, bundle_v19) — and sealed as a `tracked-files-changed` audit event after the effect. Never a block, never a card. Standart and full-auto
// are unchanged. Trigger: the live agent ran `rm CHANGELOG.md` in full access (2026-09-30T12:27Z) and nobody noticed.
afterEach(closeModeRuntimes);
const bwrapReady = (await measureTestShellHost()).bubblewrap.status === 'available';
// W3-SANDBOX: the admitted full-access shell realm is the open sandbox; host execution is refused.
const SANDBOX = { shell: { schemaVersion: 1, realm: 'require-sandbox' } };
const FULL_ACCESS = rule('full-access', 'permission-mode', ['full-access'], 'allow', false, ['set']);
const TOOLS = [rule('read', 'agent-tool', ['read_file', 'list_dir', 'glob', 'grep'], 'allow'),
  rule('edit-tools', 'agent-tool', ['edit_file', 'write_file'], 'require-approval', true), rule('file-write', 'operation', ['workspace.file.write'], 'allow'),
  rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8' });
const fa = { fullAccess: true } as const;
type Runtime = Awaited<ReturnType<typeof modeRuntime>>;
async function tracked(input: { shell?: Record<string, unknown>; mode?: Parameters<typeof modeRuntime>[0]['mode'] } = {}) {
  const f = await modeRuntime({ ...(input.shell ? { shell: input.shell } : SANDBOX), grants: [...TOOLS, FULL_ACCESS], mode: input.mode ?? null });
  await writeFile(join(f.project, '.gitignore'), '.deckent/\n');
  await writeFile(join(f.project, 'CHANGELOG.md'), '# Changelog\n');
  git(f.project, 'init', '-q'); git(f.project, 'add', '-A'); git(f.project, 'commit', '-qm', 'base');
  return f;
}
const finished = (call: Awaited<ReturnType<Runtime['call']>>) => call.events.find(event => event.kind === 'tool.finished');
/** What the finished tool line shows: the counts from the result's trusted first line (v18 frames carry no typed field). */
const card = (call: Awaited<ReturnType<Runtime['call']>>) => trackedChangesOfToolResult('run_shell', call.text);
/** Every event of the call parses under the released v18 event schema and no finish carries `trackedChanges` (lead decision, bundle_v19). */
const v18Only = (call: Awaited<ReturnType<Runtime['call']>>) => {
  for (const event of call.events) expect(agentTurnStreamEventSchema.safeParse(event).success).toBe(true);
  expect(finished(call)).not.toHaveProperty('trackedChanges');
};
const streamed = (call: Awaited<ReturnType<Runtime['call']>>) => call.events.flatMap(event => event.kind === 'tool.output' ? [event.text] : []).join('');
const trackedEvents = (f: Runtime) => f.audit().filter(record => record.event.subject['kind'] === 'tracked-files-changed').map(record => record.event);

describe.skipIf(process.platform !== 'linux')('full access: tracked-file warning and audit (FA-TRACKED-WARN)', () => {
  it('deletes a tracked file without a card, then shows, streams, types and audits the deletion', async () => {
    const f = await tracked();
    const call = await f.call('run_shell', { command: 'rm CHANGELOG.md' }, 'deny', fa);
    expect(call).toMatchObject({ card: false, status: 'ok' });
    await expect(access(join(f.project, 'CHANGELOG.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const line = '[deckent] tracked files changed: deleted 1 (CHANGELOG.md), overwritten 0 — during this full-access call; nothing was blocked.';
    expect(call.text.split('\n').at(-1)).toBe(line);
    expect(streamed(call)).toContain(`${line}\n`);
    expect(finished(call)).toMatchObject({ kind: 'tool.finished', status: 'ok' });
    v18Only(call);
    expect(call.text.startsWith('[deckent] run_shell: tracked: deleted=1 overwritten=0; sandbox: bubblewrap; exit 0 after ')).toBe(true);
    expect(card(call)).toEqual({ deleted: 1, overwritten: 0 });
    const [event, ...more] = trackedEvents(f);
    expect(more).toEqual([]);
    expect(event!.subject).toEqual({ kind: 'tracked-files-changed', tool: { name: 'run_shell', version: 1 }, call: expect.objectContaining({ turnId: call.turnId }),
      summary: expect.objectContaining({ kind: 'shell', head: 'rm CHANGELOG.md' }), deleted: { count: 1, paths: ['CHANGELOG.md'] }, overwritten: { count: 0, paths: [] } });
    // The same call as its `full-access-call` event (sealed before the effect) and the same policy revision.
    const callEvent = f.audit().map(record => record.event).find(item => item.subject['kind'] === 'full-access-call')!;
    expect(event!.subject.call).toEqual(callEvent.subject.call);
    expect(event!.policyRevision).toBe(callEvent.policyRevision);
  }, 60_000);

  it('lists an overwritten tracked file; an untracked delete adds nothing', async () => {
    const f = await tracked();
    const over = await f.call('run_shell', { command: 'echo changed > src/a.ts' }, 'deny', fa);
    expect(over.text).toContain('[deckent] tracked files changed: deleted 0, overwritten 1 (src/a.ts)');
    v18Only(over);
    expect(card(over)).toEqual({ deleted: 0, overwritten: 1 });
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('changed\n');
    await writeFile(join(f.project, 'notes.txt'), 'untracked\n');
    const untracked = await f.call('run_shell', { command: 'rm notes.txt' }, 'deny', fa);
    expect(untracked).toMatchObject({ card: false, status: 'ok' });
    expect(untracked.text).not.toContain('tracked files');
    v18Only(untracked);
    expect(card(untracked)).toBeNull();
    expect(trackedEvents(f).map(event => event.subject['overwritten'])).toEqual([{ count: 1, paths: ['src/a.ts'] }]);
  }, 60_000);

  it('is a no-op for a project outside git', async () => {
    const f = await modeRuntime({ ...SANDBOX, grants: [...TOOLS, FULL_ACCESS], mode: null });
    const call = await f.call('run_shell', { command: 'rm src/a.ts' }, 'deny', fa);
    expect(call).toMatchObject({ card: false, status: 'ok' });
    expect(call.text).not.toContain('tracked files');
    v18Only(call);
    expect(card(call)).toBeNull();
    expect(trackedEvents(f)).toEqual([]);
  }, 60_000);

  it('names at most eight paths in the line but counts them all, and the audit event keeps the paths', async () => {
    const f = await tracked();
    const names = Array.from({ length: 11 }, (_, index) => `docs/n${String(index).padStart(2, '0')}.md`);
    execFileSync('mkdir', ['-p', join(f.project, 'docs')]);
    for (const name of names) await writeFile(join(f.project, name), `${name}\n`);
    git(f.project, 'add', '-A'); git(f.project, 'commit', '-qm', 'docs');
    const call = await f.call('run_shell', { command: 'rm -r docs' }, 'deny', fa);
    expect(call.text).toContain(`deleted 11 (${names.slice(0, 8).join(', ')}, … +3 more), overwritten 0`);
    expect(card(call)).toEqual({ deleted: 11, overwritten: 0 });
    expect(trackedEvents(f)[0]!.subject['deleted']).toEqual({ count: 11, paths: names });
  }, 60_000);

  it('still shows the change when its audit record cannot be written: the command is not undone, never blocked', async () => {
    const f = await tracked();
    f.exec("CREATE TRIGGER tracked_refused BEFORE INSERT ON audit_events WHEN NEW.kind = 'tracked-files-changed' BEGIN SELECT RAISE(ABORT,'unavailable'); END;");
    const call = await f.call('run_shell', { command: 'rm CHANGELOG.md' }, 'deny', fa);
    expect(call).toMatchObject({ card: false, status: 'ok' });
    expect(call.text).toContain('deleted 1 (CHANGELOG.md), overwritten 0 — during this full-access call; nothing was blocked; the audit record of this could not be written.');
    expect(card(call)).toEqual({ deleted: 1, overwritten: 0 });
    await expect(access(join(f.project, 'CHANGELOG.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('measures a call that timed out after deleting (the stopped-run path)', async () => {
    const f = await tracked({ shell: { schemaVersion: 1, realm: 'require-sandbox', timeoutMs: 1_000 } });
    const call = await f.call('run_shell', { command: 'rm CHANGELOG.md && sleep 20' }, 'deny', fa);
    expect(call.status).toBe('error');
    expect(call.text).toContain('[deckent] tracked files changed: deleted 1 (CHANGELOG.md), overwritten 0');
    v18Only(call);
    expect(card(call)).toEqual({ deleted: 1, overwritten: 0 });
    expect(trackedEvents(f)).toHaveLength(1);
  }, 60_000);

  it.skipIf(!bwrapReady)('measures the open bubblewrap view the same way (the live default realm): the delete lands and is shown and audited', async () => {
    const f = await tracked({ shell: { schemaVersion: 1, realm: 'require-sandbox' } });
    const call = await f.call('run_shell', { command: 'rm CHANGELOG.md' }, 'deny', fa);
    expect(call).toMatchObject({ card: false, status: 'ok' });
    expect(call.text).toMatch(/^\[deckent\] run_shell: tracked: deleted=1 overwritten=0; sandbox: bubblewrap; exit 0/u);
    expect(call.text).toContain('[deckent] tracked files changed: deleted 1 (CHANGELOG.md), overwritten 0');
    await expect(access(join(f.project, 'CHANGELOG.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(trackedEvents(f)).toHaveLength(1);
  }, 60_000);

  it('leaves standart unchanged: an owner-approved delete carries no tracked-file line, field or event', async () => {
    const f = await tracked();
    const call = await f.call('run_shell', { command: 'rm CHANGELOG.md' }, 'allow');
    expect(call).toMatchObject({ card: true, status: 'ok' });
    await expect(access(join(f.project, 'CHANGELOG.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(call.text).not.toContain('tracked files');
    v18Only(call);
    expect(card(call)).toBeNull();
    expect(trackedEvents(f)).toEqual([]);
  }, 60_000);

  it('leaves full-auto unchanged: its own review path, no tracked-file line or event', async () => {
    const f = await tracked({ mode: 'full-auto' });
    const call = await f.call('run_shell', { command: 'rm CHANGELOG.md' }, 'deny');
    expect(call.text).not.toContain('tracked files');
    v18Only(call);
    expect(card(call)).toBeNull();
    expect(trackedEvents(f)).toEqual([]);
  }, 60_000);
});
