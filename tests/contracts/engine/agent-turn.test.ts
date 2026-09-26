import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { planAgentCompaction, renderAgentCompaction, runAgentTurn, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';
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
  expect(refused.note).toMatch(/1900 prompt tokens \(upper bound\) \+ 6144 reserved > 8000.*Nothing was sent/);
  // An unknown window or a failed measurement never blocks a round: the provider stays the arbiter.
  const unknown = ports([answer('ok')]);
  expect(await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: () => undefined },
    { ...unknown.value, measure: async () => ({ promptTokens: 10 ** 9, windowTokens: null, quality: 'upper-bound' }) })).toMatchObject({ finish: 'stop' });
  const failing = ports([answer('ok')]);
  expect(await runAgentTurn({ messages: user, tools, signal: new AbortController().signal, emit: () => undefined },
    { ...failing.value, measure: async () => { throw new Error('counter down'); } })).toMatchObject({ finish: 'stop' });
});

it('compacts past the high-water mark: older messages become one labelled summary with the user messages and tool calls copied, then the round runs (T-L5b)', async () => {
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
    admission: { outputReserveTokens: 1000, safetyReserveTokens: 0 } }, { ...p.value,
    measure: async () => ({ promptTokens: measures++ === 0 ? 7000 : 1500, windowTokens: 10_000, quality: 'provider-count' }),
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
  expect(events.filter(event => event.kind === 'context').map(event => event.kind === 'context' && event.promptTokens)).toEqual([7000, 1500]);
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

it('plans compaction without ever keeping a tool result apart from its call, and renders long user messages cut with a digest', () => {
  const call = { id: 'c', name: 'grep', argumentsJson: '{}' };
  const history = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'u'.repeat(5000) },
    { role: 'assistant' as const, content: '', toolCalls: [call] }, ...Array.from({ length: 8 }, () => ({ role: 'tool' as const, toolCallId: 'c', name: 'grep', content: 'r' }))];
  const plan = planAgentCompaction(history)!;
  expect(plan.tail[0]).toMatchObject({ role: 'assistant' }); expect(plan.older).toEqual([history[1]]);
  const rendered = renderAgentCompaction(plan, { objective: 'o', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] });
  expect(rendered.content).toMatch(/1\. u{4000} …\[cut: 5000 characters, sha256 [0-9a-f]{16}\]/);
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

// Astra 2091 R1: the history's byte size is compaction pressure too, so a conversation keeps fitting the service's request bound
// even when the model's window is unknown (no provider count, no configured window).
it('compacts on the request byte bound when the window is unknown, and not without that bound (T-L5, Astra 2091 R1)', async () => {
  const summary = { objective: 'o', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] };
  const run = async (requestMaxBytes?: number) => {
    const events: AgentTurnEvent[] = []; let summaries = 0;
    const history: AgentTurnMessage[] = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `turn ${index} ${'y'.repeat(2_000)}`, ...(index % 2 ? { toolCalls: [] } : {}) }) as AgentTurnMessage);
    await runAgentTurn({ messages: [...history, { role: 'user', content: 'next' }], tools, signal: new AbortController().signal, emit: event => events.push(event),
      admission: { outputReserveTokens: 0, safetyReserveTokens: 0, ...(requestMaxBytes ? { requestMaxBytes } : {}) } }, {
      async measure() { return { promptTokens: 10, windowTokens: null, quality: 'upper-bound' }; },
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
});
