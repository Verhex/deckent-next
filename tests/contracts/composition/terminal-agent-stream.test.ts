import { describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent, ChatTurnCancellation, ChatTurnCommand, ChatTurnResult } from '#domain/index.js';
import { streamTerminalAgentTurn, type TerminalAgentTurnPorts } from '#composition/core/terminal-chat/index.js';
import type { TurnDelta } from '#surfaces/index.js';

const input = { projectRoot: '/project', scopeId: 'scope', messages: [{ role: 'user' as const, content: 'what?' }], options: {} };
const result = (over: Partial<ChatTurnResult> = {}): ChatTurnResult => ({ schemaVersion: 1, turnId: 't', finish: 'stop', note: null, rounds: 2, toolCalls: 1,
  answer: 'It exports a.', answerBytes: 13, replayed: false, recorded: true, ...over });
function ports(run: (command: ChatTurnCommand, onEvent: (event: AgentTurnStreamEvent) => void, signal?: AbortSignal) => Promise<ChatTurnResult>) {
  const commands: ChatTurnCommand[] = [], cancelled: ChatTurnCancellation[] = [];
  const value: TerminalAgentTurnPorts = {
    async chatTurn(_root, command, onEvent, _options, signal) { commands.push(command); return run(command, onEvent, signal); },
    async cancelChatTurn(_root, command) { cancelled.push(command); return { schemaVersion: 1, turnId: command.turnId, state: 'cancelling' }; },
  };
  return { value, commands, cancelled };
}
const collect = async (stream: AsyncIterable<TurnDelta>) => { const out: TurnDelta[] = []; for await (const delta of stream) out.push(delta); return out; };

describe('terminal agent turn stream', () => {
  it('maps service events to deltas, carries the tool target to its finished line, and ends with one done and the note', async () => {
    const p = ports(async (command, onEvent) => {
      onEvent({ kind: 'reasoning', text: 'think' });
      onEvent({ kind: 'message', message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{}' }] } });
      onEvent({ kind: 'tool.started', callId: 'c1', name: 'read_file', target: 'src/a.ts' });
      onEvent({ kind: 'tool.finished', callId: 'c1', name: 'read_file', status: 'ok', ms: 4, bytes: 20 });
      onEvent({ kind: 'usage', round: 2, promptTokens: 30, completionTokens: 5 });
      onEvent({ kind: 'text', text: 'It exp' });
      return result({ turnId: command.turnId, note: 'NOTE' });
    });
    const deltas = await collect(streamTerminalAgentTurn(input, p.value));
    expect(deltas).toEqual([{ kind: 'reasoning', text: 'think' },
      { kind: 'message', message: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson: '{}' }] } },
      { kind: 'tool', phase: 'started', callId: 'c1', name: 'read_file', target: 'src/a.ts', status: null, ms: null },
      { kind: 'tool', phase: 'finished', callId: 'c1', name: 'read_file', target: 'src/a.ts', status: 'ok', ms: 4 },
      { kind: 'usage', promptTokens: 30, completionTokens: 5, reasoningTokens: null },
      { kind: 'text', text: 'It exp' },
      // The tail the events did not carry is completed from the bounded result.
      { kind: 'text', text: 'orts a.' },
      { kind: 'done', finish: 'stop', note: 'NOTE' }]);
    // A fresh turn id per turn; the history is sent as given.
    expect(p.commands[0]).toMatchObject({ schemaVersion: 1, scopeId: 'scope', messages: input.messages });
    expect(p.commands[0]!.turnId).toMatch(/^[0-9a-f-]{36}$/); expect(p.cancelled).toEqual([]);
  });

  it('shows a replayed answer, and never merges an answer that differs from what was shown', async () => {
    expect(await collect(streamTerminalAgentTurn(input, ports(async command => result({ turnId: command.turnId, replayed: true })).value)))
      .toEqual([{ kind: 'text', text: 'It exports a.' }, { kind: 'done', finish: 'stop', note: null }]);
    const divergent = await collect(streamTerminalAgentTurn(input, ports(async (command, onEvent) => { onEvent({ kind: 'text', text: 'Hello' });
      return result({ turnId: command.turnId }); }).value));
    expect(divergent).toEqual([{ kind: 'text', text: 'Hello' }, { kind: 'done', finish: 'stop', note: null }]);
  });

  it('cancels this exact turn at once on abort and when the consumer stops early; a service error surfaces as is', async () => {
    const held = () => ports((_command, onEvent, signal) => new Promise<ChatTurnResult>((_resolve, reject) => {
      onEvent({ kind: 'text', text: 'partial' }); signal?.addEventListener('abort', () => reject(new Error('disconnected')), { once: true });
    }));
    const controller = new AbortController(), aborted = held(), seen: TurnDelta[] = [];
    for await (const delta of streamTerminalAgentTurn({ ...input, signal: controller.signal }, aborted.value)) { seen.push(delta); if (delta.kind === 'text') controller.abort(); }
    expect(seen).toEqual([{ kind: 'text', text: 'partial' }, { kind: 'done', finish: 'cancelled', note: null }]);
    expect(aborted.cancelled).toEqual([{ schemaVersion: 1, scopeId: 'scope', turnId: aborted.commands[0]!.turnId }]);
    const early = held();
    for await (const delta of streamTerminalAgentTurn(input, early.value)) { expect(delta).toEqual({ kind: 'text', text: 'partial' }); break; }
    expect(early.cancelled).toEqual([expect.objectContaining({ turnId: early.commands[0]!.turnId })]);
    const failing = ports(async () => { throw Object.assign(new Error('AGENT_TURN_CONFLICT'), { code: 'AGENT_TURN_CONFLICT' }); });
    await expect(collect(streamTerminalAgentTurn(input, failing.value))).rejects.toMatchObject({ code: 'AGENT_TURN_CONFLICT' });
    expect(failing.cancelled).toEqual([]);
  });

  it('names a missing local configuration before contacting the service', async () => {
    const p = ports(async () => { throw new Error('must not be called'); });
    const preflight = async () => { throw Object.assign(new Error('TERMINAL_CHAT_NOT_CONFIGURED'), { code: 'TERMINAL_CHAT_NOT_CONFIGURED' }); };
    await expect(collect(streamTerminalAgentTurn(input, { ...p.value, preflight }))).rejects.toMatchObject({ code: 'TERMINAL_CHAT_NOT_CONFIGURED' });
    expect(p.commands).toEqual([]);
  });
});
