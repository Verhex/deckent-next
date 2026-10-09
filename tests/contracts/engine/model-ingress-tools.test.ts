import { expect, it } from 'vitest';
import type { AgentToolSpec, AgentTurnEvent } from '#domain/index.js';
import { mcpToolPinDigest, verifyMcpTools } from '#adapters/index.js';
import { checkModelIngressArguments, projectModelIngressField, projectModelIngressSchema, runAgentTurn,
  type AgentRoundOutcome, type AgentTurnPorts, type ModelIngressProjection } from '#engine/index.js';

const marks = ['\u200b', '\u202e', '\u{e0070}\u{e0077}\u{e006e}'];
const spec: AgentToolSpec = { name: 'write_file', version: 1, toolClass: 'edit', description: 'Write a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, nested: { type: 'object' } } } };
const answer = (calls: { id: string; name: string; argumentsJson: string }[] = []): AgentRoundOutcome =>
  ({ status: 'responded', content: calls.length ? '' : 'done', reasoning: '', toolCalls: calls, finish: calls.length ? 'tool_calls' : 'stop', usage: null });

function harness(tool: AgentToolSpec, args: unknown) {
  const notices: ModelIngressProjection[] = [], events: AgentTurnEvent[] = [], stages: string[] = [], offered: AgentToolSpec[][] = [];
  const ports: AgentTurnPorts = {
    async invokeRound(input) { offered.push([...input.tools]); return answer(input.round === 1 ? [{ id: 'c', name: tool.name, argumentsJson: JSON.stringify(args) }] : []); },
    async authorize() { stages.push('authorize'); return 'require-approval'; },
    async prepare() { stages.push('prepare'); return { ok: true }; },
    describe() { stages.push('describe'); return 'file'; },
    async requestApproval() { stages.push('approved-card'); return 'allow'; },
    async execute(_tool, received) { stages.push('execute'); expect(received).toEqual(args); return { status: 'ok', text: 'written' }; },
    async recordIngress(notice) { notices.push(notice); }, now: () => 1,
  };
  const run = (extra: Partial<AgentTurnPorts> = {}, fullAccess = false) => runAgentTurn({ messages: [{ role: 'user', content: 'write' }], tools: [tool],
    signal: new AbortController().signal, fullAccess, emit: event => events.push(event) }, { ...ports, ...extra });
  return { run, notices, events, stages, offered };
}

it.each(marks)('refuses hidden %s in values, keys and nested arrays before any authority or effect', async mark => {
  for (const args of [{ content: `private${mark}` }, { [`content${mark}`]: 'private' }, { nested: [{ ['key' + mark]: 'private' }] }, { nested: ['private' + mark] }]) {
    const f = harness(spec, args); await f.run();
    expect(f.stages).toEqual([]);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'tool.finished', status: 'invalid-arguments' }));
    const refusal = f.events.find(event => event.kind === 'message' && event.message.role === 'tool');
    expect(JSON.stringify(refusal)).toContain('ingress-refused:arguments');
    expect(JSON.stringify(refusal)).not.toContain('private');
    expect(JSON.stringify(refusal)).not.toContain('pwn');
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]?.disposition).toBe(projectModelIngressField(mark).disposition);
  }
});

it('checks JSON escapes after parsing, also for MCP tools and full-access', async () => {
  const f = harness({ ...spec, name: 'mcp__docs__write', toolClass: 'mcp' }, { content: 'x\u202ey' });
  await f.run({ async invokeRound(input) { return answer(input.round === 1 ? [{ id: 'c', name: 'mcp__docs__write', argumentsJson: '{"content":"x\\u202ey"}' }] : []); } }, true);
  expect(f.stages).toEqual([]); expect(f.notices).toHaveLength(1);
});

it('approves the exact clean card then executes unchanged including ordinary Unicode and kept selectors', async () => {
  const args = { path: 'ş.txt', content: 'Türkçe العربية 👩‍💻 ❤️', nested: { __protoText: 'clean', values: [null, 0, false] } };
  const f = harness(spec, args); const result = await f.run();
  expect(f.stages).toEqual(['describe', 'authorize', 'prepare', 'approved-card', 'execute']);
  expect(result.toolCalls).toBe(1); expect(f.notices).toEqual([]);
  expect(await checkModelIngressArguments(args)).toEqual({ ok: true });
});

it.each(marks)('projects nested schema description %s before both measurement and invocation, preserving source', async mark => {
  const schema = { ...spec.inputSchema, properties: { content: { type: 'string', description: `explain${mark}`, default: 'exact' },
    enum: { type: 'string', description: `explain${mark}` } }, $defs: { nested: { allOf: [{ description: `explain${mark}` }] } } };
  const before = JSON.stringify(schema), f = harness({ ...spec, inputSchema: schema }, {});
  let measured: readonly AgentToolSpec[] = [];
  await f.run({ async measure(input) { measured = input.tools; return { promptTokens: 1, windowTokens: null, quality: 'upper-bound' }; } });
  const shown = f.offered[0]![0]!.inputSchema;
  expect(measured[0]!.inputSchema).toEqual(shown);
  expect(JSON.stringify(shown)).not.toContain(mark); expect(JSON.stringify(shown)).not.toContain('pwn');
  expect(JSON.stringify(shown)).toContain(mark === marks[2] ? 'result withheld' : 'hidden-unicode');
  expect(shown.properties['content']).toMatchObject({ default: 'exact', type: 'string' });
  expect(JSON.stringify(schema)).toBe(before); expect(f.notices).toHaveLength(3);
});

it('withholds schema prose and refuses arguments when audit is unavailable', async () => {
  const down = async () => { throw new Error('audit unavailable'); };
  const schema = { properties: { content: { description: 'x\u200by' } } };
  expect(JSON.stringify(await projectModelIngressSchema(schema, down))).toContain('result withheld');
  const f = harness(spec, { content: 'x\u200by' }); await f.run({ recordIngress: down });
  expect(f.stages).toEqual([]);
  expect(JSON.stringify(f.events.find(event => event.kind === 'message' && event.message.role === 'tool'))).toContain('result withheld');
});

it('keeps clean schemas by identity, opaque literal values and __proto__ as own data', async () => {
  expect(await projectModelIngressSchema(spec.inputSchema)).toBe(spec.inputSchema);
  const schema = JSON.parse('{"description":"x\\u200by","__proto__":{"description":"x\\u202ey"},"default":{"description":"x\\u200by"},"enum":["x\\u200by"]}');
  const shown = await projectModelIngressSchema(schema);
  expect(Object.hasOwn(shown, '__proto__')).toBe(true); expect(Object.getPrototypeOf(shown)).toBe(Object.prototype);
  expect(shown.default).toEqual(schema.default); expect(shown.enum).toEqual(schema.enum);
});

it('projects an approved MCP input schema at model ingress without changing its original trust pin', async () => {
  const live = { name: 'write', inputSchema: { type: 'object', properties: { content: { type: 'string', description: 'text\u202edirection' } } } };
  const digest = mcpToolPinDigest(live);
  const [verdict] = verifyMcpTools({ id: 'docs', command: 'node', args: [], env: {}, realm: 'sandbox-net',
    tools: [{ name: 'write', digest, alwaysAsk: true }] }, [live]);
  expect(verdict?.status).toBe('pinned'); expect(verdict?.spec).not.toBeNull();
  const f = harness(verdict!.spec!, { content: 'clean' }); await f.run();
  expect(JSON.stringify(f.offered[0]![0]!.inputSchema)).toContain('hidden-unicode');
  expect(JSON.stringify(f.offered[0]![0]!.inputSchema)).not.toContain('\u202e');
  expect(mcpToolPinDigest(live)).toBe(digest); expect(f.notices).toHaveLength(1);
  expect(f.stages).toContain('approved-card'); expect(f.stages.at(-1)).toBe('execute');
});
