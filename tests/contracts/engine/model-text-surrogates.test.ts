import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { modelTextBoundary, modelTextPrefix, wellFormedModelJson, wellFormedModelText, type AgentTurnMessage } from '#domain/index.js';
import { agentCompactionTranscript, parseAgentCompactionSummary, planAgentCompaction, renderAgentCompaction } from '#engine/index.js';
import { createOpenAiChatNativePort, openAiChatNativeMessages, prepareOpenAiChatHttpRequest } from '#adapters/core/provider-openai-chat/index.js';
import { boundSandboxReason, describeHostShellResult, SANDBOX_REASON_MAX_CHARS } from '#adapters/core/host-shell/index.js';
import { mcpToolPinDigest, verifyMcpTools, type McpLiveTool } from '#adapters/core/mcp-client/index.js';
import { chatTurnRoundFailureState } from '#composition/core/agent-turn/index.js';

// SURROGATE-CUT 2026-09-30: a code-unit cut split an emoji; the persisted compaction summary carried a lone high surrogate, JSON sent it as
// `\ud83d` and the provider tokenizer answered HTTP 400 for every later round. Synthetic text only (never the owner's session content).
const EMOJI = '\u{1F600}'; // U+1F600 = 😀
/** Any lone surrogate in `text` (a high one without a following low one, or a low one without a preceding high one). */
const lone = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
/** JSON.stringify emits a paired surrogate raw and escapes only a lone one, so any `\ud800`–`\udfff` escape in a body is a lone half. */
const loneEscape = (json: string) => /\\u[dD][89abcdefABCDEF][0-9a-fA-F]{2}/.test(json);
/** Text of `length` code units whose emoji starts at `at` (so a cut at `at + 1` falls between its two halves). */
const straddling = (length: number, at: number) => `${'a'.repeat(at)}${EMOJI}${'b'.repeat(length - at - 2)}`;

describe('model text helpers', () => {
  it('never cut inside a surrogate pair and replace only lone surrogates', () => {
    const text = straddling(10, 4);
    expect(modelTextBoundary(text, 5)).toBe(4);
    expect(modelTextBoundary(text, 4)).toBe(4);
    expect(modelTextBoundary(text, 6)).toBe(6);
    expect(modelTextPrefix(text, 5)).toBe('aaaa');
    expect(modelTextPrefix(text, 6)).toBe(`aaaa${EMOJI}`);
    expect(modelTextPrefix(text, 99)).toBe(text);
    expect(wellFormedModelText(`x\ud83d y \ude00 ${EMOJI}`)).toBe(`x\uFFFD y \uFFFD ${EMOJI}`);
    const clean = { a: [EMOJI, 1, null], b: { c: 'd' } };
    expect(wellFormedModelJson(clean)).toBe(clean);
    expect(wellFormedModelJson({ a: ['\ud83d', 1], 'k\udfff': true })).toEqual({ a: ['\uFFFD', 1], 'k\uFFFD': true });
    // Repeated probes keep no regex state between calls.
    for (let i = 0; i < 3; i++) expect(wellFormedModelText('\ud83d')).toBe('\uFFFD');
  });
});

describe('compaction cuts (the owner-observed producer)', () => {
  const older = (argumentsJson: string, toolText: string): AgentTurnMessage[] => [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', argumentsJson }] },
    { role: 'tool', toolCallId: 'c1', name: 'read_file', content: toolText },
    ...Array.from({ length: 8 }, (_, index): AgentTurnMessage => ({ role: 'user', content: `tail ${index}` })),
  ];

  it('the mechanical excerpt keeps a whole emoji or none at the 400 and 200 cuts, marker intact (owner shape: 1471 characters)', () => {
    // Tool call arguments of 1471 code units cut at 200, a tool result of 1471 cut at 400: both straddle an emoji at the limit.
    const plan = planAgentCompaction(older(straddling(1471, 199), straddling(1471, 399)))!;
    const content = renderAgentCompaction(plan, null).content;
    expect(lone(content)).toBe(false);
    expect(content).toMatch(/- read_file a{199} …\[cut: 1471 characters, sha256 [a-f0-9]{16}\]/);
    expect(content).toMatch(/\[tool result read_file\] a{399} …\[cut: 1471 characters, sha256 [a-f0-9]{16}\]/);
    // The code-unit bound still holds (the cut only shortens).
    const argument = /- read_file (a*) …\[cut/.exec(content)![1]!;
    expect(argument.length).toBeLessThanOrEqual(200);
  });

  it('earlier user messages are cut at 4000 without a lone half', () => {
    const plan = planAgentCompaction([{ role: 'user', content: straddling(5000, 3999) }, ...older('{}', 'ok')])!;
    expect(lone(renderAgentCompaction(plan, null).content)).toBe(false);
  });

  it('the summary input transcript is cut at 2000 without a lone half', () => {
    const text = agentCompactionTranscript([{ role: 'tool', toolCallId: 'c1', name: 'read_file', content: straddling(2500, 1999) }], 1_000_000);
    expect(lone(text)).toBe(false);
    expect(text).toContain(`${'a'.repeat(1999)} …[cut]`);
  });

  it('a long objective and an unbroken list item are bounded without a lone half; the length bounds hold', () => {
    const objective = straddling(3000, 1950), item = straddling(2500, 999);
    const summary = parseAgentCompactionSummary(JSON.stringify({ objective, findings: [item], decisions: [], unresolved: [], nextActions: [], inspectedAreas: [] }))!;
    expect(summary).not.toBeNull();
    expect(lone(summary.objective)).toBe(false);
    expect(summary.objective.length).toBeLessThanOrEqual(2000);
    expect(summary.objective).toMatch(/…\[cut: 3000 characters, sha256 [a-f0-9]{16}\]$/);
    expect(summary.findings.every(entry => !lone(entry) && entry.length <= 1000)).toBe(true);
    expect(summary.findings.join('')).toBe(item); // pieces drop nothing
  });
});

describe('other model-bound cuts', () => {
  it('the shell result echoes the command cut at a code point boundary', () => {
    const ran = { status: 'exited' as const, exitCode: 0, signal: null, output: 'ok\n', totalBytes: 3, omittedBytes: 0, durationMs: 100, cleanup: 'clean' as const };
    const text = describeHostShellResult(straddling(150, 118), ran, null);
    expect(lone(text)).toBe(false);
    expect(text).toContain(`(${'a'.repeat(118)}…)`);
  });

  it('a sandbox reason notice is cut at a code point boundary', () => {
    const text = boundSandboxReason(straddling(SANDBOX_REASON_MAX_CHARS + 100, SANDBOX_REASON_MAX_CHARS - 2));
    expect(lone(text)).toBe(false);
    expect(text.length).toBeLessThanOrEqual(SANDBOX_REASON_MAX_CHARS);
  });

  it('an MCP tool description offered to the model is cut at a code point boundary', () => {
    const prefix = '[MCP server fx; untrusted] ';
    const tool: McpLiveTool = { name: 'echo', description: straddling(2600, 1998 - prefix.length), inputSchema: { type: 'object', properties: {} } };
    const [verdict] = verifyMcpTools({ id: 'fx', command: 'x', args: [], env: {}, realm: 'host',
      tools: [{ name: 'echo', digest: mcpToolPinDigest(tool), alwaysAsk: false }] }, [tool]);
    expect(verdict!.status).toBe('pinned');
    expect(lone(verdict!.spec!.description)).toBe(false);
    expect(verdict!.spec!.description.length).toBeLessThanOrEqual(2000);
  });
});

describe('provider request boundary (openai-chat, the real serialization path)', () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
  const tariff = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } as const;
  const limits = { requestMaxBytes: 1_000_000, responseMaxBytes: 65_536, timeoutMs: 5000 };
  const binding = { encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1,
    nativeId: 'configured-model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] } };
  /** The persisted session shape the owner hit: a compaction summary (a user message) whose tool-call line holds a lone high surrogate. */
  const poisoned: AgentTurnMessage[] = [
    { role: 'user', content: `[Deckent context excerpt: replaces 116 earlier messages. …]\n\nEarlier tool calls (recorded by Deckent):\n- write_file {"content":"x | ${'\ud83d'} …[cut: 1471 characters, sha256 0123456789abcdef]\n- read_file {}` },
    { role: 'assistant', content: `ok ${EMOJI}`, toolCalls: [{ id: 'c\ud83d', name: 'read_file', argumentsJson: '{"path":"a\ud83d"}' }] },
    { role: 'tool', toolCallId: 'c\ud83d', name: 'read_file', content: 'tail \ude00' },
    { role: 'user', content: 'continue' },
  ];
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } } }];
  const nativeRequest = () => ({ model: 'configured-model', messages: openAiChatNativeMessages(poisoned), max_completion_tokens: 12, tools, tool_choice: 'auto' });

  it('the prepared body carries no lone surrogate, keeps paired emoji and is deterministic', () => {
    const definition = { endpoint: 'http://127.0.0.1:9/', maxOutputTokens: 32, authentication: { type: 'none' }, tariff };
    const first = prepareOpenAiChatHttpRequest(definition, limits, nativeRequest()), again = prepareOpenAiChatHttpRequest(definition, limits, nativeRequest());
    expect(loneEscape(JSON.stringify(nativeRequest()))).toBe(true); // the input is poisoned
    expect(loneEscape(first.body)).toBe(false);
    expect(lone(first.body)).toBe(false);
    expect(first.body).toContain(`ok ${EMOJI}`);
    expect(first.body).toContain('x | \uFFFD …[cut: 1471 characters');
    expect(first.body).toBe(again.body);
    // The prepared request (also what a provider counter is sent) is the same well-formed request as the body.
    expect(JSON.parse(first.body).messages).toEqual(first.request.messages);
  });

  it('a server that rejects lone surrogates like the owner\'s tokenizer answers the poisoned session after the fix', async () => {
    let sawLone = false;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (loneEscape(body)) { sawLone = true; res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]', type: 'BadRequestError', param: null, code: 400 } })); return; }
        res.end(JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion', created: 1, model: 'configured-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'answer' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
      });
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
    const endpoint = `http://127.0.0.1:${address.port}/`;
    const profile = { schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference: { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 },
      bindingDigest: 'a'.repeat(64), protocol: { family: 'openai-chat-completions', version: 'v1' },
      adapter: { id: 'openai-chat-http', version: 4, definition: { endpoint, maxOutputTokens: 32, authentication: { type: 'none' }, tariff } },
      allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits };
    const port = createOpenAiChatNativePort();
    const result = await port.send(await port.prepare(profile, binding, nativeRequest()));
    expect(sawLone).toBe(false);
    expect(result).toMatchObject({ schemaVersion: 1, native: { choices: [{ message: { content: 'answer' } }] } });
  });
});

describe('the turn note names a rejected round\'s bounded diagnostic', () => {
  const body = { byteLength: 159, observedBytes: 159, complete: true, digest: 'f'.repeat(64) };
  const content = { kind: 'response-body', encoding: 'base64', digest: 'f'.repeat(64), byteLength: 159 } as never;
  it('an HTTP rejection names its status; the provider body is never in the note', () => {
    expect(chatTurnRoundFailureState({ schemaVersion: 4, state: 'rejected', observedAtMs: 1, content,
      evidence: { schemaVersion: 1, adapter: { id: 'openai-chat-http', version: 4 }, reason: 'http-status', httpStatus: 400, body } })).toBe('rejected: HTTP 400');
    expect(chatTurnRoundFailureState({ schemaVersion: 4, state: 'rejected', observedAtMs: 1, content,
      evidence: { schemaVersion: 1, adapter: { id: 'openai-chat-http', version: 4 }, reason: 'invalid-response', httpStatus: 200, body } })).toBe('rejected: invalid-response, HTTP 200');
    expect(chatTurnRoundFailureState({ schemaVersion: 4, state: 'unknown', reason: 'transport-error', evidence: null, content: null, observedAtMs: 1 })).toBe('unknown');
  });
});
