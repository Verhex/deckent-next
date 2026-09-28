import { lstat, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTurnStreamEvent } from '#domain/index.js';
import { scratchSessionKey } from '#adapters/index.js';
import { me, principal, runtime } from '../support/chat-turn-harness.js';

// SCR-A (owner 2026-09-28): the agent's scratch area through the real runtime service, real policy file and real ledger.
const scratchGrants = (toolEffect: 'allow' | 'require-approval', operationEffect: 'allow' | 'require-approval' = 'allow') => [
  { id: 'scratch-tools', effect: toolEffect, actions: ['invoke'], scopes: ['scope'], principals: me,
    resource: { kind: 'agent-tool', ids: ['scratch_write', 'scratch_read', 'scratch_list'] } },
  { id: 'scratch-write', effect: operationEffect, actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['workspace.scratch.write'] } },
  { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } }];
const sessionKey = (sessionId: string | undefined, turnId: string) =>
  scratchSessionKey({ scopeId: 'scope', principal: { issuer: principal.issuer, subject: principal.subject }, turnId, ...(sessionId ? { sessionId } : {}) });
const scratchRoot = (data: string) => join(data, 'state', 'scratch');
const toolTexts = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);
const finished = (events: AgentTurnStreamEvent[]) => events.filter(event => event.kind === 'tool.finished');
const turn = (turnId: string, sessionId?: string, content = 'take notes') =>
  ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content }], ...(sessionId ? { sessionId } : {}) });
const call = (name: string, args: Record<string, unknown>) => ({ toolCall: { name, arguments: JSON.stringify(args) } });

describe.skipIf(process.platform !== 'linux')('agent scratch area through the runtime service (SCR-A S1–S2)', () => {
  it('writes and reads the session scratch area without asking when policy allows it: 0600 files in 0700 directories, one scratch-file effect', async () => {
    const f = await runtime({ extraGrants: scratchGrants('allow') }); await f.start();
    f.state.script = [call('scratch_write', { path: 'notes/plan.md', content: '# plan\nstep one\n' }), call('scratch_read', { path: 'notes/plan.md' }),
      call('scratch_list', {}), { content: 'Noted.' }];
    const events: AgentTurnStreamEvent[] = [];
    const result = await f.client().chatTurn(turn('turn-scratch', 'session-1'), event => events.push(event));
    expect(result).toMatchObject({ finish: 'stop', toolCalls: 3 });
    expect(events.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(finished(events).map(event => event.kind === 'tool.finished' && [event.name, event.status])).toEqual([['scratch_write', 'ok'], ['scratch_read', 'ok'],
      ['scratch_list', 'ok']]);
    const key = sessionKey('session-1', 'turn-scratch'), dir = join(scratchRoot(f.data), key);
    expect(await readFile(join(dir, 'notes', 'plan.md'), 'utf8')).toBe('# plan\nstep one\n');
    expect((await stat(join(dir, 'notes', 'plan.md'))).mode & 0o777).toBe(0o600);
    for (const directory of [dir, join(dir, 'notes'), join(scratchRoot(f.data), key.split('/')[0]!)]) expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const [written, read, listed] = toolTexts(events);
    expect(written).toContain(join(dir, 'notes', 'plan.md')); expect(read).toContain('step one'); expect(listed).toContain('notes/');
    // The write is a C11 effect of the Core scratch operation on a target id unique to this session (never the project's `workspace-file`).
    expect(f.rows('SELECT target_kind, target_id, state FROM effect_intents')).toEqual([{ target_kind: 'scratch-file', target_id: `${key}/notes/plan.md`, state: 'settled' }]);
    // The model was told where the area is (system prompt v2) and which tools work there.
    const system = (f.state.requests[0]!['messages'] as { role: string; content: string }[])[0]!.content;
    expect(system.startsWith('[Deckent runtime instructions v3]')).toBe(true);
    expect(system).toContain(`Scratch area: ${dir}`); expect(system).toContain('Edit tools: edit_file, write_file, scratch_write');
    // Nothing reached the project.
    await expect(lstat(join(f.project, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('keeps one area per terminal session across turns, and a turn without a session gets its own area', async () => {
    const f = await runtime({ extraGrants: scratchGrants('allow') }); await f.start();
    f.state.script = [call('scratch_write', { path: 'a.txt', content: 'first\n' }), { content: 'One.' }, call('scratch_read', { path: 'a.txt' }), { content: 'Two.' },
      call('scratch_read', { path: 'a.txt' }), { content: 'Three.' }];
    const first: AgentTurnStreamEvent[] = [], second: AgentTurnStreamEvent[] = [], bare: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(turn('turn-a', 'session-2'), event => first.push(event));
    await f.client().chatTurn(turn('turn-b', 'session-2'), event => second.push(event));
    await f.client().chatTurn(turn('turn-c'), event => bare.push(event));
    expect(toolTexts(second)[0]).toContain('first');
    expect(toolTexts(bare)[0]).toMatch(/not-found/u);
    expect(sessionKey(undefined, 'turn-c')).not.toBe(sessionKey('session-2', 'turn-c'));
  }, 60_000);

  it('asks the owner for a scratch write when policy requires approval and writes it once on allow; without any grant it is denied', async () => {
    const f = await runtime({ extraGrants: scratchGrants('require-approval') }); await f.start();
    f.state.script = [call('scratch_write', { path: 'draft.md', content: 'draft\n' }), { content: 'Asked.' }];
    const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [];
    await client.chatTurn(turn('turn-ask', 'session-3'), event => {
      events.push(event);
      if (event.kind === 'approval.requested') pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId,
        commandId: 'allow-scratch', expectedRevision: event.revision, decision: 'allow', reason: 'Fine' }));
    });
    await Promise.all(pending);
    expect(events.filter(event => event.kind === 'approval.requested')).toHaveLength(1);
    expect(finished(events)[0]).toMatchObject({ name: 'scratch_write', status: 'ok' });
    expect(await readFile(join(scratchRoot(f.data), sessionKey('session-3', 'turn-ask'), 'draft.md'), 'utf8')).toBe('draft\n');

    const g = await runtime(); await g.start();
    g.state.script = [call('scratch_write', { path: 'draft.md', content: 'draft\n' }), { content: 'Denied.' }];
    const denied: AgentTurnStreamEvent[] = [];
    await g.client().chatTurn(turn('turn-deny', 'session-3'), event => denied.push(event));
    expect(finished(denied)[0]).toMatchObject({ name: 'scratch_write', status: 'denied' });
    await expect(lstat(join(scratchRoot(g.data), sessionKey('session-3', 'turn-deny'), 'draft.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('never writes outside the session area: `..`, an absolute path elsewhere, a symlinked directory and a protected name are refused', async () => {
    const f = await runtime({ extraGrants: scratchGrants('allow') }); await f.start();
    const key = sessionKey('session-4', 'turn-escape'), dir = join(scratchRoot(f.data), key);
    // Another session of the same person, and a link inside this session pointing into the project.
    const other = join(scratchRoot(f.data), sessionKey('session-other', 'turn-escape'));
    await mkdir(other, { recursive: true, mode: 0o700 }); await mkdir(dir, { recursive: true, mode: 0o700 });
    await symlink(join(f.project, 'src'), join(dir, 'link'));
    const attempts = [{ path: '../x.txt' }, { path: `${other}/x.txt` }, { path: join(f.project, 'src', 'x.ts') }, { path: 'link/x.ts' }, { path: 'deep/../../x.txt' },
      { path: '.env' }];
    f.state.script = [...attempts.map(args => call('scratch_write', { ...args, content: 'escape\n' })), { content: 'Refused.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(turn('turn-escape', 'session-4'), event => events.push(event));
    expect(finished(events).map(event => event.kind === 'tool.finished' && event.status)).toEqual(attempts.map(() => 'error'));
    expect(toolTexts(events)).toEqual(['invalid-path', 'outside-workspace', 'outside-workspace', 'parent-path-outside-workspace', 'invalid-path', 'denied']
      .map(reason => `[deckent] scratch_write: error=${reason}`));
    await expect(lstat(join(f.project, 'src', 'x.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(other, 'x.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(scratchRoot(f.data), sessionKey('session-4', 'turn-escape').split('/')[0]!, 'x.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.rows('SELECT count(*) AS count FROM effect_intents')).toEqual([{ count: 0 }]);
  }, 60_000);

  it('keeps every scratch area out of the project tools when the data root lies inside the project (layout deny)', async () => {
    const f = await runtime({ dataInside: true, extraGrants: scratchGrants('allow') }); await f.start();
    const other = join(scratchRoot(f.data), sessionKey('session-other', 'x'));
    await mkdir(other, { recursive: true, mode: 0o700 }); await writeFile(join(other, 'theirs.txt'), 'not yours\n', { mode: 0o600 });
    const rel = other.slice(f.project.length + 1);
    f.state.script = [call('read_file', { path: `${rel}/theirs.txt` }), call('list_dir', { path: rel }), { content: 'Refused.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(turn('turn-inside', 'session-8'), event => events.push(event));
    expect(toolTexts(events)).toEqual([expect.stringContaining('error=path-denied'), expect.stringContaining('error=path-denied')]);
    expect(toolTexts(events).join('')).not.toContain('not yours');
  }, 60_000);

  it('refuses a write over the write, session or installation quota by name before any card, and never cuts content', async () => {
    const f = await runtime({ extraGrants: scratchGrants('require-approval'),
      scratch: { schemaVersion: 1, writeMaxBytes: 1_024, sessionMaxBytes: 2_048, installationMaxBytes: 4_096 } });
    await f.start();
    const key = sessionKey('session-5', 'turn-quota'), dir = join(scratchRoot(f.data), key);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    f.state.script = [call('scratch_write', { path: 'big.txt', content: 'x'.repeat(1_500) }), { content: 'Too big.' }];
    const events: AgentTurnStreamEvent[] = [];
    await f.client().chatTurn(turn('turn-quota', 'session-5'), event => events.push(event));
    // Session: 1 500 bytes already there; 800 more would pass 2 048.
    await writeFile(join(dir, 'held.bin'), Buffer.alloc(1_500, 1), { mode: 0o600 });
    f.state.script.push(call('scratch_write', { path: 'more.txt', content: 'y'.repeat(800) }), { content: 'Session full.' });
    await f.client().chatTurn(turn('turn-quota-2', 'session-5'), event => events.push(event));
    // Installation: another person's area holds 3 000 bytes; this session's 1 500 + 500 would pass 4 096.
    const elsewhere = join(scratchRoot(f.data), 'feedfacefeedfacefeedfacefeedface', 'cafecafecafecafecafecafecafecafe');
    await mkdir(elsewhere, { recursive: true, mode: 0o700 }); await writeFile(join(elsewhere, 'theirs.bin'), Buffer.alloc(3_000, 2), { mode: 0o600 });
    f.state.script.push(call('scratch_write', { path: 'small.txt', content: 'z'.repeat(500) }), { content: 'Installation full.' });
    await f.client().chatTurn(turn('turn-quota-3', 'session-5'), event => events.push(event));
    expect(events.some(event => event.kind === 'approval.requested')).toBe(false);
    expect(toolTexts(events)).toEqual([expect.stringMatching(/error=scratch-quota-exceeded \(write: 1500 > 1024 bytes\)/u),
      expect.stringMatching(/error=scratch-quota-exceeded \(session: 1500 \+ 800 > 2048 bytes\)/u),
      expect.stringMatching(/error=scratch-quota-exceeded \(installation: 4500 \+ 500 > 4096 bytes\)/u)]);
    for (const name of ['big.txt', 'more.txt', 'small.txt']) await expect(lstat(join(dir, name))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});

const shellGrants = [
  { id: 'shell-tool', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['run_shell'] } },
  { id: 'shell-run', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['host.shell.run'] } }];
const DAY_MS = 86_400_000;
const ageTree = async (dir: string, atMs: number) => {
  const when = new Date(atMs);
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) await utimes(join(entry.parentPath, entry.name), when, when);
  await utimes(dir, when, when);
};

describe.skipIf(process.platform !== 'linux')('agent scratch area: shell, retention and /scratch (SCR-A S3–S4, v16)', () => {
  it('gives run_shell the conversation scratch as TMPDIR (over the service value), reads an absolute scratch path without asking, asks for another area', async () => {
    const f = await runtime({ extraGrants: [...scratchGrants('allow'), ...shellGrants], shell: { schemaVersion: 1, environment: ['TMPDIR'] } }); await f.start();
    // The service's own TMPDIR (and the operator naming it in `terminal.shell.environment`) never reaches the agent's shell.
    vi.stubEnv('TMPDIR', '/tmp/operator-tmp');
    try {
      const dir = join(scratchRoot(f.data), sessionKey('session-6', 'turn-shell')), other = join(scratchRoot(f.data), sessionKey('session-other', 'turn-shell'));
      await mkdir(other, { recursive: true, mode: 0o700 }); await writeFile(join(other, 'theirs.txt'), 'not yours\n', { mode: 0o600 });
      f.state.script = [call('run_shell', { command: 'printenv TMPDIR' }), call('scratch_write', { path: 'notes.txt', content: 'noted\n' }),
        call('run_shell', { command: `cat ${dir}/notes.txt` }), call('run_shell', { command: `cat ${other}/theirs.txt` }), { content: 'Done.' }];
      const client = f.client(), events: AgentTurnStreamEvent[] = [], pending: Promise<unknown>[] = [], asked: string[] = [];
      await client.chatTurn(turn('turn-shell', 'session-6'), event => {
        events.push(event);
        if (event.kind !== 'approval.requested') return;
        asked.push(event.summary);
        // A low-risk read (the environment) asks in every mode (allowed once); a path in another area asks (denied).
        const allow = !event.summary.includes('theirs');
        pending.push(client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: event.approvalId, commandId: `decide-${asked.length}`,
          expectedRevision: event.revision, decision: allow ? 'allow' : 'deny', reason: allow ? 'Fine' : 'No' }));
      });
      await Promise.all(pending);
      const texts = toolTexts(events);
      // SCR-C: under `prefer-sandbox` without a sandbox the result names the realm (`sandbox: none; ` and a closing notice line).
      expect(texts[0]).toMatch(new RegExp(`: (sandbox: none; )?exit 0 after [\\d.]+s \\(printenv TMPDIR\\)\\n${dir}\\n`, 'u'));
      expect(texts[2]).toMatch(/exit 0 [^\n]*\nnoted\n/u);
      expect(asked).toHaveLength(2); expect(asked[0]).toContain('run_shell'); expect(asked[1]).toContain('theirs');
      expect(finished(events).map(event => event.kind === 'tool.finished' && event.status)).toEqual(['ok', 'ok', 'ok', 'denied']);
      // The model was told: the shell's TMPDIR is the area.
      expect((f.state.requests[0]!['messages'] as { content: string }[])[0]!.content).toContain('run_shell gets it as TMPDIR');
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);

  it('removes areas unused past retention when the service starts, keeps recent ones and anything that is not an area', async () => {
    const f = await runtime({ scratch: { schemaVersion: 1, retentionDays: 7 } });
    const root = scratchRoot(f.data), old = join(root, sessionKey('old', 'x')), recent = join(root, sessionKey('recent', 'x'));
    await mkdir(join(old, 'deep'), { recursive: true, mode: 0o700 }); await writeFile(join(old, 'deep', 'a.txt'), 'a'.repeat(100));
    await mkdir(recent, { recursive: true, mode: 0o700 }); await writeFile(join(recent, 'b.txt'), 'b');
    await writeFile(join(root, 'stray.txt'), 'kept');
    await ageTree(old, Date.now() - 8 * DAY_MS); await ageTree(recent, Date.now() - 6 * DAY_MS);
    await f.start();
    await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
    // Both areas are the same person's: their owner directory stays while it holds the recent one.
    expect(await readdir(join(root, sessionKey('old', 'x').split('/')[0]!))).toEqual([sessionKey('recent', 'x').split('/')[1]]);
    expect(await readFile(join(recent, 'b.txt'), 'utf8')).toBe('b'); expect(await readFile(join(root, 'stray.txt'), 'utf8')).toBe('kept');
    expect(f.scratchSwept).toEqual([{ removedSessions: 1, removedBytes: 100, kept: 1, unreadable: 0 }]);
  }, 60_000);

  it('/scratch through the service: lists the conversation area newest first, names its path, empties it and keeps the directory (v16)', async () => {
    const f = await runtime({ extraGrants: scratchGrants('allow') }); await f.start();
    f.state.script = [call('scratch_write', { path: 'a.md', content: 'first\n' }), call('scratch_write', { path: 'diagrams/flow.mmd', content: 'graph TD; A-->B\n' }),
      { content: 'Written.' }];
    await f.client().chatTurn(turn('turn-list', 'session-7'), () => undefined);
    const dir = join(scratchRoot(f.data), sessionKey('session-7', 'turn-list'));
    const view = await f.client().inspectScratch({ schemaVersion: 1, scopeId: 'scope', sessionId: 'session-7' });
    expect(view).toMatchObject({ schemaVersion: 1, path: dir, exists: true, bytes: 22, truncated: false,
      limits: { writeMaxBytes: 1_048_576, sessionMaxBytes: 67_108_864, retentionDays: 7 } });
    expect(view.files.map(file => file.path).sort()).toEqual(['a.md', 'diagrams/flow.mmd']);
    expect((await stat(join(dir, 'diagrams', 'flow.mmd'))).mode & 0o777).toBe(0o600);
    await expect(f.client().inspectScratch({ schemaVersion: 1, scopeId: 'scope', sessionId: 'session-none' })).resolves.toMatchObject({ exists: false, files: [] });
    await expect(f.client().inspectScratch({ schemaVersion: 1, scopeId: 'not-mine', sessionId: 'session-7' })).rejects.toMatchObject({ code: expect.any(String) });
    expect(await f.client().clearScratch({ schemaVersion: 1, scopeId: 'scope', sessionId: 'session-7' })).toEqual({ schemaVersion: 1, path: dir,
      removedFiles: 2, removedBytes: 22 });
    expect(await readdir(dir)).toEqual([]);
    expect((await f.client().inspectScratch({ schemaVersion: 1, scopeId: 'scope', sessionId: 'session-7' })).exists).toBe(true);
  }, 60_000);
});
