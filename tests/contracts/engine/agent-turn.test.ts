import { expect, it } from 'vitest';
import { runAgentTurn, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';
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
  expect(result.appended.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
  // The client's history is exactly the message events, in order.
  expect(events.flatMap(event => event.kind === 'message' ? [event.message] : [])).toEqual(result.appended);
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
