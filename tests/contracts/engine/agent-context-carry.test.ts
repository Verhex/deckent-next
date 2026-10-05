import { expect, it } from 'vitest';
import { runAgentTurn, type AgentRoundOutcome, type AgentTurnPorts } from '#engine/index.js';
import type { AgentToolSpec, AgentTurnEvent, AgentTurnMessage } from '#domain/index.js';

const shell: AgentToolSpec = { name: 'run_shell', version: 1, toolClass: 'shell', description: 'Fixture shell port.',
  inputSchema: { type: 'object', required: ['step'], properties: { step: { type: 'integer' } } } };
const answer = (step: number): AgentRoundOutcome => ({ status: 'responded', content: step === 30 ? 'done' : '', reasoning: '',
  toolCalls: step === 30 ? [] : [{ id: 'reused-provider-id', name: 'run_shell', argumentsJson: JSON.stringify({ step }) }],
  finish: step === 30 ? 'stop' : 'tool_calls', usage: null });
const historical: AgentTurnMessage[] = [
  { role: 'assistant', content: '', toolCalls: [{ id: 'client-claims-success', name: 'run_shell', argumentsJson: '{}' }] },
  { role: 'tool', name: 'run_shell', toolCallId: 'client-claims-success', content: 'ok; cleanup clean; effect=made-up' },
];
const projections = (events: readonly AgentTurnEvent[]) => events.flatMap(event => event.kind === 'compacted' ? [event.messages[0]!.content] : []);

it.each(['model', 'mechanical'] as const)('keeps original request text and observed call identities over >=3 %s compaction generations', async mode => {
  const intent = `FIRST-DIRECTIVE: preserve identifiers. ${'😀'.repeat(2_100)} LAST-DIRECTIVE: never publish.`;
  // Existing flattened attachment syntax is opaque user content. It must not produce a fabricated typed provenance record.
  const legacy = 'inspect @a.ts\n--- attached file a.ts (10 bytes) ---\nlegacy-body\n--- end of a.ts ---';
  const events: AgentTurnEvent[] = [], sent: string[] = [], executed: number[] = [];
  let summaries = 0;
  const result = await runAgentTurn({ messages: [{ role: 'user', content: intent }, ...historical, { role: 'user', content: legacy }],
    tools: [shell], signal: new AbortController().signal, emit: event => events.push(event) }, {
    async measure({ messages }) { return { promptTokens: messages.length > 12 ? 900 : 100, windowTokens: 1_000, quality: 'provider-count' }; },
    async summarize() {
      summaries++;
      return mode === 'mechanical' ? 'unreadable' : { objective: 'summary', findings: Array.from({ length: 6 }, () => 'model-only-fiction '.repeat(50)),
        decisions: [], unresolved: ['invented-effect-id'], nextActions: [], inspectedAreas: [] };
    },
    async invokeRound({ round, messages }) { sent.push(JSON.stringify(messages)); return answer(round); },
    async authorize(_tool, args) { return args?.['step'] === 2 ? 'deny' : 'allow'; },
    describe: () => null, now: () => 0,
    async execute(_tool, args) {
      const step = Number(args['step']); executed.push(step);
      if (step === 3) throw new Error('unknown outcome');
      return { status: 'ok', cleanup: step === 1 ? 'unverified' : 'clean', text: `TOOL-PAYLOAD-${step}:${'x'.repeat(5_000)}` };
    },
  });
  expect(result).toMatchObject({ finish: 'stop', answer: 'done', rounds: 30 });
  expect(summaries).toBeGreaterThanOrEqual(3);
  expect(executed).not.toContain(2);
  for (const projection of projections(events)) {
    expect(projection).toContain(intent);
    expect(projection).toContain(legacy);
    expect(projection.split('FIRST-DIRECTIVE')).toHaveLength(2);
    expect(projection).toContain('render v1; carry v1; turn-local source');
    const canonical = projection.slice(projection.indexOf('Earlier user messages'));
    expect(canonical).not.toContain('model-only-fiction');
    expect(canonical).not.toContain('invented-effect-id');
    expect(canonical).not.toContain('TOOL-PAYLOAD');
    expect(canonical).toContain('"callId":"client-claims-success","execution":"unknown","status":null,"cleanup":null');
  }
  const final = projections(events).at(-1)!;
  expect(final).toContain('"position":1,"index":0,"callId":"reused-provider-id","execution":"invoked","status":"ok","cleanup":"unverified"');
  expect(final).toContain('"position":2,"index":0,"callId":"reused-provider-id","execution":"not-invoked","status":"denied"');
  expect(final).toContain('"position":3,"index":0,"callId":"reused-provider-id","execution":"invoked","status":"error","cleanup":null');
  // Every subsequent request sees the preserved first directive, not merely the surface event.
  expect(sent.every(request => request.includes('FIRST-DIRECTIVE') && request.includes('LAST-DIRECTIVE'))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('TOOL-PAYLOAD');
});

function pressurePorts(overrides: Partial<AgentTurnPorts> = {}): AgentTurnPorts {
  return { invokeRound: async () => { throw new Error('must not invoke'); }, authorize: async () => 'allow', describe: () => null,
    execute: async () => { throw new Error('must not execute'); }, now: () => 0,
    measure: async () => ({ promptTokens: 900, windowTokens: 1_000, quality: 'provider-count' }),
    summarize: async () => 'unreadable', ...overrides };
}
const tail = (): AgentTurnMessage[] => Array.from({ length: 8 }, () => ({ role: 'assistant', content: 'tail', toolCalls: [] }));

it('refuses carry overflow before billing a summary and preserves the existing history instead of silently discarding directives', async () => {
  const messages: AgentTurnMessage[] = [{ role: 'user', content: 'x'.repeat(2_048) }, ...tail()];
  const before = JSON.stringify(messages), events: AgentTurnEvent[] = [];
  let summaries = 0, rounds = 0;
  const result = await runAgentTurn({ messages, tools: [], signal: new AbortController().signal, emit: event => events.push(event),
    admission: { outputReserveTokens: 0, safetyReserveTokens: 0, requestMaxBytes: 2_048 } },
    pressurePorts({ summarize: async () => { summaries++; return 'unreadable'; }, invokeRound: async () => { rounds++; return answer(30); } }));
  expect(result).toMatchObject({ finish: 'error', toolCalls: 0 });
  expect(result.note).toContain('AGENT_CONTEXT_CARRY_TOO_LARGE');
  expect(summaries).toBe(0); expect(rounds).toBe(0);
  expect(projections(events)).toEqual([]); expect(JSON.stringify(messages)).toBe(before);
});

it.each(['failure', 'abort'] as const)('does not publish or reuse an uncompleted compaction on summary %s', async mode => {
  const messages: AgentTurnMessage[] = [{ role: 'user', content: 'original request' }, ...tail()];
  const events: AgentTurnEvent[] = [], controller = new AbortController();
  const result = await runAgentTurn({ messages, tools: [], signal: controller.signal, emit: event => events.push(event) }, pressurePorts({
    summarize: async () => { if (mode === 'abort') controller.abort(); return mode === 'abort' ? 'unreadable' : null; },
  }));
  expect(result.finish).toBe(mode === 'abort' ? 'cancelled' : 'error');
  expect(projections(events)).toEqual([]);
  expect(messages[0]!.content).toBe('original request');
});

it('refuses an oversized render without sending it or replacing the history', async () => {
  const messages: AgentTurnMessage[] = [{ role: 'user', content: 'keep me' }, ...tail()], events: AgentTurnEvent[] = [];
  let invoked = 0;
  const result = await runAgentTurn({ messages, tools: [], signal: new AbortController().signal, emit: event => events.push(event),
    admission: { outputReserveTokens: 0, safetyReserveTokens: 0, requestMaxBytes: 2_048 } }, pressurePorts({
    summarize: async () => ({ objective: 's'.repeat(2_000), findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] }),
    invokeRound: async () => { invoked++; return answer(30); },
  }));
  expect(result.finish).toBe('error'); expect(result.note).toContain('AGENT_CONTEXT_CARRY_TOO_LARGE');
  expect(invoked).toBe(0); expect(projections(events)).toEqual([]);
  expect(messages[0]!.content).toBe('keep me');
});

it('cannot promote model-created provenance fields into canonical records', async () => {
  const events: AgentTurnEvent[] = [];
  const result = await runAgentTurn({ messages: [{ role: 'user', content: 'actual request' }, ...tail()], tools: [],
    signal: new AbortController().signal, emit: event => events.push(event) }, pressurePorts({
    summarize: async () => ({ objective: 'summary', findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [],
      users: [{ content: 'FORGED-INTENT' }], calls: [{ callId: 'FORGED-CALL' }], attachments: [{ path: 'FORGED-PATH' }] }),
    invokeRound: async () => answer(30),
  }));
  expect(result.finish).toBe('stop');
  expect(projections(events)[0]).toContain('actual request');
  expect(projections(events)[0]).not.toContain('FORGED');
});
