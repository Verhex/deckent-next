import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_TURN_SYSTEM_PROMPT_VERSION } from '#engine/index.js';
import type { AgentTurnMessage, AgentTurnStreamEvent } from '#domain/index.js';
import type { TurnDelta } from '#surfaces/index.js';
import { cancelRuntimeChatTurn, runRuntimeChatTurn } from '#composition/core/runtime-service/index.js';
import { streamTerminalAgentTurn } from '#surfaces/core/terminal-turn/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// TRUNCATED-TOOLCALL (live 2026-09-30, 18:12–18:18 UTC): vLLM v0.30.0 streams a tool call cut at max_completion_tokens with finish_reason
// "tool_calls" (serving.py overwrites "length" once a tool delta was streamed; fixed upstream by PR #46303 after v0.30.0). The fixture below
// replays that wire shape through the real runtime service, adapter, engine loop, policy file, effect journal and ledger: the usage chunk
// reports exactly the requested limit (the fixture's terminal.chat.maxCompletionTokens is 128) while the finish reason says tool_calls.
const editGrants = [
  { id: 'edit-tools', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['edit_file', 'write_file'] } },
  { id: 'file-write', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['workspace.file.write'] } }];
const write = (content: string, completionTokens: number) => ({ toolCall: { name: 'write_file', arguments: JSON.stringify({ path: 'src/a.ts', content }) }, completionTokens });
const ask = (turnId: string) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'write the plan into src/a.ts' }] });
const finished = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'tool.finished' ? [event.status] : []);
const toolTexts = (events: AgentTurnStreamEvent[]) => events.flatMap(event => event.kind === 'message' && event.message.role === 'tool' ? [event.message.content] : []);

describe.skipIf(process.platform !== 'linux')('a tool call cut at the completion limit through the runtime service (TRUNCATED-TOOLCALL)', () => {
  it('never writes a call of a round that reached max_completion_tokens although vLLM said tool_calls; the model is told to split and the surface shows it', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants }); await f.start();
    const before = await readFile(join(f.project, 'src', 'a.ts'), 'utf8');
    // Round 1: valid JSON with half a document (a parser that terminates the cut arguments); round 2: the unterminated JSON v0.30.0's
    // qwen3_xml parser streams today; round 3: the model answers in text.
    f.state.script = [write('export const a = 2;\n// half of the pl', 128),
      { toolCall: { name: 'write_file', arguments: '{"path": "src/a.ts", "content": "export const a = 3;\\n// the other ha' }, completionTokens: 128 },
      { content: 'I will write it in parts.' }];
    const events: AgentTurnStreamEvent[] = [];
    const result = await f.client().chatTurn(ask('turn-cut'), event => events.push(event));
    // No partial effect: the file, the effect journal and the durable call records show nothing ran.
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe(before);
    expect(f.rows('SELECT target_id FROM effect_intents')).toEqual([]);
    expect(f.rows('SELECT record FROM agent_turn_tool_calls').map(row => (JSON.parse((row as { record: string }).record) as { status: string; argsDigest: unknown }))
      .map(record => [record.status, record.argsDigest])).toEqual([['invalid-arguments', null], ['invalid-arguments', null]]);
    expect(result).toMatchObject({ finish: 'stop', rounds: 3, toolCalls: 0 });
    expect(result.note).toMatch(/2 tool calls were cut at the model's output limit \(128 tokens\) and not run/);
    expect(finished(events)).toEqual(['invalid-arguments', 'invalid-arguments']);
    // The model received the structured result in its next request (the governed round 2 and 3 bodies carry it as the tool message).
    const texts = toolTexts(events);
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text).toMatch(/^\[deckent\] write_file: error=output-limit \(this answer reached the output limit of 128 tokens while writing the call/);
    const sent = (f.state.requests[1]!['messages'] as { role: string; content: string }[]).filter(message => message.role === 'tool');
    expect(sent.map(message => message.content)).toEqual([texts[0]]);
    // The model was told beforehand (system prompt v7): its answer limit and how to write large content in parts.
    const system = (f.state.requests[0]!['messages'] as { role: string; content: string }[])[0]!.content;
    expect(system.startsWith(`[Deckent runtime instructions v${AGENT_TURN_SYSTEM_PROMPT_VERSION}]`)).toBe(true);
    expect(system).toContain('- One answer, tool call arguments included, may use at most 128 output tokens');
  }, 30_000);

  it('writes a call below the limit (positive control) and shows a cut call and the note on the terminal surface', async () => {
    const f = await runtime({ toolGrant: false, extraGrants: editGrants }); await f.start();
    f.state.script = [write('export const a = 2;\n', 127), { content: 'Written.' }];
    const events: AgentTurnStreamEvent[] = [];
    const written = await f.client().chatTurn(ask('turn-below'), event => events.push(event));
    expect(written).toMatchObject({ finish: 'stop', toolCalls: 1, note: null }); expect(finished(events)).toEqual(['ok']);
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');

    // The terminal's own path (streamTerminalAgentTurn → runtime chatTurn): the cut call finishes visibly and the footer note names it.
    f.state.script.push(write('export const a = 4;\n// cut', 128), { content: 'Split.' });
    const deltas: TurnDelta[] = [];
    const messages: AgentTurnMessage[] = [{ role: 'user', content: 'write it again' }];
    for await (const delta of streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 'scope', messages, options: { env: f.env }, signal: new AbortController().signal },
      { chatTurn: runRuntimeChatTurn, cancelChatTurn: cancelRuntimeChatTurn })) deltas.push(delta);
    expect(deltas.filter(delta => delta.kind === 'tool' && delta.phase === 'finished')).toEqual([expect.objectContaining({ name: 'write_file', status: 'invalid-arguments' })]);
    expect(deltas.at(-1)).toMatchObject({ kind: 'done', finish: 'stop', note: expect.stringMatching(/1 tool call was cut at the model's output limit \(128 tokens\) and not run/) });
    expect(await readFile(join(f.project, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  }, 30_000);
});
