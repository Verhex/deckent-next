import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCodexState, createNativeLineObserver, createNormalizerState, flushUnmapped, normalizeClaudeLine, normalizeCodexLine, secretValues, workerRedactText } from '#adapters/index.js';
import { createNativeChildCustody, nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';
import { summarizeWorkerEvents, workerActivityPhase, workerEventSchema, type WorkerEvent } from '#domain/index.js';

const fixture = new URL('../../fixtures/worker-events/claude-stream.jsonl', import.meta.url);
async function normalize(lines: string[], secrets: string[] = []) {
  const state = createNormalizerState(secrets, 1_000);
  const raw = [...lines.flatMap((line, index) => normalizeClaudeLine(line, state, 1_000 + index * 100)), ...flushUnmapped(state, 99_999)];
  return raw.map(event => workerEventSchema.parse(event)) as WorkerEvent[];
}

it('maps a real Claude stream onto the one current worker event schema with provider totals, tool classes and workspace paths', async () => {
  const lines = (await readFile(fixture, 'utf8')).split('\n').filter(Boolean);
  const events = await normalize(lines);
  expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(events[0]).toMatchObject({ kind: 'session.started', provider: 'claude', model: 'claude-haiku-4-5-20251001', cliVersion: '2.1.280' });
  expect(events.filter(event => event.kind === 'tool.call').map(event => event.kind === 'tool.call' && [event.name, event.toolClass, event.target, event.detail]))
    .toEqual([['Write', 'write', 'hello.txt', null], ['Read', 'read', 'hello.txt', null], ['Bash', 'shell', null, expect.any(String)]]);
  expect(events.filter(event => event.kind === 'tool.result').every(event => event.kind === 'tool.result' && event.status === 'ok')).toBe(true);
  // Thinking content is never kept, only its size; hooks and thinking-token ticks are ignored, other native types are counted.
  expect(events.filter(event => event.kind === 'message' && event.thinking).every(event => event.kind === 'message' && event.excerpt === '')).toBe(true);
  expect(events.some(event => event.kind === 'quota')).toBe(true);
  const ended = events.find(event => event.kind === 'session.ended');
  expect(ended).toMatchObject({ outcome: 'success', turns: 4, durationMs: 12845, apiDurationMs: 12233, costBasis: 'list',
    tokens: { input: 26, output: 859, cacheRead: 65832, cacheWrite: 12854, thinking: 487 } });
  const summary = summarizeWorkerEvents(events);
  expect(summary).toMatchObject({ provider: 'claude', outcome: 'success', turns: 4, toolErrors: 0, filesTouched: ['hello.txt'],
    toolCalls: { write: 1, read: 1, shell: 1, edit: 0 }, tokens: { input: 26, output: 859, cacheRead: 65832, cacheWrite: 12854 } });
  expect(summary.cacheReadRatio).toBeCloseTo(65832 / (26 + 65832 + 12854), 6);
  expect(workerActivityPhase(events)).toMatchObject({ phase: 'finished' });
  expect(workerActivityPhase(events.slice(0, events.findIndex(event => event.kind === 'tool.call' && event.toolClass === 'write') + 1)))
    .toMatchObject({ phase: 'editing', target: 'hello.txt' });
  // Usage is counted once per API response id even when one response carries several content blocks.
  const usageIds = lines.map(line => JSON.parse(line) as { type: string; message?: { id: string } }).filter(line => line.type === 'assistant').map(line => line.message!.id);
  expect(usageIds.length).toBeGreaterThan(new Set(usageIds).size);
  expect(events.filter(event => event.kind === 'usage')).toHaveLength(new Set(usageIds).size);
});

it('never lets credentials, bearer tokens, key-shaped strings, proxy credentials or authorization headers leave the container', async () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LWFjY2Vzcy10b2tlbg.c2lnbmF0dXJlLXZhbHVl';
  const secrets = secretValues({ tokens: { access_token: token, refresh_token: 'refresh-secret-value' } });
  const proxy = 'http://127.0.0.1:43123';
  const assistant = (id: string, content: unknown[]) => JSON.stringify({ type: 'assistant', message: { id, content, usage: { input_tokens: 1, output_tokens: 1 } } });
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: '/workspace', model: 'm', claude_code_version: 'v' }),
    assistant('a', [{ type: 'text', text: `the token is ${token} and refresh-secret-value; Authorization: Bearer abc.def.ghi.fictional` }]),
    assistant('b', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${token}" ${proxy}`, description: `export API_KEY=sk-live-0123456789abcdef and token=${token}` } }]),
    assistant('c', [{ type: 'tool_use', id: 't2', name: 'WebFetch', input: { url: 'https://user:hunter2@example.com/path?token=abc' } }]),
    assistant('d', [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/home/owner/.claude/.credentials.json' } }]),
    // A file name that carries the credential itself is redacted like any other exported text (Astra 2044).
    assistant('e', [{ type: 'tool_use', id: 't4', name: 'Write', input: { file_path: `/workspace/notes-${token}.txt` } }]),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `raw output with ${token}`, is_error: true }] } }),
  ];
  const events = await normalize(lines, [...secrets, proxy]);
  const serialized = JSON.stringify(events);
  for (const leaked of [token, 'refresh-secret-value', 'sk-live-0123456789abcdef', 'abc.def.ghi.fictional', 'hunter2', 'raw output', proxy]) expect(serialized).not.toContain(leaked);
  expect(serialized).toContain('[REDACTED]');
  expect(events.find(event => event.kind === 'tool.call' && event.name === 'Read')).toMatchObject({ target: '(outside-workspace)/.credentials.json' });
  expect(events.find(event => event.kind === 'tool.result')).toMatchObject({ status: 'error' });
  expect(workerRedactText('x'.repeat(500), [], 240)).toHaveLength(240);
});

it('counts unknown native events instead of dropping them and rejects events outside the current schema', async () => {
  const events = await normalize(['not json', JSON.stringify({ type: 'brand_new_event' }), JSON.stringify({ type: 'system', subtype: 'thinking_tokens' }),
    JSON.stringify({ type: 'system', subtype: 'future_subtype' })]);
  expect(events).toEqual([expect.objectContaining({ kind: 'unmapped', nativeType: 'non-json', count: 1 }), expect.objectContaining({ kind: 'unmapped', nativeType: 'brand_new_event', count: 1 }),
    expect.objectContaining({ kind: 'unmapped', nativeType: 'system:future_subtype', count: 1 })]);
  expect(workerEventSchema.safeParse({ schemaVersion: 2, sequence: 1, atMs: 0, kind: 'unmapped', nativeType: 'x', count: 1 }).success).toBe(false);
  expect(workerEventSchema.safeParse({ schemaVersion: 1, sequence: 1, atMs: 0, kind: 'message', role: 'assistant', textBytes: 1, thinking: false, excerpt: 'x'.repeat(241) }).success).toBe(false);
});

it('maps a codex exec --json stream onto the same schema: shell and patch calls, redacted agent text, cached tokens apart, one ended session (B09-3)', () => {
  // Event and field names as carried by the pinned Codex 0.155.1 binary; synthetic lines, not a recorded run.
  const lines = [
    { type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'private plan' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'npm test -- --token=sk-abcdefghijkl', aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: '/workspace/src/a.ts', kind: 'update' }, { path: '/workspace/b.md', kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'false', aggregated_output: 'boom', exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Done; secret-value-123 stays out.' } },
    { type: 'item.completed', item: { id: 'item_5', type: 'todo_list', items: [] } },
    { type: 'item.completed', item: { id: 'item_6', type: 'brand_new_item' } },
    { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 80, reasoning_output_tokens: 30 } },
  ].map(line => JSON.stringify(line));
  const state = createNormalizerState(['secret-value-123'], 1_000), codex = createCodexState();
  const events = [...lines.flatMap((line, index) => normalizeCodexLine(line, state, codex, 1_000 + index * 100)), ...flushUnmapped(state, 99_999)]
    .map(event => workerEventSchema.parse(event)) as WorkerEvent[];
  expect(events.filter(event => event.kind === 'tool.call').map(event => event.kind === 'tool.call' && [event.toolId, event.name, event.toolClass, event.target]))
    .toEqual([['item_1', 'shell', 'shell', null], ['item_2:0', 'apply_patch', 'edit', 'src/a.ts'], ['item_2:1', 'apply_patch', 'write', 'b.md'], ['item_3', 'shell', 'shell', null]]);
  const shell = events.find(event => event.kind === 'tool.call' && event.toolId === 'item_1');
  expect(shell).toMatchObject({ detail: expect.not.stringContaining('sk-abcdefghijkl') });
  expect(events.filter(event => event.kind === 'tool.result').map(event => event.kind === 'tool.result' && [event.toolId, event.status]))
    .toEqual([['item_1', 'ok'], ['item_2:0', 'ok'], ['item_2:1', 'ok'], ['item_3', 'error']]);
  const messages = events.filter(event => event.kind === 'message');
  expect(messages).toMatchObject([{ thinking: true, excerpt: '' }, { thinking: false, excerpt: 'Done; [REDACTED] stays out.' }]);
  expect(events.filter(event => event.kind === 'usage')).toMatchObject([{ tokens: { input: 200, cacheRead: 1000, output: 80, thinking: 30 } }]);
  expect(events.filter(event => event.kind === 'unmapped')).toMatchObject([{ nativeType: 'item:brand_new_item', count: 1 }]);
  const summary = summarizeWorkerEvents(events);
  expect(summary).toMatchObject({ outcome: 'success', turns: 1, toolErrors: 1, filesTouched: ['b.md', 'src/a.ts'], tokens: { input: 200, cacheRead: 1000, output: 80 } });
  expect(summary.cacheReadRatio).toBeCloseTo(1000 / 1200);
  expect(workerActivityPhase(events)).toMatchObject({ phase: 'finished' });
  // A failed turn ends the session as an error, and a started-then-completed item is one call, not two.
  const failed = normalizeCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'x' } }), createNormalizerState([], 0), createCodexState(), 10);
  expect(failed).toMatchObject([{ kind: 'session.ended', outcome: 'error' }]);
});

it('F2-7: a bridged Deckent tool keeps its own class (edit counts as a changed file, run_shell names its command); another MCP tool stays network', () => {
  const bridge = new Map([['mcp__deckent__edit_file', 'edit'], ['mcp__deckent__run_shell', 'shell']]), state = createNormalizerState([], 0, undefined, bridge);
  const claude = [{ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'mcp__deckent__edit_file', input: { path: 'notlar.txt' } },
    { type: 'tool_use', id: 't2', name: 'mcp__deckent__run_shell', input: { command: 'tail -n 1 notlar.txt' } }, { type: 'tool_use', id: 't3', name: 'mcp__other__edit_file', input: {} }] } }];
  const codex = [{ type: 'item.completed', item: { id: 'c1', type: 'mcp_tool_call', server: 'deckent', tool: 'edit_file', arguments: { path: 'b.md' }, status: 'completed' } }];
  const events = [...claude.flatMap(line => normalizeClaudeLine(JSON.stringify(line), state, 1)), ...codex.flatMap(line => normalizeCodexLine(JSON.stringify(line), state, createCodexState(), 2))]
    .map(event => workerEventSchema.parse(event)) as WorkerEvent[];
  expect(events.filter(event => event.kind === 'tool.call').map(event => event.kind === 'tool.call' && [event.toolClass, event.target, event.detail]))
    .toEqual([['edit', 'notlar.txt', null], ['shell', null, 'tail -n 1 notlar.txt'], ['network', null, null], ['edit', 'b.md', null]]);
  expect(summarizeWorkerEvents(events).filesTouched).toEqual(['b.md', 'notlar.txt']);
});

it('keeps secrets out of every Codex-derived field, never turns unknown status into success, and survives malformed input (Astra 2066)', () => {
  const secret = 'probe-secret-value';
  const state = createNormalizerState([secret], 0), codex = createCodexState();
  const lines = [
    { type: secret }, { type: `x\u0007${secret}` },
    { type: 'item.completed', item: { id: 'a', type: secret } },
    { type: 'item.completed', item: { id: 'b', type: 'file_change', status: 'completed', changes: [{ path: '/workspace/a.ts', kind: secret }, null, { path: 7 }] } },
    { type: 'item.completed', item: { id: 'c', type: 'mcp_tool_call', server: secret, tool: 'x', arguments: {} } },
    { type: 'item.completed', item: null }, { type: 'turn.completed', usage: 'bad' },
  ].map(line => JSON.stringify(line));
  const events = [...lines.flatMap(line => normalizeCodexLine(line, state, codex, 5)), ...flushUnmapped(state, 6)].map(event => workerEventSchema.parse(event)) as WorkerEvent[];
  expect(JSON.stringify(events)).not.toContain(secret);
  // The unknown change kind is an edit without a claimed kind; the MCP call without a status gets no success result.
  expect(events.find(event => event.kind === 'tool.call' && event.toolId === 'b:0')).toMatchObject({ toolClass: 'edit', detail: null });
  expect(events.some(event => event.kind === 'tool.result' && event.toolId === 'c')).toBe(false);
  const unmapped = Object.fromEntries(events.flatMap(event => event.kind === 'unmapped' ? [[event.nativeType, event.count]] : []));
  expect(unmapped).toMatchObject({ 'file_change.kind': 1, 'file_change.change-invalid': 2, 'mcp_tool_call.status': 1, 'item-invalid': 1 });
  // Malformed usage is unknown, not a measured zero.
  expect(events.find(event => event.kind === 'session.ended')).toMatchObject({ outcome: 'success', tokens: null });
  expect(unmapped).toMatchObject({ 'usage-invalid': 1 });
  // Inherited property names are unknown kinds too (Astra 2073).
  const proto = createNormalizerState([], 0), protoCodex = createCodexState();
  const protoEvents = [...['__proto__', 'constructor', 'toString', 'hasOwnProperty'].flatMap((kind, i) => normalizeCodexLine(JSON.stringify({ type: 'item.completed',
    item: { id: `k${i}`, type: 'file_change', status: 'completed', changes: [{ path: '/workspace/a.ts', kind }] } }), proto, protoCodex, 1)), ...flushUnmapped(proto, 2)]
    .map(event => workerEventSchema.parse(event)) as WorkerEvent[];
  expect(protoEvents.filter(event => event.kind === 'tool.call').every(event => event.kind === 'tool.call' && event.toolClass === 'edit' && event.detail === null)).toBe(true);
  expect(protoEvents).toContainEqual(expect.objectContaining({ kind: 'unmapped', nativeType: 'file_change.kind', count: 4 }));
});

it('attributes every file of a large patch up to the cap and counts the rest; long and shared-prefix ids stay distinct and schema-valid', () => {
  const state = createNormalizerState([], 0), codex = createCodexState();
  const changes = Array.from({ length: 600 }, (_, i) => ({ path: `/workspace/f${i}.ts`, kind: 'update' }));
  const longA = 'x'.repeat(100) + 'A', longB = 'x'.repeat(100) + 'B';
  const lines = [{ type: 'item.completed', item: { id: 'p', type: 'file_change', status: 'completed', changes } },
    { type: 'item.started', item: { id: longA, type: 'command_execution', command: 'a', aggregated_output: '', status: 'in_progress' } },
    { type: 'item.completed', item: { id: longA, type: 'command_execution', command: 'a', aggregated_output: '', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: longB, type: 'command_execution', command: 'b', aggregated_output: '', exit_code: 1, status: 'failed' } }].map(line => JSON.stringify(line));
  const events = [...lines.flatMap(line => normalizeCodexLine(line, state, codex, 1)), ...flushUnmapped(state, 2)].map(event => workerEventSchema.parse(event)) as WorkerEvent[];
  expect(events.filter(event => event.kind === 'tool.call' && event.name === 'apply_patch')).toHaveLength(512);
  expect(events).toContainEqual(expect.objectContaining({ kind: 'unmapped', nativeType: 'file_change.changes-over-cap', count: 88 }));
  const shells = events.filter(event => event.kind === 'tool.call' && event.name === 'shell');
  expect(shells).toHaveLength(2); expect(new Set(shells.map(event => event.kind === 'tool.call' && event.toolId)).size).toBe(2);
  const results = events.filter(event => event.kind === 'tool.result' && shells.some(call => call.kind === 'tool.call' && call.toolId === event.toolId));
  expect(results.map(event => event.kind === 'tool.result' && event.status)).toEqual(['ok', 'error']);
});

it('never lets a normalizer or delivery fault escape the bridge line observer, and keeps observing afterwards', () => {
  const state = createNormalizerState([], 0), delivered: unknown[] = [];
  let fail = true;
  const observer = createNativeLineObserver('codex-exec-json', state, createCodexState(), events => { if (fail) { fail = false; throw new Error('channel down'); } delivered.push(...events); });
  const lines = [JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'b', type: 'file_change', status: 'completed', changes: [null] } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'n', type: 'agent_message', text: 'after' } })];
  expect(() => observer.observe(Buffer.from(lines.join('\n') + '\n'))).not.toThrow();
  expect(() => observer.observe(Buffer.from('{"type":"turn.completed","usage":{}}'))).not.toThrow();
  observer.flush();
  expect(delivered).toContainEqual(expect.objectContaining({ kind: 'message', excerpt: 'after' }));
  expect(delivered).toContainEqual(expect.objectContaining({ kind: 'session.ended', outcome: 'success' }));
  expect(state.unmapped.get('normalizer-error')).toBe(1);
});

it('uses the shared quota rule and never permits worker paid usage without a live person notice', async () => {
  const pure = await readFile(new URL('../../../src/capabilities/core/native-agent-execution/internal/quota-rule.ts', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../../../src/adapters/core/native-connection/internal/worker.ts', import.meta.url), 'utf8');
  expect(worker).toContain(pure); // The standalone bootstrap cannot import host modules; reject classification drift.
  const state = createNormalizerState([], 1000, nativeQuotaPolicy());
  for (const info of [
    { status: 'rejected' }, { status: 'rejected', overageStatus: 'allowed' },
    { status: 'allowed', isUsingOverage: true }, { status: 'allowed_warning', overageInUse: true },
    ...['future', true, {}, '', null].map(overageStatus => ({ status: 'rejected', overageStatus })),
  ]) {
    const events = normalizeClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { ...info, rateLimitType: 'five_hour', resetsAt: 1792773600 } }), state, 1000);
    expect(events.map(event => workerEventSchema.parse(event))).toContainEqual(expect.objectContaining({ kind: 'quota-exhausted', window: 'five_hour', resetsAtMs: 1792773600000 }));
  }
  for (const status of ['allowed', 'allowed_warning', 'future'])
    expect(normalizeClaudeLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status } }), state, 1000)).toEqual([]);
  // The real bootstrap custody, with a descendant holding both pipes (the 3090 reproduction).
  const root = await mkdtemp(join(tmpdir(), 'deckent-quota-child-')), effect = join(root, 'partial-effect');
  const signal = vi.spyOn(process, 'kill');
  try {
    for (const mode of ['group-paid', 'group-rejected', 'escaped'] as const) {
      const info = mode === 'group-rejected' ? { status: 'rejected' } : { status: 'allowed', overageInUse: true };
      const quota = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
      const late = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'must-not-be-accepted' }] } });
      const descendant = `process.stdout.write(JSON.stringify({pid:process.pid})+'\\n'+${JSON.stringify(quota)}+'\\n');setInterval(()=>process.stdout.write(${JSON.stringify(late)}+'\\n'),40)`;
      const parent = `const {spawn}=require('node:child_process');require('node:fs').writeFileSync(${JSON.stringify(effect)},'kept');process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'partial output'}]}})+'\\n');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:${mode === 'escaped'},stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000)`;
      const child = spawn(process.execPath, ['-e', parent], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const custody = createNativeChildCustody(child), kept: unknown[] = [], normalizer = createNormalizerState([], 0, nativeQuotaPolicy());
      const observer = createNativeLineObserver('claude-code-stream-json', normalizer, createCodexState(), events => kept.push(...events), undefined, () => custody.stopAtQuota());
      let pid: number | undefined, pending = '', atLimit = 0, afterLimit = 0;
      child.stdout.on('data', (part: Buffer) => {
        pending += part.toString();
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          const value = JSON.parse(line) as { pid?: number };
          if (value.pid) pid = value.pid;
          if (custody.stopped()) afterLimit++;
          observer.observe(Buffer.from(line + '\n'));
          if (custody.stopped() && !atLimit) atLimit = performance.now();
        }
      });
      child.stderr.resume();
      try {
        const result = await custody.result; observer.flush();
        expect(performance.now() - atLimit).toBeLessThan(2000);
        expect(result).toEqual({ code: null, signal: 'SIGKILL', failure: mode === 'escaped' ? 'capacity:quota-stop-incomplete' : 'capacity:quota-stop' });
        expect(signal).toHaveBeenCalledWith(-child.pid!, 'SIGKILL');
        expect(await readFile(effect, 'utf8')).toBe('kept');
        expect(kept).toEqual([expect.objectContaining({ kind: 'message', excerpt: 'partial output' }), expect.objectContaining({ kind: 'quota-exhausted' })]);
        expect(pid).toBeTypeOf('number');
        if (mode === 'escaped') {
          expect(afterLimit).toBeGreaterThan(0); // It outlived the signal; the observer refused its output.
          expect(await readFile(`/proc/${pid}/stat`, 'utf8')).not.toMatch(/\) Z /u);
          expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
          expect(performance.now() - atLimit).toBeGreaterThanOrEqual(950);
        } else {
          // A reparented zombie has terminated and holds no pipes; kill(pid,0) alone cannot distinguish it.
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => 'gone');
          expect(stat === 'gone' || /\) Z /u.test(stat)).toBe(true);
          expect(afterLimit).toBe(0);
        }
      } finally {
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Fixture may already have exited. */ } }
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Only this fixture's owned group. */ }
        child.stdout.destroy(); child.stderr.destroy();
      }
    }
    for (const code of [0, 7]) {
      signal.mockClear();
      const child = spawn(process.execPath, ['-e', `process.stdout.write('normal');process.exitCode=${code}`], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const custody = createNativeChildCustody(child);
      child.stdout.resume(); child.stderr.resume();
      expect(await custody.result).toEqual({ code, signal: null, failure: null });
      expect(signal).not.toHaveBeenCalled();
    }
  } finally { signal.mockRestore(); await unlink(effect).catch(() => undefined); await rmdir(root); }
});
