import { describe, expect, it } from 'vitest';
import type { AgentTurnStreamEvent, ChatTurnCancellation, ChatTurnCommand, ChatTurnResult } from '#domain/index.js';
import { streamTerminalAgentTurn, type TerminalAgentTurnPorts } from '#composition/core/terminal-chat/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { renderAssistantStream, startAssistantStream, type ToolUnit } from '#surfaces/core/terminal-render/index.js';

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
/** What the terminal shows for each tool delta (TL-B D2 is derived by the renderer): the running call's target, then the printed line. */
function toolLines(deltas: readonly TurnDelta[]) {
  let state = startAssistantStream(0); const lines: { callId: string; target: string | null; unit?: ToolUnit }[] = [];
  for (const delta of deltas) {
    const step = renderAssistantStream(state, delta, 1); state = step.state;
    if (delta.kind !== 'tool') continue;
    const unit = step.staticUnits.find((candidate): candidate is ToolUnit => candidate.kind === 'tool');
    lines.push({ callId: delta.callId, target: delta.phase === 'started' ? step.activeTool!.target : unit!.target, ...(unit ? { unit } : {}) });
  }
  return lines;
}

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

  // Astra 2124 durable marker (CLEANUP-MARK, protocol v15): the mapper carries `cleanup` onto the finished tool delta when the
  // service event has it, and leaves the key off entirely (never `undefined`) when the event has none.
  it("carries tool.finished's cleanup onto the delta when present, and omits the key entirely when absent", async () => {
    const p = ports(async (command, onEvent) => {
      onEvent({ kind: 'tool.started', callId: 'c1', name: 'run_shell', target: 'sleep 5 & echo' });
      onEvent({ kind: 'tool.finished', callId: 'c1', name: 'run_shell', status: 'ok', ms: 12, bytes: 3, cleanup: 'group-ended' });
      return result({ turnId: command.turnId, answer: null });
    });
    const deltas = await collect(streamTerminalAgentTurn(input, p.value));
    expect(deltas.find(delta => delta.kind === 'tool' && delta.phase === 'finished')).toEqual(
      { kind: 'tool', phase: 'finished', callId: 'c1', name: 'run_shell', target: 'sleep 5 & echo', status: 'ok', ms: 12, cleanup: 'group-ended' });
  });

  // D2 (TL-B, analysis §2/§4): the engine's `target` (path-first for grep/glob, `call-approvals.ts` displayTarget bug)
  // is what the C12 approval resource must stay bound to; the tool LINE shows the pattern instead, derived by the terminal
  // renderer from the assistant message's own recorded tool-call arguments (a `message` delta before `tool.started`), never
  // from a protocol addition. The stream itself carries the engine's target (composition loads no surface code at runtime).
  // Path-bearing tools (read_file/list_dir/shell) are unaffected: their engine target is shown as is.
  it('shows the pattern first for grep/glob tool lines, derived client-side from the call arguments, leaving read_file/shell targets as the engine sent them', async () => {
    const p = ports(async (command, onEvent) => {
      onEvent({ kind: 'message', message: { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', name: 'grep', argumentsJson: '{"pattern":"needle","path":"src"}' },
        { id: 'c2', name: 'glob', argumentsJson: '{"pattern":"**/*.ts"}' },
        { id: 'c3', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' }] } });
      // The engine still computes the old (buggy) path-first target for grep; the client must not trust it for display.
      onEvent({ kind: 'tool.started', callId: 'c1', name: 'grep', target: 'src' });
      onEvent({ kind: 'tool.finished', callId: 'c1', name: 'grep', status: 'ok', ms: 5, bytes: 10 });
      onEvent({ kind: 'tool.started', callId: 'c2', name: 'glob', target: null });
      onEvent({ kind: 'tool.finished', callId: 'c2', name: 'glob', status: 'ok', ms: 3, bytes: 5 });
      onEvent({ kind: 'tool.started', callId: 'c3', name: 'read_file', target: 'src/a.ts' });
      onEvent({ kind: 'tool.finished', callId: 'c3', name: 'read_file', status: 'ok', ms: 2, bytes: 5 });
      return result({ turnId: command.turnId, answer: null });
    });
    const deltas = await collect(streamTerminalAgentTurn(input, p.value));
    expect(deltas.filter(delta => delta.kind === 'tool' && delta.callId === 'c1').map(delta => delta.kind === 'tool' && delta.target)).toEqual(['src', 'src']);
    const lines = toolLines(deltas);
    const targetsOf = (callId: string) => lines.filter(line => line.callId === callId).map(line => line.target);
    expect(targetsOf('c1')).toEqual(['"needle" src', '"needle" src']);
    expect(targetsOf('c2')).toEqual(['"**/*.ts"', '"**/*.ts"']);
    expect(targetsOf('c3')).toEqual(['src/a.ts', 'src/a.ts']);
  });

  // D2: the finished tool line carries a short result summary derived by the renderer from the call's own recorded result text
  // (the `message` delta of role 'tool' that always precedes `tool.finished` for the same call) — never a new wire field.
  it('derives a result summary for finished read-class tool calls from their own result text, and omits it when the text does not match a known shape', async () => {
    const run = async (name: string, content: string, status: 'ok' | 'error' = 'ok') => {
      const p = ports(async (command, onEvent) => {
        onEvent({ kind: 'tool.started', callId: 'c1', name, target: 't' });
        onEvent({ kind: 'message', message: { role: 'tool', toolCallId: 'c1', name, content } });
        onEvent({ kind: 'tool.finished', callId: 'c1', name, status, ms: 1, bytes: Buffer.byteLength(content, 'utf8') });
        return result({ turnId: command.turnId, answer: null });
      });
      const deltas = await collect(streamTerminalAgentTurn(input, p.value));
      expect(deltas.find(delta => delta.kind === 'tool' && delta.phase === 'finished')).not.toHaveProperty('summary');
      return toolLines(deltas).find(line => line.unit)!.unit;
    };
    expect(await run('read_file', '[deckent] read_file: mode=range totalLines=269 range=1-243 returned=243 hasMore=true nextStartLine=244'
      + ' maxBytesPerLine=2048 elidedLines=0\n001\tfirst line')).toMatchObject({ summary: { kind: 'lines', shown: 243, total: 269, more: true } });
    expect(await run('read_file', '[deckent] read_file: mode=range totalLines=3 range=1-3 returned=3 hasMore=false maxBytesPerLine=2048 elidedLines=0'
      + '\n001\ta\n002\tb\n003\tc')).toMatchObject({ summary: { kind: 'lines', shown: 3, total: 3, more: false } });
    expect(await run('read_file', '[deckent] read_file: mode=search pattern="x" totalLines=100 matches=12 shown=12 context=0 hasMore=false maxBytesPerLine=2048'))
      .toMatchObject({ summary: { kind: 'matches', count: 12, more: false } });
    expect(await run('read_file', '[deckent] read_file: mode=outline bytes=500 totalLines=50 longestLine=L3:80B linesOver=0(>2048B) headings=5 shown=1-5 hasMore=false'))
      .toMatchObject({ summary: { kind: 'headings', shown: 5, total: 5, more: false } });
    expect(await run('grep', 'src/a.ts:1:const needle = 1;\nsrc/b.ts:4:needle again')).toMatchObject({ summary: { kind: 'matches', count: 2, more: false } });
    expect(await run('grep', '[deckent] grep: no matches in 3 scanned file(s)')).toMatchObject({ summary: { kind: 'matches', count: 0, more: false } });
    expect(await run('grep', 'src/a.ts:1:needle\n[deckent] grep: truncated (200 hits cap); narrow with path or glob'))
      .toMatchObject({ summary: { kind: 'matches', count: 1, more: true } });
    // Astra 2143 R2: a grep result with `context` mixes real hits (`path:line:text`) with context lines
    // (`path:line-text`) and, between non-adjacent blocks, a lone `--` separator. None of those extra rows is a
    // match: the count must stay the number of ':' hit lines only (ported from astra-2142-extra.test.ts.txt).
    expect(await run('grep', 'a.txt:1-before\na.txt:2:MATCH one\na.txt:3-after')).toMatchObject({ summary: { kind: 'matches', count: 1, more: false } });
    expect(await run('grep', 'a.txt:2:hit one\n--\na.txt:9:hit two')).toMatchObject({ summary: { kind: 'matches', count: 2, more: false } });
    expect(await run('glob', 'src/one.ts\nsrc/two.ts')).toMatchObject({ summary: { kind: 'matches', count: 2, more: false } });
    expect(await run('list_dir', 'src/\nREADME.md')).toMatchObject({ summary: { kind: 'entries', count: 2 } });
    const errored = await run('read_file', '[deckent] read_file: error=not-found path="missing.ts"', 'error');
    expect(errored).toMatchObject({ status: 'error' });
    expect((errored as { summary?: unknown }).summary).toBeUndefined();
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
