import { afterEach, expect, it, vi } from 'vitest';
import { runAgentTurn, type AgentRoundOutcome } from '#engine/index.js';
import type { AgentTurnMessage, AgentTurnStreamEvent } from '#domain/index.js';
import { streamTerminalAgentTurn } from '#composition/core/terminal-chat/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

const mounted: ReturnType<typeof mountWorkline>[] = [];
afterEach(() => { for (const view of mounted.splice(0)) view.instance.unmount(); });

it.each(['en', 'tr'] as const)('shows the real engine context refusal in the terminal in %s, and /clear can start a valid next turn', async language => {
  const invokeRound = vi.fn(async (): Promise<AgentRoundOutcome> => ({ status: 'responded', content: 'RECOVERED', reasoning: '',
    toolCalls: [], finish: 'stop', usage: null }));
  const view = mountWorkline({ streamTurn: (messages, signal) => streamTerminalAgentTurn({ projectRoot: '/fixture', scopeId: 'scope',
    messages, signal, options: {} }, {
    async chatTurn(_root, command, onEvent, _options, abort) {
      const result = await runAgentTurn({ messages: command.messages, tools: [], signal: abort!, language,
        emit: event => { if (event.kind !== 'done') onEvent(event); }, admission: { outputReserveTokens: 10, safetyReserveTokens: 10 } }, {
        invokeRound, now: () => 0, authorize: async () => 'allow', describe: () => null, execute: async () => ({ status: 'ok', text: '' }),
        measure: async ({ messages: history }) => ({ promptTokens: history.some(message => message.content.includes('oversized')) ? 990 : 10,
          windowTokens: 1_000, quality: 'provider-count' }),
      });
      return { schemaVersion: 1, turnId: command.turnId, ...result, answerBytes: Buffer.byteLength(result.answer ?? ''), recorded: true, replayed: false };
    },
    cancelChatTurn: async () => undefined,
  }) }); mounted.push(view);
  await settle(); view.stdin.write('oversized 🙂漢字İ\r');
  await until(() => view.stdout.text.includes('AGENT_CONTEXT_WINDOW_EXCEEDED'), 'typed context refusal');
  expect(view.stdout.text).toContain(language === 'tr' ? 'Konuşma artık modelin bağlam penceresine sığmıyor' : 'The conversation no longer fits the model context window');
  expect(view.stdout.text).toContain('/clear');
  expect(invokeRound).not.toHaveBeenCalled();
  view.stdin.write('/clear\r'); await until(() => view.stdout.text.includes('NEW-SESSION'), 'new conversation');
  view.stdin.write('small question\r'); await until(() => view.stdout.text.includes('RECOVERED'), 'next answer');
  expect(invokeRound).toHaveBeenCalledTimes(1);
});

it('projects the same compaction guard after wire decoding, so skipped summaries do not show a false summarizing phase', async () => {
  let summaries = 0;
  const messages: AgentTurnMessage[] = [{ role: 'user', content: 'directive' },
    ...Array.from({ length: 8 }, () => ({ role: 'assistant' as const, content: 'tail', toolCalls: [] }))];
  const admission = { outputReserveTokens: 0, safetyReserveTokens: 0, requestMaxBytes: 100_000, requestReserveBytes: 0, completionLimitTokens: 100 };
  const deltas = [];
  for await (const delta of streamTerminalAgentTurn({ projectRoot: '/fixture', scopeId: 'scope', messages, options: {} }, {
    preflight: async () => admission,
    cancelChatTurn: async () => undefined,
    async chatTurn(_root, command, onEvent, _options, signal) {
      const result = await runAgentTurn({ messages: command.messages, admission, signal: signal!,
        tools: [{ name: 'read', version: 1, description: 'read', toolClass: 'read', inputSchema: { type: 'object', properties: {} } }],
        emit: event => { if (event.kind !== 'done') onEvent(JSON.parse(JSON.stringify(event)) as AgentTurnStreamEvent); } }, {
        measure: async () => ({ promptTokens: 800, windowTokens: 1_000, quality: 'provider-count' }),
        summarize: async () => { summaries++; return { objective: 's'.repeat(2_000), findings: [], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] }; },
        invokeRound: async ({ round }) => ({ status: 'responded', content: round === 5 ? 'done' : '', reasoning: '', finish: 'stop', usage: null,
          toolCalls: round === 5 ? [] : [{ id: `c${round}`, name: 'read', argumentsJson: '{}' }] }),
        now: () => 0, authorize: async () => 'allow', describe: () => null, execute: async () => ({ status: 'ok', text: 'result' }),
      });
      return { schemaVersion: 1, turnId: command.turnId, ...result, answerBytes: 4, recorded: true, replayed: false };
    },
  })) deltas.push(delta);
  expect(summaries).toBe(2);
  expect(deltas.filter(delta => delta.kind === 'context').map(delta => delta.compacting ?? false)).toEqual([true, false, false, false, false, true, false]);
});
