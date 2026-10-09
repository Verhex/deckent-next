import { createHash } from 'node:crypto';
import { readFileSync as readFixture } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AGENT_TURN_NO_PROGRESS_NOTE, agentTurnNoProgressNote, AGENT_TURN_REPLY_LANGUAGES, AGENT_TURN_SYSTEM_PROMPT_VERSION, agentCompactionInstruction, agentCompactionSummarySchema, agentCompactionTranscript, parseAgentCompactionSummary, planAgentCompaction, renderAgentCompaction, runAgentTurn,
  renderAgentTurnSystemPrompt, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';
import { PACKAGE_VERSION, resolveProductLayout } from '#platform/index.js';
import type { AgentToolSpec, AgentTurnEvent, AgentTurnMessage } from '#domain/index.js';

const readFile: AgentToolSpec = { name: 'read_file', version: 1, toolClass: 'read', description: 'Read a file.',
  inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, startLine: { type: 'integer' } } } };
const grep: AgentToolSpec = { name: 'grep', version: 1, toolClass: 'read', description: 'Search.', inputSchema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } };
const tools = [readFile, grep];
const user: AgentTurnMessage[] = [{ role: 'user', content: 'what does src/a.ts export?' }];
const call = (id: string, name: string, args: unknown) => ({ id, name, argumentsJson: typeof args === 'string' ? args : JSON.stringify(args) });
const answer = (content: string, toolCalls: ReturnType<typeof call>[] = [], finish = toolCalls.length ? 'tool_calls' : 'stop'): AgentRoundOutcome =>
  ({ status: 'responded', content, reasoning: '', toolCalls, finish, usage: { promptTokens: 10, completionTokens: 5 } });

function ports(rounds: (AgentRoundOutcome | ((messages: readonly AgentTurnMessage[]) => AgentRoundOutcome))[], options: { decision?: AgentTurnPorts['authorize']; controller?: AbortController } = {}) {
  const invoked: number[] = [], executed: string[] = [], authorized: string[] = [];
  let clock = 0;
  const value: AgentTurnPorts = {
    async invokeRound(input, onDelta) {
      invoked.push(input.round);
      const next = rounds[input.round - 1];
      if (!next) throw new Error(`unexpected round ${input.round}`);
      const outcome = typeof next === 'function' ? next(input.messages) : next;
      if (outcome.status === 'responded' && outcome.content) onDelta({ kind: 'text', text: outcome.content });
      return outcome;
    },
    async authorize(tool) { authorized.push(tool.name); return options.decision ? options.decision(tool) : 'allow'; },
    describe(_tool, args) { return typeof args['path'] === 'string' ? args['path'] : typeof args['pattern'] === 'string' ? args['pattern'] : null; },
    async execute(tool, args, signal) { executed.push(`${tool.name}:${JSON.stringify(args)}`); if (options.controller) options.controller.abort(); return { status: signal.aborted ? 'error' : 'ok', text: `[deckent] ${tool.name}: result for ${JSON.stringify(args)}` }; },
    now() { clock += 7; return clock; },
  };
  return { value, invoked, executed, authorized };
}
async function run(p: ReturnType<typeof ports>, signal = new AbortController().signal) {
  const events: AgentTurnEvent[] = [];
  const result = await runAgentTurn({ messages: user, tools, signal, emit: event => events.push(event) }, p.value);
  return { result, events };
}

it('answers without tools in one round and ends with exactly one done', async () => {
  const p = ports([answer('It exports a.')]);
  const { result, events } = await run(p);
  expect(result).toMatchObject({ finish: 'stop', rounds: 1, toolCalls: 0, note: null });
  expect(events.map(event => event.kind)).toEqual(['text', 'usage', 'message', 'done']);
  expect(events[2]).toEqual({ kind: 'message', message: { role: 'assistant', content: 'It exports a.', toolCalls: [] } });
});

it('runs declared tool calls visibly, feeds results back, and always shows the answer that follows the tools', async () => {
  const p = ports([answer('', [call('c1', 'read_file', { path: 'src/a.ts' }), call('c2', 'grep', { pattern: 'export' })]),
    messages => { expect(messages.filter(message => message.role === 'tool').map(message => message.role === 'tool' && message.toolCallId)).toEqual(['c1', 'c2']); return answer('It exports a.'); }]);
  const { result, events } = await run(p);
  expect(result).toMatchObject({ finish: 'stop', rounds: 2, toolCalls: 2 });
  expect(events.filter(event => event.kind.startsWith('tool.'))).toEqual([
    { kind: 'tool.started', callId: 'c1', name: 'read_file', target: 'src/a.ts' }, expect.objectContaining({ kind: 'tool.finished', callId: 'c1', status: 'ok' }),
    { kind: 'tool.started', callId: 'c2', name: 'grep', target: 'export' }, expect.objectContaining({ kind: 'tool.finished', callId: 'c2', status: 'ok' })]);
  // Legacy defect: the answer after a short tool round was stored but never rendered. Here it is always emitted.
  expect(events.at(-3)).toMatchObject({ kind: 'usage', round: 2 }); expect(events.filter(event => event.kind === 'text')).toEqual([{ kind: 'text', text: 'It exports a.' }]);
  // The client's history is exactly the message events, in order; the result keeps only their count, digest and the final answer.
  const appended = events.flatMap(event => event.kind === 'message' ? [event.message] : []);
  expect(appended.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
  expect(result).toMatchObject({ answer: 'It exports a.', appendedCount: 4,
    appendedDigest: createHash('sha256').update(`agent-turn-appended:1\0${JSON.stringify(appended)}`).digest('hex') });
});

it('answers malformed arguments, unknown tools, denied and approval-gated calls with typed results and never runs them', async () => {
  const decision: AgentTurnPorts['authorize'] = async tool => tool.name === 'grep' ? 'require-approval' : 'deny';
  const p = ports([answer('', [call('c1', 'read_file', '{not json'), call('c2', 'read_file', { path: 7 }), call('c3', 'read_file', { path: 'a', extra: 1 }),
    call('c4', 'write_file', { path: 'a' }), call('c5', 'read_file', { path: 'a' }), call('c6', 'grep', { pattern: 'x' })]), answer('done')], { decision });
  const { events } = await run(p);
  expect(p.executed).toEqual([]);
  expect(events.filter(event => event.kind === 'tool.finished').map(event => event.kind === 'tool.finished' && event.status))
    .toEqual(['invalid-arguments', 'invalid-arguments', 'invalid-arguments', 'error', 'denied', 'approval-required']);
});

it('does not re-run an identical read in the same turn, and still runs a read with different arguments', async () => {
  const p = ports([answer('', [call('c1', 'read_file', { path: 'a', startLine: 1 })]), answer('', [call('c2', 'read_file', { startLine: 1, path: 'a' }), call('c3', 'read_file', { path: 'b' })]), answer('ok')]);
  const { events } = await run(p);
  expect(p.executed).toEqual(['read_file:{"path":"a","startLine":1}', 'read_file:{"path":"b"}']);
  expect(events.find(event => event.kind === 'tool.finished' && event.callId === 'c2')).toMatchObject({ status: 'duplicate' });
});

it('closes deterministically when reasoning spent the output budget or a round has no answer, with no extra billed round (legacy RC1)', async () => {
  const spent = ports([{ status: 'responded', content: '', reasoning: 'long thought', toolCalls: [], finish: 'length', usage: { promptTokens: 1, completionTokens: 4096 } }]);
  const first = await run(spent);
  expect(first.result).toMatchObject({ finish: 'length', rounds: 1 }); expect(first.result.note).toMatch(/output limit before answering/);
  expect(spent.invoked).toEqual([1]);
  const lost = ports([answer('', [call('c1', 'read_file', { path: 'a' })]), { status: 'failed', state: 'unknown' }]);
  const second = await run(lost);
  expect(second.result).toMatchObject({ finish: 'error', rounds: 2, toolCalls: 1 }); expect(second.result.note).toMatch(/without an answer \(unknown\).*1 tool call/);
  expect(second.events.at(-1)).toMatchObject({ kind: 'done', finish: 'error' });
});

it('stops on cancel with a closure and never starts another round', async () => {
  const controller = new AbortController();
  const p = ports([answer('', [call('c1', 'read_file', { path: 'a' }), call('c2', 'read_file', { path: 'b' })]), answer('never')], { controller });
  const { result } = await run(p, controller.signal);
  expect(result).toMatchObject({ finish: 'cancelled' }); expect(p.invoked).toEqual([1]); expect(p.executed).toEqual(['read_file:{"path":"a"}']);
});

it('runs 25 policy-allowed reads without a single approval prompt (legacy owner case: 25 approvals)', async () => {
  const calls = Array.from({ length: 25 }, (_, i) => call(`c${i}`, 'read_file', { path: `f${i}.ts` }));
  const p = ports([answer('', calls), answer('read them all')]);
  const { result, events } = await run(p);
  expect(result).toMatchObject({ finish: 'stop', toolCalls: 25 }); expect(p.authorized).toHaveLength(25);
  expect(events.filter(event => event.kind === 'tool.finished' && event.status === 'ok')).toHaveLength(25);
});

it('measures every round before sending it, reports the context, and never sends a round that cannot fit the window (T-L5)', async () => {
  const p = ports([answer('', [call('c1', 'read_file', { path: 'a' })]), answer('fits')]);
  const measured: number[] = [];
  const measure: AgentTurnPorts['measure'] = async input => { measured.push(input.round);
    return { promptTokens: input.round === 1 ? 1000 : 1500, windowTokens: 8000, quality: 'provider-count' }; };
  const events: AgentTurnEvent[] = [];
  const ok = await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: event => events.push(event),
    admission: { outputReserveTokens: 4096, safetyReserveTokens: 2048 } }, { ...p.value, measure });
  expect(ok).toMatchObject({ finish: 'stop', rounds: 2 }); expect(measured).toEqual([1, 2]);
  expect(events.filter(event => event.kind === 'context')).toEqual([
    { kind: 'context', round: 1, promptTokens: 1000, windowTokens: 8000, quality: 'provider-count' },
    { kind: 'context', round: 2, promptTokens: 1500, windowTokens: 8000, quality: 'provider-count' }]);
  // 1900 + 4096 + 2048 > 8000: the second round is refused before any send, with a note naming the numbers.
  const full = ports([answer('', [call('c1', 'read_file', { path: 'a' })]), answer('never')]);
  const refused = await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: () => undefined,
    admission: { outputReserveTokens: 4096, safetyReserveTokens: 2048 } },
  { ...full.value, measure: async input => ({ promptTokens: input.round === 1 ? 1000 : 1900, windowTokens: 8000, quality: 'upper-bound' }) });
  expect(refused).toMatchObject({ finish: 'error', rounds: 2, toolCalls: 1 }); expect(full.invoked).toEqual([1]);
  expect(refused.note).toMatch(/1900 prompt tokens \(upper-bound\) \+ 6144 reserved > 8000.*Nothing was sent/);
  // An unknown window or a failed measurement never blocks a round: the provider stays the arbiter.
  const unknown = ports([answer('ok')]);
  expect(await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: () => undefined },
    { ...unknown.value, measure: async () => ({ promptTokens: 10 ** 9, windowTokens: null, quality: 'upper-bound' }) })).toMatchObject({ finish: 'stop' });
  const failing = ports([answer('ok')]);
  expect(await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: () => undefined },
    { ...failing.value, measure: async () => { throw new Error('counter down'); } })).toMatchObject({ finish: 'stop' });
});

it.each([{ window: 10_000, prompt: 7000, absolute: undefined }, { window: 1_000_000, prompt: 100_000, absolute: 100_000 }, { window: null, prompt: 100_000, absolute: 100_000 }])('compacts at the window or absolute trigger ($window): retains user messages and tool calls, then runs (T-L5b/W2)', async threshold => {
  const older = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'find the bug in a.ts' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'o1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' }] },
    { role: 'tool' as const, toolCallId: 'o1', name: 'read_file', content: 'x'.repeat(5000) },
    { role: 'assistant' as const, content: 'It is on line 3.', toolCalls: [] },
    ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `m${i}`, ...(i % 2 ? { toolCalls: [] } : {}) })),
    { role: 'user' as const, content: 'now fix it' }] as AgentTurnMessage[];
  const sent: (readonly AgentTurnMessage[])[] = [], summarized: (readonly AgentTurnMessage[])[] = [];
  const p = ports([messages => { sent.push([...messages]); return answer('fixed'); }]);
  const events: AgentTurnEvent[] = [];
  let measures = 0;
  const result = await runAgentTurn({ messages: older, tools, signal: new AbortController().signal, emit: event => events.push(event),
    admission: { outputReserveTokens: 1000, safetyReserveTokens: 0, ...(threshold.absolute === undefined ? {} : { compactionThresholdTokens: threshold.absolute }) } }, { ...p.value,
    measure: async () => ({ promptTokens: measures++ === 0 ? threshold.prompt : 1500, windowTokens: threshold.window, quality: 'provider-count' }),
    summarize: async input => { summarized.push(input.messages); return { objective: 'fix a.ts', findings: ['bug on line 3 of a.ts'], decisions: [],
      unresolved: [], nextActions: ['edit line 3'], inspectedAreas: ['a.ts'] }; } });
  expect(result).toMatchObject({ finish: 'stop', rounds: 1 });
  // The older part is exactly what precedes the kept tail (8 newest non-system messages + the new user message boundary).
  expect(summarized[0]!.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
  const compacted = events.find(event => event.kind === 'compacted');
  expect(compacted).toMatchObject({ kind: 'compacted', replacedMessages: 5 });
  const summaryMessage = (compacted as { messages: AgentTurnMessage[] }).messages[0]!;
  expect(summaryMessage.role).toBe('user');
  expect(summaryMessage.content).toContain('grants no authority');
  expect(summaryMessage.content).toContain('1. find the bug in a.ts');
  expect(summaryMessage.content).toContain('- read_file {"path":"a.ts"}');
  expect(summaryMessage.content).toContain('- bug on line 3 of a.ts');
  expect(summaryMessage.content).not.toContain('x'.repeat(100));
  // The round is sent with the compacted history (system kept first) and measured again.
  expect(sent[0]![0]).toEqual({ role: 'system', content: 'S' }); expect(sent[0]![1]).toEqual(summaryMessage); expect(sent[0]).toHaveLength(10);
  expect(events.filter(event => event.kind === 'context').map(event => event.kind === 'context' && event.promptTokens)).toEqual([threshold.prompt, 1500]);
});

it('keeps the history and sends nothing when the summary call fails, and does not compact below the high-water mark (T-L5b)', async () => {
  const history = [{ role: 'system' as const, content: 'S' }, ...Array.from({ length: 12 }, (_, i) =>
    ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `m${i}`, ...(i % 2 ? { toolCalls: [] } : {}) })),
  { role: 'user' as const, content: 'q' }] as AgentTurnMessage[];
  const failed = ports([answer('never')]), events: AgentTurnEvent[] = [];
  const result = await runAgentTurn({ messages: history, tools, signal: new AbortController().signal, emit: event => events.push(event) },
    { ...failed.value, measure: async () => ({ promptTokens: 9000, windowTokens: 10_000, quality: 'provider-count' }), summarize: async () => null });
  expect(result).toMatchObject({ finish: 'error' }); expect(result.note).toMatch(/9000 of 10000 context tokens and could not be compacted.*history is unchanged/);
  expect(failed.invoked).toEqual([]); expect(events.some(event => event.kind === 'compacted')).toBe(false);
  let calls = 0;
  const calm = ports([answer('ok')]);
  await runAgentTurn({ messages: history, tools, signal: new AbortController().signal, emit: () => undefined },
    { ...calm.value, measure: async () => ({ promptTokens: 7000, windowTokens: 10_000, quality: 'provider-count' }), summarize: async () => { calls++; return null; } });
  expect(calls).toBe(0);
});

it('plans compaction without ever keeping a tool result apart from its call, and preserves long user messages without shortening directives', () => {
  const call = { id: 'c', name: 'grep', argumentsJson: '{}' };
  const history = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'u'.repeat(5000) },
    { role: 'assistant' as const, content: '', toolCalls: [call] }, ...Array.from({ length: 8 }, () => ({ role: 'tool' as const, toolCallId: 'c', name: 'grep', content: 'r' }))];
  const plan = planAgentCompaction(history)!;
  expect(plan.tail[0]).toMatchObject({ role: 'assistant' }); expect(plan.older).toEqual([history[1]]);
  const rendered = renderAgentCompaction(plan, { objective: 'o', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] });
  expect(rendered.content).toContain(`1. ${'u'.repeat(5000)}`);
  expect(rendered.content).not.toContain('[cut: 5000');
  expect(planAgentCompaction(history.slice(0, 3))).toBeNull();
});

it('runs an approval-gated call only on an explicit allow, and gives every other answer a typed result without running it (T-L4)', async () => {
  const gated: AgentTurnPorts['authorize'] = async () => 'require-approval';
  const statuses: string[] = [];
  for (const owner of ['allow', 'deny', 'expired', 'cancelled', 'throws'] as const) {
    const p = ports([answer('', [call('c1', 'read_file', { path: 'a' })]), answer('done')], { decision: gated });
    const asked: unknown[] = [];
    const { events } = await (async () => {
      const events: AgentTurnEvent[] = [];
      await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: event => events.push(event) }, { ...p.value,
        requestApproval: async input => { asked.push(input); if (owner === 'throws') throw new Error('store down'); return owner; } });
      return { events };
    })();
    expect(asked).toEqual([expect.objectContaining({ round: 1, index: 0, target: 'a', argsDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect(p.executed).toEqual(owner === 'allow' ? ['read_file:{"path":"a"}'] : []);
    statuses.push((events.find(event => event.kind === 'tool.finished') as { status: string }).status);
  }
  expect(statuses).toEqual(['ok', 'denied', 'approval-expired', 'cancelled', 'approval-required']);
  // Without an approval port the call stays blocked (no bypass).
  const blocked = ports([answer('', [call('c1', 'read_file', { path: 'a' })]), answer('done')], { decision: gated });
  await run(blocked); expect(blocked.executed).toEqual([]);
});

// Astra 2091 R2 + R3 (inverted repro): a long turn compacted several times holds no copy of earlier tool results, and a read whose
// result left the prompt with a compaction runs again instead of pointing at a result the model can no longer see.
it('keeps a bounded result across repeated compactions and re-runs a read whose result was compacted away (T-L5, Astra 2091)', async () => {
  const summary = { objective: 'inspect', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] };
  const events: AgentTurnEvent[] = [], executed: string[] = [];
  let lastPrompt: readonly AgentTurnMessage[] = [], summaries = 0;
  const result = await runAgentTurn({ messages: [{ role: 'user', content: 'inspect' }], tools, signal: new AbortController().signal, emit: event => events.push(event) }, {
    async measure({ messages }) { return { promptTokens: messages.length > 14 ? 900 : 100, windowTokens: 1000, quality: 'provider-count' }; },
    async summarize() { summaries++; return summary; },
    async invokeRound({ round, messages }) {
      lastPrompt = messages;
      return round === 31 ? answer('done') : answer('', [call(`call-${round}`, 'read_file', { path: round === 30 || round === 2 ? 'file-1' : `file-${round}` })]);
    },
    async authorize() { return 'allow'; }, describe: () => null, now: () => 0,
    async execute(_tool, args) { executed.push(String(args['path'])); return { status: 'ok', text: `SENTINEL-${String(args['path'])}:${'x'.repeat(16_000)}` }; },
  });
  expect(result).toMatchObject({ finish: 'stop', answer: 'done', rounds: 31 });
  expect(summaries).toBeGreaterThanOrEqual(3);
  // file-1 was read in round 1 (and round 2 answered as a same-epoch duplicate); its result was compacted away, so round 30 reads it again.
  expect(executed.filter(path => path === 'file-1')).toHaveLength(2);
  expect(events.find(event => event.kind === 'tool.finished' && event.callId === 'call-2')).toMatchObject({ status: 'duplicate' });
  expect(events.find(event => event.kind === 'tool.finished' && event.callId === 'call-30')).toMatchObject({ status: 'ok' });
  expect(lastPrompt.some(message => message.content.includes('SENTINEL-file-1:'))).toBe(true);
  // The result is counters, a digest and the final answer: no tool content, however long the turn.
  const appended = events.flatMap(event => event.kind === 'message' ? [event.message] : []);
  expect(result.appendedCount).toBe(appended.length);
  expect(result.appendedDigest).toBe(createHash('sha256').update(`agent-turn-appended:1\0${JSON.stringify(appended)}`).digest('hex'));
  expect(JSON.stringify(result)).not.toContain('SENTINEL');
  expect(JSON.stringify(result).length).toBeLessThan(1_000);
});

it('re-runs a read after a successful edit in the same turn, and keeps same-epoch dedupe otherwise (Astra 2091 R3)', async () => {
  const edit: AgentToolSpec = { name: 'write_file', version: 1, toolClass: 'edit', description: 'Write.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } };
  const executed: string[] = [], events: AgentTurnEvent[] = [];
  await runAgentTurn({ messages: user, tools: [readFile, edit], signal: new AbortController().signal, emit: event => events.push(event) }, {
    async invokeRound({ round }) {
      return [answer('', [call('r1', 'read_file', { path: 'a' }), call('r2', 'read_file', { path: 'a' })]), answer('', [call('w1', 'write_file', { path: 'a' })]),
        answer('', [call('r3', 'read_file', { path: 'a' })]), answer('done')][round - 1]!;
    },
    async authorize() { return 'allow'; }, describe: () => null, now: () => 0,
    async execute(tool) { executed.push(tool.name); return { status: 'ok', text: `${tool.name} ok` }; },
  });
  expect(executed).toEqual(['read_file', 'write_file', 'read_file']);
  expect(events.filter(event => event.kind === 'tool.finished').map(event => event.kind === 'tool.finished' && `${event.callId}:${event.status}`))
    .toEqual(['r1:ok', 'r2:duplicate', 'w1:ok', 'r3:ok']);
});

const shellTool: AgentToolSpec = { name: 'run_shell', version: 1, toolClass: 'shell', description: 'Shell.', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } };
async function readsAroundShell(decision: 'allow' | 'deny') {
  const events: AgentTurnEvent[] = [];
  await runAgentTurn({ messages: user, tools: [readFile, shellTool], signal: new AbortController().signal, emit: event => events.push(event) }, {
    async invokeRound({ round }) {
      return [answer('', [call('r1', 'read_file', { path: 'a' }), call('r2', 'read_file', { path: 'a' })]), answer('', [call('s1', 'run_shell', { command: 'sed -i x a && false' })]),
        answer('', [call('r3', 'read_file', { path: 'a' })]), answer('done')][round - 1]!;
    },
    async authorize(tool) { return tool.toolClass === 'shell' ? decision : 'allow'; }, describe: () => null, now: () => 0,
    async execute(tool) { return tool.toolClass === 'shell' ? { status: 'error', text: 'exit 1' } : { status: 'ok', text: `${tool.name} ok` }; },
  });
  return events.filter(event => event.kind === 'tool.finished').map(event => event.kind === 'tool.finished' && `${event.callId}:${event.status}`);
}

it('re-runs a read after a non-read call that executed but ended in error', async () => {
  expect(await readsAroundShell('allow')).toEqual(['r1:ok', 'r2:duplicate', 's1:error', 'r3:ok']);
});

it('keeps read dedupe after a non-read call refused before execution', async () => {
  expect(await readsAroundShell('deny')).toEqual(['r1:ok', 'r2:duplicate', 's1:denied', 'r3:duplicate']);
});

// Astra 2091 R1: the history's byte size is compaction pressure too, so a conversation keeps fitting the service's request bound
// even when the model's window is unknown (no provider count, no configured window).
it('compacts on the request byte bound when the window is unknown, and not without that bound (T-L5, Astra 2091 R1)', async () => {
  const summary = { objective: 'o', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] };
  const run = async (requestMaxBytes?: number, withMeasure = true) => {
    const events: AgentTurnEvent[] = []; let summaries = 0;
    const history: AgentTurnMessage[] = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `turn ${index} ${'y'.repeat(2_000)}`, ...(index % 2 ? { toolCalls: [] } : {}) }) as AgentTurnMessage);
    await runAgentTurn({ messages: [...history, { role: 'user', content: 'next' }], tools, signal: new AbortController().signal, emit: event => events.push(event),
      admission: { outputReserveTokens: 0, safetyReserveTokens: 0, ...(requestMaxBytes ? { requestMaxBytes } : {}) } }, {
      ...(withMeasure ? { async measure() { return { promptTokens: 10, windowTokens: null, quality: 'upper-bound' as const }; } } : {}),
      async summarize() { summaries++; return summary; },
      async invokeRound() { return answer('ok'); },
      async authorize() { return 'allow'; }, describe: () => null, now: () => 0, async execute() { return { status: 'ok', text: '' }; },
    });
    return { summaries, compacted: events.find(event => event.kind === 'compacted') };
  };
  expect(await run()).toMatchObject({ summaries: 0, compacted: undefined });
  const bounded = await run(30_000);
  expect(bounded.summaries).toBe(1);
  expect(Buffer.byteLength(JSON.stringify((bounded.compacted as { messages: unknown[] }).messages))).toBeLessThan(0.75 * 30_000);
  // Bytes need no measurement: without a counter port the bound still compacts.
  expect((await run(30_000, false)).summaries).toBe(1);
});

// Astra 2106 R1 (inverted repro): providers may reuse a call id in every round; read dedupe is bound to the result message itself, so a
// result compacted away is read again even when a later call reused its id.
it('re-reads a compacted-away result even when the provider reuses the same call id every round (Astra 2106 R1)', async () => {
  const events: AgentTurnEvent[] = [], executed: string[] = []; let summaries = 0;
  await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: event => events.push(event) }, {
    async measure({ messages }) { return { promptTokens: messages.length > 14 ? 900 : 100, windowTokens: 1000, quality: 'provider-count' }; },
    async summarize() { summaries++; return { objective: 'inspect', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] }; },
    async invokeRound({ round }) { return round === 31 ? answer('done') : answer('', [call('call_1', 'read_file', { path: round === 30 ? 'file-1' : `file-${round}` })]); },
    async authorize() { return 'allow'; }, describe: () => null, now: () => 0,
    async execute(_tool, args) { executed.push(String(args['path'])); return { status: 'ok', text: `SENTINEL-${String(args['path'])}:${'x'.repeat(100)}` }; },
  });
  expect(summaries).toBeGreaterThan(2);
  expect(executed.filter(path => path === 'file-1')).toHaveLength(2);
  expect(events.filter(event => event.kind === 'tool.finished').at(-1)).toMatchObject({ status: 'ok' });
});

it('gives every executed call its position in the turn, distinct even when the provider reuses a call id across responses (Astra 2113)', async () => {
  const shell: AgentToolSpec = { name: 'run_shell', version: 1, toolClass: 'shell', description: 'Run.', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } };
  const executions: string[] = [];
  const value: AgentTurnPorts = { ...ports([]).value,
    async invokeRound(input) {
      return [answer('', [call('call_1', 'run_shell', { command: 'echo again' })]),
        answer('', [call('call_1', 'run_shell', { command: 'echo again' }), call('call_2', 'run_shell', { command: 'echo again' })]), answer('done')][input.round - 1]!;
    },
    async execute(tool, _args, _signal, callId, execution) { executions.push(`${callId}@${execution.round}.${execution.index}`); return { status: 'ok', text: `${tool.name} ok` }; } };
  const result = await runAgentTurn({ messages: user, tools: [shell], signal: new AbortController().signal, emit: () => undefined }, value);
  expect(result).toMatchObject({ finish: 'stop', toolCalls: 3 });
  expect(executions).toEqual(['call_1@1.0', 'call_1@2.0', 'call_2@2.1']);
});

// Astra 2124 durable marker (CLEANUP-MARK, protocol v15): tool.finished carries the outcome's `cleanup` only for the shell tool
// class; the emission boundary trusts the tool's declared class, not merely whether the outcome happens to carry the field.
it("carries the outcome's cleanup on tool.finished only for the shell tool, dropping it for any other tool class", async () => {
  const shell: AgentToolSpec = { name: 'run_shell', version: 1, toolClass: 'shell', description: 'Run.', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } };
  const value: AgentTurnPorts = { ...ports([]).value,
    async invokeRound(input) {
      return input.round === 1 ? answer('', [call('c1', 'run_shell', { command: 'sleep 5 & echo hi' }), call('c2', 'read_file', { path: 'a' })]) : answer('done');
    },
    // A read tool's outcome carrying `cleanup` (never legitimate) proves the boundary trusts the class, not the outcome shape.
    async execute(tool) { return tool.name === 'run_shell' ? { status: 'ok', text: 'shell ok', cleanup: 'group-ended' } : { status: 'ok', text: 'read ok', cleanup: 'unverified' }; } };
  const events: AgentTurnEvent[] = [];
  await runAgentTurn({ messages: user, tools: [shell, readFile], signal: new AbortController().signal, emit: event => events.push(event) }, value);
  const finished = events.filter(event => event.kind === 'tool.finished');
  expect(finished.find(event => event.kind === 'tool.finished' && event.callId === 'c1')).toMatchObject({ name: 'run_shell', cleanup: 'group-ended' });
  const readFinished = finished.find(event => event.kind === 'tool.finished' && event.callId === 'c2');
  expect(readFinished).toMatchObject({ name: 'read_file', status: 'ok' });
  expect(readFinished).not.toHaveProperty('cleanup');
});

// TL-C (D7): a second consecutive round that made no progress gets one engine note; the turn goes on, there is no limit.
it('adds one [deckent] note after the second consecutive no-progress round and keeps the turn going (no counter, no limit)', async () => {
  const notes = (messages: readonly AgentTurnMessage[]) => messages.filter(message => message.role === 'user' && message.content === AGENT_TURN_NO_PROGRESS_NOTE);
  const seen: number[] = [];
  const p = ports([
    answer('', [call('c1', 'read_file', '{bad')]),
    messages => { seen.push(notes(messages).length); return answer('', [call('c2', 'no_such_tool', {})]); },
    messages => { seen.push(notes(messages).length); expect(messages.at(-1)).toEqual({ role: 'user', content: AGENT_TURN_NO_PROGRESS_NOTE });
      return answer('', [call('c3', 'read_file', { path: 'a' }), call('c4', 'read_file', { path: 'a' }), call('c5', 'grep', '{"x":1}')]); },
    // c3 ran (progress): the streak is reset; the next two no-progress rounds form a new streak.
    messages => { seen.push(notes(messages).length); return answer('', [call('c6', 'read_file', { path: 'a' })]); },
    messages => { seen.push(notes(messages).length); return answer('', [call('c7', 'read_file', '[]')]); },
    messages => { seen.push(notes(messages).length); return answer('', [call('c8', 'read_file', '[]')]); },
    messages => { seen.push(notes(messages).length); return answer('done'); }]);
  const { result, events } = await run(p);
  expect(result).toMatchObject({ finish: 'stop', rounds: 7, note: null, answer: 'done' });
  // Round 2 saw no note (one no-progress round is not a streak); round 3 saw it; the third no-progress round of a streak adds none.
  expect(seen).toEqual([0, 1, 1, 1, 2, 2]);
  expect(AGENT_TURN_NO_PROGRESS_NOTE.startsWith('[deckent] ')).toBe(true); expect(AGENT_TURN_NO_PROGRESS_NOTE).not.toContain('\n');
  // The note is part of the client's history, in order, like every appended message.
  const appended = events.flatMap(event => event.kind === 'message' ? [event.message] : []);
  expect(appended.filter(message => message.role === 'user')).toEqual([{ role: 'user', content: AGENT_TURN_NO_PROGRESS_NOTE }, { role: 'user', content: AGENT_TURN_NO_PROGRESS_NOTE }]);
});

// Owner terminal test 2026-10-07: the note was English in a Turkish conversation; it follows the turn's language (the context notes' rule).
it('writes the no-progress note in the turn language', async () => {
  const p = ports([answer('', [call('c1', 'read_file', '{bad')]), answer('', [call('c2', 'no_such_tool', {})]), answer('done')]);
  const events: AgentTurnEvent[] = [];
  await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: event => events.push(event), language: 'tr' }, p.value);
  const notes = events.flatMap(event => event.kind === 'message' && event.message.role === 'user' ? [event.message.content] : []);
  expect(notes).toEqual([agentTurnNoProgressNote('tr')]);
  expect(notes[0]).toMatch(/^\[deckent\] Son iki turda ilerleme olmadı/u);
  expect(agentTurnNoProgressNote('en')).toBe(AGENT_TURN_NO_PROGRESS_NOTE); expect(agentTurnNoProgressNote('tr')).not.toBe(AGENT_TURN_NO_PROGRESS_NOTE);
});

// Owner terminal test 2026-10-07: grep got an unknown `maxMatches` twice; the refusal now names the arguments the tool takes.
it('names the valid arguments when a call carries an unknown one, and runs nothing', async () => {
  const p = ports([answer('', [call('c1', 'grep', { pattern: 'x', maxMatches: 5 }), call('c2', 'read_file', { path: 'a', limit: 3 })]), answer('done')]);
  const { events } = await run(p);
  const results = events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);
  expect(results).toEqual(['[deckent] grep: error=invalid-arguments (unknown argument "maxMatches"; valid arguments: pattern)',
    '[deckent] read_file: error=invalid-arguments (unknown argument "limit"; valid arguments: path, startLine)']);
  expect(p.executed).toEqual([]);
});

it('never counts a denied call, a round with text, or a cancelled turn as no progress', async () => {
  const decision: AgentTurnPorts['authorize'] = async tool => tool.name === 'grep' ? 'deny' : 'allow';
  const p = ports([answer('', [call('c1', 'read_file', '{bad')]), answer('', [call('c2', 'grep', { pattern: 'x' })]),
    answer('', [call('c3', 'read_file', '{bad')]), answer('Trying another way.', [call('c4', 'read_file', '{bad')]),
    answer('', [call('c5', 'read_file', '{bad')]), answer('done')], { decision });
  const { result, events } = await run(p);
  expect(result).toMatchObject({ finish: 'stop', rounds: 6 });
  expect(events.some(event => event.kind === 'message' && event.message.role === 'user')).toBe(false);
  // A turn cancelled right after a second no-progress round appends no note.
  const controller = new AbortController();
  const cancelled = ports([answer('', [call('c1', 'read_file', '{bad')]), answer('', [call('c2', 'no_such_tool', {})]), answer('never')]);
  // The cancel lands after the second round's call settled as an error, before the note would be appended.
  cancelled.value.settled = async settled => { if (settled.round === 2) controller.abort(); };
  const stopped = await run(cancelled, controller.signal);
  expect(stopped.result).toMatchObject({ finish: 'cancelled' }); expect(cancelled.invoked).toEqual([1, 2]);
  expect(stopped.events.filter(event => event.kind === 'tool.finished').map(event => event.kind === 'tool.finished' && event.status)).toEqual(['invalid-arguments', 'error']);
  expect(stopped.events.some(event => event.kind === 'message' && event.message.role === 'user')).toBe(false);
});

// COMPOSITION-BUDGET-2: both ends of the summary call's protocol live with the compaction contract (moved from the runtime agent turn).
it('writes the summary input newest-first within its byte bound and reads the summary object out of a fenced answer', () => {
  const older: AgentTurnMessage[] = [{ role: 'user', content: 'first question' },
    { role: 'assistant', content: 'x'.repeat(2_100), toolCalls: [call('c1', 'read_file', { path: 'src/a.ts' })] },
    { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'export const a = 1;' }];
  const whole = agentCompactionTranscript(older, 1_000_000);
  expect(whole.split('\n')).toEqual(['[user] first question', `[assistant] ${'x'.repeat(2_000)} …[cut]`, '  → read_file {"path":"src/a.ts"}',
    '[tool result read_file] export const a = 1;']);
  expect(agentCompactionTranscript(older, 40)).toBe('[2 earliest messages omitted from this summary input]\n[tool result read_file] export const a = 1;');
  const summary = { objective: 'o', findings: ['f'], decisions: [], unresolved: [], nextActions: [], inspectedAreas: ['src/a.ts'] };
  expect(parseAgentCompactionSummary(`Here:\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``)).toEqual(summary);
  for (const bad of [null, '', 'no object', '{"objective":1}', '{ not json }']) expect(parseAgentCompactionSummary(bad)).toBeNull();
});

// TERM-FEEDBACK-1 (live turn 975da614): Qwen answered the summary call with every list field as one string; the strict schema
// refused it and the turn ended in `error`. The answer is normalized into the same bounded shape, losing no text.
it('normalizes the live summary answer whose list fields are single strings, keeping all of its text within the bounds', () => {
  const fixture = JSON.parse(readFixture(join(import.meta.dirname, '../../fixtures/agent-turn/compaction-response-975da614.json'), 'utf8')) as { content: string };
  const raw = JSON.parse(fixture.content) as Record<string, string>;
  const summary = parseAgentCompactionSummary(fixture.content);
  expect(summary).not.toBeNull();
  expect(agentCompactionSummarySchema.safeParse(summary).success).toBe(true);
  expect(summary!.objective).toBe(raw['objective']);
  for (const field of ['findings', 'decisions', 'unresolved', 'nextActions', 'inspectedAreas'] as const) {
    // The findings string is longer than one item may be: it is split at a space, never cut.
    expect(summary![field].join(' ').replace(/\s+/g, ' ')).toBe(raw[field]!.replace(/\s+/g, ' ').trim());
  }
  expect(summary!.findings.length).toBeGreaterThan(1);
});

it('fills absent lists, stringifies scalar items, bounds item count and objective length, and still refuses an answer without an objective', () => {
  const many = Array.from({ length: 45 }, (_, i) => `f${i}`);
  const summary = parseAgentCompactionSummary(JSON.stringify({ objective: 'o'.repeat(2_500), findings: many, decisions: [1, true, null, { a: 1 }] }))!;
  expect(summary.decisions).toEqual(['1', 'true', '{"a":1}']);
  expect(summary.unresolved).toEqual([]); expect(summary.nextActions).toEqual([]); expect(summary.inspectedAreas).toEqual([]);
  expect(summary.findings).toHaveLength(40); expect(summary.findings.at(-1)).toBe('[6 more items omitted by Deckent]');
  expect(summary.objective.length).toBeLessThanOrEqual(2_000); expect(summary.objective).toMatch(/…\[cut: 2500 characters, sha256 [0-9a-f]{16}\]$/);
  expect(agentCompactionSummarySchema.safeParse(summary).success).toBe(true);
  for (const bad of ['{"findings":["x"]}', '{"objective":{"x":1}}', '[1,2]']) expect(parseAgentCompactionSummary(bad)).toBeNull();
});

it('compacts mechanically when the summary answer is unreadable: labelled not model-written, the round runs, and the turn says so', async () => {
  const history = [{ role: 'system' as const, content: 'S' }, ...Array.from({ length: 12 }, (_, i) => i % 2
    ? { role: 'assistant' as const, content: `answer ${i} ${'x'.repeat(6_000)}`, toolCalls: [] } : { role: 'user' as const, content: `question ${i}` }),
  { role: 'user' as const, content: 'q' }] as AgentTurnMessage[];
  const sent: (readonly AgentTurnMessage[])[] = [];
  const p = ports([messages => { sent.push(messages); return answer('done'); }]), events: AgentTurnEvent[] = [];
  const result = await runAgentTurn({ messages: history, tools, signal: new AbortController().signal, emit: event => events.push(event) },
    { ...p.value, measure: async input => ({ promptTokens: JSON.stringify(input.messages).length, windowTokens: 40_000, quality: 'provider-count' }),
      summarize: async () => 'unreadable' });
  expect(result).toMatchObject({ finish: 'stop', answer: 'done' });
  expect(result.note).toMatch(/without a model summary/);
  const compacted = events.find(event => event.kind === 'compacted') as Extract<AgentTurnEvent, { kind: 'compacted' }>;
  const excerpt = compacted.messages[0]!.content;
  expect(excerpt).toContain('not written by the model'); expect(excerpt).not.toContain('Summary (model-written)');
  expect(excerpt).toContain('1. question 0'); expect(excerpt).toMatch(/\[assistant\] answer 1 x+ …\[cut: 6009 characters/);
  // The mechanical excerpt relieves the pressure: the next measurement is below the high-water mark.
  expect(JSON.stringify(sent[0]).length).toBeLessThan(40_000 * 0.75);
});

it('closes the turn with a note that says how to go on when the summary call itself failed', async () => {
  const history = [{ role: 'system' as const, content: 'S' }, ...Array.from({ length: 12 }, (_, i) =>
    ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `m${i}`, ...(i % 2 ? { toolCalls: [] } : {}) })),
  { role: 'user' as const, content: 'q' }] as AgentTurnMessage[];
  const failed = ports([answer('never')]);
  const result = await runAgentTurn({ messages: history, tools, signal: new AbortController().signal, emit: () => undefined },
    { ...failed.value, measure: async () => ({ promptTokens: 9000, windowTokens: 10_000, quality: 'provider-count' }), summarize: async () => null });
  expect(result.note).toMatch(/history is unchanged.*Send the message again to retry, or start a new conversation/);
});

// TERM-FEEDBACK-1 (v4): the owner asked the model who it is and it could not say; it also read other conversations it was pointed at.
it('names the running model from its catalog reference and tells the model that Deckent state is protected, without naming its paths (v4)', () => {
  const layout = resolveProductLayout({ projectRoot: '/p', root: '/p/.deckent/live-data' });
  const prompt = renderAgentTurnSystemPrompt({ projectRoot: '/p', layout, tools: [readFile],
    model: { providerId: 'vllm-local', providerVersion: 2, modelId: 'qwen', modelVersion: 3, nativeId: 'Qwen/Qwen3-Coder' }, language: 'en' });
  expect(AGENT_TURN_SYSTEM_PROMPT_VERSION).toBe(9); expect(prompt.startsWith('[Deckent runtime instructions v9]')).toBe(true);
  expect(prompt).toContain(`Running Deckent: ${PACKAGE_VERSION}; channel: alpha.`);
  expect(prompt).toContain('A project checkout may be a different revision');
  expect(prompt).toContain('- Model: you are Qwen/Qwen3-Coder (Deckent catalog: provider vllm-local v2, model qwen v3), running inside Deckent.');
  expect(prompt).toMatch(/When asked who or which model you are, answer with this/);
  expect(prompt).toMatch(/ledger, saved conversations and history, logs, the runtime socket, approvals[^\n]*are protected/);
  expect(prompt).not.toMatch(/terminal-sessions|ledger\.db/); expect(prompt).toContain('Deckent configuration: .deckent/config.json (readable)');
});

// LANG-CRASH (live session 1d428e9f, owner: "tamamen Türkçe iletişim istiyorum, ihlal edilemez"): the local model answered several turns in
// English after a Turkish question. The service prompt (v5) names the person's reply language explicitly, first and as its last line, and
// the compaction instruction writes the summary in that language instead of "the language of the conversation" (which carried the drift).
it('states the reply language of the locale first and last (v5); the compaction instruction keeps it', () => {
  const layout = resolveProductLayout({ projectRoot: '/p', root: '/p/.deckent/live-data' });
  const model = { providerId: 'vllm-local', providerVersion: 2, modelId: 'qwen', modelVersion: 3, nativeId: 'Qwen/Qwen3-Coder' };
  const render = (language: 'en' | 'tr', withTools: boolean) => renderAgentTurnSystemPrompt({ projectRoot: '/p', layout, tools: withTools ? [readFile] : [], model, language });
  for (const withTools of [true, false]) {
    const tr = render('tr', withTools).split('\n'), en = render('en', withTools).split('\n');
    expect(tr[3]).toBe('- Reply language: Turkish (Türkçe). Always answer the user in Turkish (Türkçe): every answer, progress line, question and summary,'
      + ' even when files, tool results, earlier messages or these instructions are in another language. Code, paths, commands, identifiers and'
      + ' quoted output stay as written.');
    expect(tr.at(-1)).toBe('- Write every reply to the user in Turkish (Türkçe).');
    expect(en[3]).toMatch(/^- Reply language: English\. Always answer the user in English: /); expect(en.at(-1)).toBe('- Write every reply to the user in English.');
    expect(en.join('\n')).not.toMatch(/Türkçe|Turkish/);
    // Deterministic, and the only difference between the locales is the language itself (the request digest binds the rendered text).
    expect(render('tr', withTools)).toBe(tr.join('\n'));
    expect(tr.join('\n').replaceAll('Turkish (Türkçe)', 'English')).toBe(en.join('\n'));
  }
  expect(AGENT_TURN_REPLY_LANGUAGES).toEqual({ en: 'English', tr: 'Turkish (Türkçe)' });
  expect(agentCompactionInstruction('tr')).toMatch(/Write every string in Turkish \(Türkçe\); paths, code, commands and identifiers stay as written\.$/);
  expect(agentCompactionInstruction('en')).toMatch(/Write every string in English; /);
  expect(agentCompactionInstruction('tr')).not.toContain('language of the conversation');
});

// PROMPT-POSTURE (live 2026-09-30: a full-access model refused `curl` "by policy" because the v5 prompt said "Network access: none" whenever
// fetch_url was absent). v6 keeps fetch_url and the shell apart: the shell note states the posture composition resolved for the turn.
it('states the shell posture it is given, separately from fetch_url (v6)', () => {
  const layout = resolveProductLayout({ projectRoot: '/p', root: '/p/.deckent/live-data' });
  const model = { providerId: 'vllm-local', providerVersion: 2, modelId: 'qwen', modelVersion: 3, nativeId: 'Qwen/Qwen3-Coder' };
  const shell: AgentToolSpec = { name: 'run_shell', version: 1, toolClass: 'shell', description: 'Run.', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } };
  const fetchLine = '- Network: fetch_url fetches one https:// URL (GET, no credentials). Allowlisted hosts (docs.example) run at once; any other host is refused.';
  const noNetwork = '- Network access: none. This installation allows no fetching: do not guess what a web page says, and do not try to reach the network another way.';
  const render = (posture: Parameters<typeof renderAgentTurnSystemPrompt>[0]['shell'], fetch = false) => renderAgentTurnSystemPrompt({ projectRoot: '/p', layout,
    tools: [readFile, shell], model, language: 'en', shell: posture, ...(fetch ? { network: { allowedHosts: ['docs.example'], others: 'refused' as const } } : {}) });
  const shellLine = (prompt: string) => prompt.split('\n').find(line => line.startsWith('- Shell tool: run_shell.'))!;
  expect(AGENT_TURN_SYSTEM_PROMPT_VERSION).toBe(9);

  const open = render({ kind: 'sandbox', realm: 'bubblewrap', open: true, configuration: 'owner-approved' });
  expect(open.startsWith('[Deckent runtime instructions v9]')).toBe(true);
  expect(shellLine(open)).toBe('- Shell tool: run_shell. It runs in the project root in an open bubblewrap sandbox (full access): shell commands have network access'
    + ' (for example curl, git fetch, npm install), your real home directory (HOME) is visible and writable, and the project and its .git are writable.'
    + ' Deckent\'s own state, policy and credential files stay sealed: they are hidden or read-only, and a write to them fails. Its configuration file is'
    + ' read-only unless the owner approves the call: an approved call can change its existing content.');
  // Astra 2192 R9: the configuration's rule is the posture's, not a fixed sentence (a floor no card opens would say so).
  expect(shellLine(render({ kind: 'sandbox', realm: 'bubblewrap', open: true, configuration: 'read-only' })))
    .toMatch(/stay sealed: they are hidden or read-only, and a write to them fails\. Its configuration file is read-only in every call\.$/u);
  expect(open).toContain('- Network: fetch_url is not offered (this installation configures no fetching); shell commands do have network access in this turn'
    + ' (see the shell tool). Do not guess what a web page says.');
  expect(open).not.toContain('Network access: none'); expect(open).not.toContain('do not try to reach the network');

  const closed = render({ kind: 'sandbox', realm: 'landlock', open: false });
  expect(shellLine(closed)).toBe('- Shell tool: run_shell. It runs in the project root in a closed landlock sandbox: shell commands have no network access and your'
    + ' home directory is hidden; what a command may write is decided per call by policy and the permission mode.');
  expect(closed).toContain(noNetwork);

  const host = render({ kind: 'host' });
  expect(shellLine(host)).toBe('- Shell tool: run_shell. It runs in the project root directly on the user\'s machine, not in a sandbox: files, processes and the network'
    + ' are reachable as the user; Deckent\'s own state is protected by name only.');
  expect(host).not.toContain('Network access: none');
  expect(shellLine(render({ kind: 'unavailable' }))).toBe('- Shell tool: run_shell. It cannot run commands here: no shell realm the configuration permits is usable'
    + ' on this machine, so every call is refused.');
  expect(render({ kind: 'unavailable' })).toContain(noNetwork);

  // fetch_url configured: its line is the same whatever the shell posture; only the shell note differs.
  for (const posture of [{ kind: 'sandbox', realm: 'bubblewrap', open: true, configuration: 'owner-approved' }, { kind: 'sandbox', realm: 'bubblewrap', open: false },
    { kind: 'host' }] as const) {
    const withFetch = render(posture, true);
    expect(withFetch).toContain(fetchLine); expect(withFetch).not.toContain('Network access: none'); expect(withFetch).not.toContain('fetch_url is not offered');
  }
  // No shell posture (no shell tool offered): the v5 no-network line and the plain shell note.
  const plain = renderAgentTurnSystemPrompt({ projectRoot: '/p', layout, tools: [readFile], model, language: 'en' });
  expect(plain).toContain(noNetwork);
});

// TRUNCATED-TOOLCALL (live 2026-09-30, 18:12–18:18 UTC): with maxCompletionTokens 8192 the local model cut large write_file / run_shell
// arguments at exactly 8192 completion tokens five times; vLLM v0.30.0 streams such a round as finish_reason "tool_calls" (its metrics say
// "length"). The completion count at the requested limit, or finish_reason "length", marks the round truncated: none of its calls runs, the
// model is told to split, and the turn's note says so. Provider-neutral: the loop reads only the round's usage and finish.
const writeFile: AgentToolSpec = { name: 'write_file', version: 1, toolClass: 'edit', description: 'Write.',
  inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } };
const cut = (toolCalls: ReturnType<typeof call>[], completionTokens: number | null, finish = 'tool_calls'): AgentRoundOutcome =>
  ({ status: 'responded', content: '', reasoning: '', toolCalls, finish, usage: completionTokens === null ? null : { promptTokens: 10, completionTokens } });
async function limited(p: ReturnType<typeof ports>, completionLimitTokens = 8192) {
  const events: AgentTurnEvent[] = [];
  const result = await runAgentTurn({ messages: user, tools: [...tools, writeFile], signal: new AbortController().signal, emit: event => events.push(event),
    admission: { outputReserveTokens: completionLimitTokens, safetyReserveTokens: 2048, completionLimitTokens } }, p.value);
  return { result, events, toolResults: events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []) };
}

it('never runs a tool call of a round that reached the completion limit, even when its arguments are valid JSON, and tells the model to split (TRUNCATED-TOOLCALL a)', async () => {
  // The dangerous shape: a parser that closes the JSON would hand over half a document as a valid call (vLLM PR #53739 terminates it).
  const half = call('c1', 'write_file', { path: 'docs/plan.md', content: '# Plan\n\n1. first step\n2. seco' });
  const p = ports([cut([half], 8192), answer('Split it.')]);
  const { result, events, toolResults } = await limited(p);
  expect(p.executed).toEqual([]); expect(p.authorized).toEqual([]);
  expect(result).toMatchObject({ finish: 'stop', rounds: 2, toolCalls: 0 });
  expect(events.filter(event => event.kind === 'tool.started' || event.kind === 'tool.finished').map(({ kind, ...rest }) => [kind, (rest as { status?: string }).status ?? null]))
    .toEqual([['tool.started', null], ['tool.finished', 'invalid-arguments']]);
  expect(events.find(event => event.kind === 'tool.started')).toMatchObject({ callId: 'c1', name: 'write_file', target: null });
  expect(toolResults).toEqual([expect.stringMatching(/^\[deckent\] write_file: error=output-limit \(this answer reached the output limit of 8192 tokens while writing the call, so its arguments are incomplete; nothing ran\)/)]);
  expect(toolResults[0]).toMatch(/Do not send the same call again\. Write large content in parts/);
  expect(result.note).toMatch(/1 tool call was cut at the model's output limit \(8192 tokens\) and not run/);
  // The unterminated shape vLLM v0.30.0 streams today gets the same answer, not the generic JSON error.
  const open = ports([cut([call('c1', 'write_file', '{"path": "docs/plan.md", "content": "# Plan\\n\\n1. fir')], 8192), answer('ok')]);
  const second = await limited(open);
  expect(open.executed).toEqual([]); expect(second.toolResults[0]).toMatch(/error=output-limit/); expect(second.toolResults[0]).not.toMatch(/not valid JSON/);
  // finish_reason "length" alone (a provider that reports it honestly, or no usage) marks the round too; every call of the round is refused.
  const honest = ports([cut([call('c1', 'read_file', { path: 'a' }), call('c2', 'write_file', { path: 'b', content: 'x' })], null, 'length'), answer('ok')]);
  const third = await limited(honest);
  expect(honest.executed).toEqual([]); expect(third.toolResults).toHaveLength(2); expect(third.result.note).toMatch(/2 tool calls were cut/);
});

it('runs a tool call below the completion limit, and keeps a plain text answer cut by length as it was (TRUNCATED-TOOLCALL b, c)', async () => {
  const below = ports([cut([call('c1', 'write_file', { path: 'b.md', content: 'whole' })], 8191), answer('Written.')]);
  const { result } = await limited(below);
  expect(below.executed).toEqual(['write_file:{"path":"b.md","content":"whole"}']); expect(result).toMatchObject({ finish: 'stop', toolCalls: 1, note: null });
  const text = ports([{ status: 'responded', content: 'A long answer that was cut', reasoning: '', toolCalls: [], finish: 'length', usage: { promptTokens: 1, completionTokens: 8192 } }]);
  const plain = await limited(text);
  expect(plain.result).toMatchObject({ finish: 'length', rounds: 1, note: null, answer: 'A long answer that was cut' });
  // Without a known limit (no admission) only finish_reason "length" can mark a round; a full count alone is not guessed.
  const unknown = ports([cut([call('c1', 'read_file', { path: 'a' })], 8192), answer('ok')]);
  await run(unknown); expect(unknown.executed).toEqual(['read_file:{"path":"a"}']);
});

it('counts truncated rounds as no progress, so a repeated oversize call gets the no-progress note (TRUNCATED-TOOLCALL)', async () => {
  const big = () => cut([call('c1', 'write_file', { path: 'docs/plan.md', content: 'y'.repeat(100) })], 8192);
  const p = ports([big(), big(), answer('I will split it.')]);
  const { result, events } = await limited(p);
  expect(p.executed).toEqual([]); expect(result).toMatchObject({ finish: 'stop', rounds: 3 });
  expect(events.some(event => event.kind === 'message' && event.message.role === 'user' && event.message.content === AGENT_TURN_NO_PROGRESS_NOTE)).toBe(true);
  expect(result.note).toMatch(/2 tool calls were cut/);
});

it('tells the model its per-answer output limit and how to write large content in parts, only when an edit tool is offered (v7)', () => {
  const layout = resolveProductLayout({ projectRoot: '/p', root: '/p/.deckent/live-data' });
  const model = { providerId: 'vllm-local', providerVersion: 2, modelId: 'qwen', modelVersion: 3, nativeId: 'Qwen/Qwen3-Coder' };
  const spec = (name: string, toolClass: AgentToolSpec['toolClass']): AgentToolSpec => ({ name, version: 1, toolClass, description: name,
    inputSchema: { type: 'object', required: [], properties: {} } });
  const render = (names: [string, AgentToolSpec['toolClass']][], outputLimitTokens?: number) => renderAgentTurnSystemPrompt({ projectRoot: '/p', layout,
    tools: names.map(([name, toolClass]) => spec(name, toolClass)), model, language: 'tr', ...(outputLimitTokens ? { outputLimitTokens } : {}) }).split('\n');
  const rule = (lines: string[]) => lines.find(line => line.startsWith('- One answer, tool call arguments included'));
  const all = render([['read_file', 'read'], ['edit_file', 'edit'], ['write_file', 'edit'], ['run_shell', 'shell'], ['scratch_write', 'edit']], 8192);
  expect(rule(all)).toBe('- One answer, tool call arguments included, may use at most 8192 output tokens; a call cut at that limit is refused and nothing runs.'
    + ' Write large content in parts: create the file with its first part, then add each next part with edit_file (old_string = the current last lines),'
    + ' or write the parts with scratch_write and join them with one run_shell command.');
  expect(all.at(-1)).toBe('- Write every reply to the user in Turkish (Türkçe).');
  expect(rule(render([['write_file', 'edit']], 16384))).toMatch(/at most 16384 output tokens; .*current last lines\)\.$/);
  expect(rule(render([['write_file', 'edit']]))).toMatch(/at most a limited number of output tokens;/);
  expect(rule(render([['read_file', 'read']], 8192))).toBeUndefined();
});

it('keeps the text streamed before a cancellation in the history, ending with the cancelled-mid-answer line', async () => {
  const controller = new AbortController();
  const p = ports([]);
  p.value.invokeRound = async (_input, onDelta, signal) => {
    onDelta({ kind: 'text', text: 'Hel' }); onDelta({ kind: 'text', text: 'lo' });
    controller.abort();
    return signal.aborted ? { status: 'failed', state: 'cancelled' } : answer('x');
  };
  const { result, events } = await run(p, controller.signal);
  expect(result).toMatchObject({ finish: 'cancelled', appendedCount: 1 });
  const appended = events.flatMap(event => event.kind === 'message' ? [event.message] : []);
  expect(appended).toHaveLength(1);
  expect(appended[0]).toMatchObject({ role: 'assistant', toolCalls: [] });
  const content = appended[0]!.content;
  expect(content.startsWith('Hello')).toBe(true);
  expect(content.split('\n').at(-1)).toBe('[deckent] cancelled mid-answer');
});

it('appends no assistant message for a round cancelled before any text streamed', async () => {
  const controller = new AbortController();
  const p = ports([]);
  p.value.invokeRound = async () => { controller.abort(); return { status: 'failed', state: 'cancelled' }; };
  const { result, events } = await run(p, controller.signal);
  expect(result).toMatchObject({ finish: 'cancelled', appendedCount: 0 });
  expect(events.some(event => event.kind === 'message')).toBe(false);
});
