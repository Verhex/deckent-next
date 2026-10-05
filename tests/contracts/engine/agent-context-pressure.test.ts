import { expect, it, vi } from 'vitest';
import type { AgentToolSpec, AgentTurnEvent, AgentTurnMessage } from '#domain/index.js';
import { createAgentCompactionGuard, runAgentTurn, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';

const answer = (content = 'done'): AgentRoundOutcome => ({ status: 'responded', content, reasoning: '', toolCalls: [], finish: 'stop', usage: null });
const tool: AgentToolSpec = { name: 'read', version: 1, description: 'read', toolClass: 'read',
  inputSchema: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'] } };
const history = (): AgentTurnMessage[] => [{ role: 'user', content: 'Keep the original directive.' },
  ...Array.from({ length: 8 }, () => ({ role: 'assistant' as const, content: 'tail', toolCalls: [] }))];
function ports(overrides: Partial<AgentTurnPorts> = {}): AgentTurnPorts {
  return { invokeRound: async () => answer(), authorize: async () => 'allow', execute: async () => ({ status: 'ok', text: 'result' }),
    describe: () => null, now: () => 0, ...overrides };
}

it('does not bill another summary for a non-shrinking retained tail, but retries after that tail has moved on', async () => {
  let currentRound = 0;
  const summarizedAt: number[] = [], sent: string[] = [], events: AgentTurnEvent[] = [];
  const result = await runAgentTurn({ messages: history(), tools: [tool], signal: new AbortController().signal, emit: event => events.push(event) }, ports({
    measure: async ({ round }) => { currentRound = round; return { promptTokens: 800, windowTokens: 1_000, quality: 'provider-count' }; },
    summarize: async () => { summarizedAt.push(currentRound); return { objective: 's'.repeat(2_000), findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] }; },
    invokeRound: async ({ round, messages }) => {
      sent.push(JSON.stringify(messages));
      return round === 5 ? answer() : { ...answer(''), toolCalls: [{ id: `call-${round}`, name: tool.name, argumentsJson: JSON.stringify({ step: round }) }] };
    },
  }));
  expect(result).toMatchObject({ finish: 'stop', rounds: 5, toolCalls: 4 });
  expect(summarizedAt).toEqual([1, 5]);
  expect(events.filter(event => event.kind === 'compacted')).toHaveLength(2);
  expect(sent.every(request => request.includes('Keep the original directive.'))).toBe(true);
});

it('never summarizes only the summary again, including after a decoded wire replacement', () => {
  const guard = createAgentCompactionGuard(), before = history();
  const after: AgentTurnMessage[] = JSON.parse(JSON.stringify([{ role: 'user', content: 'summary'.repeat(300) }, ...before.slice(1)]));
  guard.applied(before, after);
  expect(guard.plan(after)).toBeNull();
  // Two new records do not displace the whole stalled tail, even though the older part now contains original data too.
  expect(guard.plan([...after, { role: 'assistant', content: 'new', toolCalls: [] }, { role: 'user', content: 'next' }])).toBeNull();
});

it.each(['🙂漢字İ', '\u0000"\\', 'long-ascii'] as const)('refuses an indivisible oversized request using JSON UTF-8 bytes: %j', async text => {
  const messages: AgentTurnMessage[] = [{ role: 'user', content: text.repeat(200) }];
  const before = JSON.stringify(messages), invokeRound = vi.fn(async () => answer()), summarize = vi.fn(async () => 'unreadable' as const);
  const result = await runAgentTurn({ messages, tools: [], signal: new AbortController().signal, emit: () => undefined,
    admission: { outputReserveTokens: 0, safetyReserveTokens: 0, requestMaxBytes: 1_000 } }, ports({ invokeRound, summarize }));
  expect(result).toMatchObject({ finish: 'error', appendedCount: 0 });
  expect(result.note).toContain('AGENT_CONTEXT_REQUEST_TOO_LARGE');
  expect(invokeRound).not.toHaveBeenCalled(); expect(summarize).not.toHaveBeenCalled();
  expect(JSON.stringify(messages)).toBe(before);
});

it('names actual answer overflow instead of relying on the completion-token byte estimate or silently cutting Unicode', async () => {
  const content = '🙂漢字'.repeat(300), events: AgentTurnEvent[] = [];
  const result = await runAgentTurn({ messages: [{ role: 'user', content: 'question' }], tools: [], signal: new AbortController().signal,
    emit: event => events.push(event), admission: { outputReserveTokens: 0, safetyReserveTokens: 0, requestMaxBytes: 1_000 } }, ports({
    invokeRound: async () => answer(content),
  }));
  expect(result).toMatchObject({ finish: 'error', answer: content, appendedCount: 1 });
  expect(result.note).toContain('AGENT_CONTEXT_REQUEST_TOO_LARGE');
  expect(events.filter(event => event.kind === 'message')).toEqual([{ kind: 'message', message: { role: 'assistant', content, toolCalls: [] } }]);
});

it('still refuses the context window after a skipped compaction instead of sending an overflowing round', async () => {
  const invokeRound = vi.fn(async () => ({ ...answer(''), toolCalls: [{ id: 'call', name: tool.name, argumentsJson: '{"step":1}' }] }));
  const summarize = vi.fn(async () => 'unreadable' as const);
  const result = await runAgentTurn({ messages: history(), tools: [tool], signal: new AbortController().signal, emit: () => undefined }, ports({
    summarize, invokeRound, measure: async ({ round }) => ({ promptTokens: round === 1 ? 800 : 1_001, windowTokens: 1_000, quality: 'provider-count' }),
  }));
  expect(result.finish).toBe('error'); expect(result.note).toContain('AGENT_CONTEXT_WINDOW_EXCEEDED');
  expect(invokeRound).toHaveBeenCalledTimes(1); expect(summarize).toHaveBeenCalledTimes(1);
});

it('keeps a large Unicode tool result but refuses the next round before it can overflow, without repeating the tool', async () => {
  const content = '🙂漢字'.repeat(500), events: AgentTurnEvent[] = [];
  const invokeRound = vi.fn(async () => ({ ...answer(''), toolCalls: [{ id: 'call', name: tool.name, argumentsJson: '{"step":1}' }] }));
  const execute = vi.fn(async () => ({ status: 'ok' as const, text: content }));
  const result = await runAgentTurn({ messages: [{ role: 'user', content: 'read' }], tools: [tool], signal: new AbortController().signal,
    emit: event => events.push(event), admission: { outputReserveTokens: 0, safetyReserveTokens: 0, requestMaxBytes: 1_000 } }, ports({ invokeRound, execute }));
  expect(result).toMatchObject({ finish: 'error', toolCalls: 1, rounds: 2 });
  expect(result.note).toContain('AGENT_CONTEXT_REQUEST_TOO_LARGE');
  expect(invokeRound).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
  expect(events.filter(event => event.kind === 'message').at(-1)).toEqual({ kind: 'message', message: { role: 'tool', toolCallId: 'call', name: tool.name, content } });
});
