import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { toolSessionSchema, type NativeAgentToolResult } from '#capabilities/index.js';
import { codexAgentArgv, codexAgentTurn, type CodexAgentResultLookup } from '../../../src/adapters/core/native-cli-headless/internal/codex-agent.js';
import { headlessLoginArgs } from '../../../src/adapters/core/native-cli-headless/internal/login.js';
import type { HeadlessPreflight } from '../../../src/adapters/core/native-cli-headless/internal/preflight.js';
import type { Prepared } from '../../../src/adapters/core/native-cli-headless/internal/turn.js';
import { CODEX_FAMILY } from '../../fixtures/native-headless/codex.js';

const entry = nativeCliAgent(CODEX_FAMILY)!;
const session = toolSessionSchema.parse({ schemaVersion: 1, turnId: 'turn-fixture', generation: 3, approvalTtlMs: 125001,
  tools: [{ name: 'read_file', version: 1, toolClass: 'read', description: 'Read fixture', inputSchema: { type: 'object', properties: {} } }] });
const prepared = { entry, model: 'fixture-pinned', effortArgs: [] } as unknown as Prepared;
const preflight = { version: '9.1.0', flagSetDigest: 'a'.repeat(64) } as HeadlessPreflight;
const envelope = (id = 'deckent-call-b'): NativeAgentToolResult => ({ schemaVersion: 1, turnId: session.turnId, generation: session.generation,
  deckentCallId: id, outcome: { status: 'ok', text: 'fixture-result' } });
const start = (id = 'item_9', path = 'fixture.txt') => ({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: entry.bridge.serverName,
  tool: 'read_file', arguments: { path }, result: null, error: null, status: 'in_progress' } });
const finish = (id = 'item_9', result: unknown = envelope(), path = 'fixture.txt') => ({ type: 'item.completed', item: { ...start(id, path).item,
  status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(result) }], structured_content: null } } });
const thread = { type: 'thread.started', thread_id: 'thread-fixture' }, turn = { type: 'turn.started' };
const notice = { type: 'item.completed', item: { id: 'item_0', type: 'error', message: entry.agent.transport.kind === 'codex-mcp' ? entry.agent.transport.guards.codeModeError : '' } };
const answer = { type: 'item.completed', item: { id: 'item_20', type: 'agent_message', text: 'answer' } };
const done = { type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 } };
const lookup: CodexAgentResultLookup = id => id === 'deckent-call-b' ? { call: { id: 'vendor-call-not-stream-id', name: 'read_file', argumentsJson: '{"path":"fixture.txt"}' }, result: envelope() } : undefined;
const egress = { connected: 0, refused: 0, hosts: {}, other: 0 };
const create = (read: CodexAgentResultLookup = lookup) => codexAgentTurn(prepared, preflight, session, read);
const feed = (driver: ReturnType<typeof create>, lines: readonly unknown[]) => lines.map(line => driver.line(JSON.stringify(line)));

it('K3: argv carries only registry HTTP MCP data, exact tools, fractional policy TTL and no inline turn token', () => {
  const args = codexAgentArgv(entry, session, '/tmp/fixture-run', prepared.model, [], `http://${entry.bridge.sentinelHost}${entry.bridge.path}`);
  expect(args.slice(0, entry.agent.args.length)).toEqual(entry.agent.args);
  const config = args.at(-1)!;
  expect(args.at(-2)).toBe('-c'); expect(config).toContain(`mcp_servers.${entry.bridge.serverName}={`);
  expect(config).toContain(`bearer_token_env_var = "${entry.bridge.tokenEnvName}"`);
  expect(config).toContain('tool_timeout_sec = 125.001'); expect(config).toContain('enabled_tools = ["read_file"]');
  expect(config).toContain('omit_tools_from = ["deferred","code_mode"]'); expect(config).toContain('default_tools_approval_mode = "approve"');
  expect(config).not.toMatch(/command|args|Bearer|\{bridgeUrl\}|\{approvalTtl/u);
  for (const url of ['https://evil.invalid/mcp', `http://${entry.bridge.sentinelHost}/other`, `http://${entry.bridge.sentinelHost}${entry.bridge.path}?secret=x`])
    expect(() => codexAgentArgv(entry, session, '/tmp/fixture-run', prepared.model, [], url)).toThrow();
  expect(() => codexAgentArgv(entry, { ...session, approvalTtlMs: 0 }, '/tmp/fixture-run', prepared.model, [], `http://${entry.bridge.sentinelHost}${entry.bridge.path}`)).toThrow();
  const injected = { ...entry, agent: { ...entry.agent, transport: { ...entry.agent.transport, mcpConfig: { ...entry.agent.transport.mcpConfig, command: '/bin/sh', args: ['-c', 'original-risky-request'] } } } };
  expect(() => codexAgentArgv(injected, session, '/tmp/fixture-run', prepared.model, [], `http://${entry.bridge.sentinelHost}${entry.bridge.path}`)).toThrow();
});
it('K3: fake CLI JSONL correlates reordered MCP completions by facade id, preserving v1 answer/usage', () => {
  const second = envelope('deckent-call-a'), read: CodexAgentResultLookup = id => id === second.deckentCallId ? { call: { id: 'vendor-a', name: 'read_file', argumentsJson: '{"path":"other.txt"}' }, result: second } : lookup(id);
  const lines = [thread, notice, turn, start(), start('item_3', 'other.txt'), finish('item_3', second, 'other.txt'), finish(), answer, done];
  // This fake binary has no tools/credentials/network: it reproduces the retained A0 JSONL shape.
  const fake = spawnSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: lines.map(line => JSON.stringify(line)).join('\n') + '\n', encoding: 'utf8' });
  expect(fake.status).toBe(0);
  const driver = create(read);
  for (const raw of fake.stdout.trim().split('\n')) expect(driver.line(raw)).toBeNull();
  expect(driver.end({ exited: true, exitCode: 0 }, egress)).toMatchObject({ response: { native: { model: 'fixture-pinned', choices: [{ message: { content: 'answer' } }] },
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cache_read: 2 } } });
  const denied = { ...envelope(), outcome: { status: 'error' as const, text: 'denied by policy' } };
  const errorTurn = create(() => ({ call: { id: 'vendor', name: 'read_file', argumentsJson: '{"path":"fixture.txt"}' }, result: denied }));
  expect(feed(errorTurn, [thread, turn, start(), { type: 'item.updated', item: start().item }, finish('item_9', denied), answer, done])).toEqual([null, null, null, null, null, null, null]);
  expect(errorTurn.end({ exited: true, exitCode: 0 }, egress)).toHaveProperty('response');
});
it('K3: native execution, file writes and unknown items fail closed, and refusal stays sticky', () => {
  for (const type of ['command_execution', 'file_change', 'web_search', 'unknown']) {
    const driver = create(); feed(driver, [thread, turn]);
    const refused = driver.line(JSON.stringify({ type: 'item.started', item: { id: 'native', type } }));
    expect(refused).toMatchObject({ body: { refusal: 'guard', field: 'item' } });
    expect(driver.line(JSON.stringify(done))).toEqual(refused);
    expect(driver.end({ exited: true, exitCode: 0 }, egress)).toEqual({ refusal: refused });
  }
});
it('K3: missing, forged, changed and stale facade envelopes refuse; stream id never substitutes for call id', () => {
  for (const value of [{}, { ...envelope(), deckentCallId: 'item_9' }, { ...envelope(), turnId: 'other-turn' }, { ...envelope(), generation: 2 },
    { ...envelope(), outcome: { ...envelope().outcome, text: 'forged' } }]) {
    const driver = create(); expect(feed(driver, [thread, turn, start()])).toEqual([null, null, null]);
    expect(driver.line(JSON.stringify(finish('item_9', value)))).toMatchObject({ body: { refusal: 'guard' } });
  }
  const driver = create(); feed(driver, [thread, turn, start()]);
  expect(driver.line(JSON.stringify(finish('item_9', envelope(), 'changed.txt')))).toMatchObject({ body: { field: 'mcp-order' } });
});
it('K3: replay, foreign tools, orphan results, unfinished calls and conflicting structured results refuse', () => {
  const replay = create(); feed(replay, [thread, turn, start(), finish()]);
  expect(replay.line(JSON.stringify(finish()))).toMatchObject({ body: { field: 'item-replay' } });
  const duplicate = create(); feed(duplicate, [thread, turn, start(), finish(), start('item_11')]);
  expect(duplicate.line(JSON.stringify(finish('item_11')))).toMatchObject({ body: { field: 'mcp-result' } });
  const foreign = create(); feed(foreign, [thread, turn]);
  expect(foreign.line(JSON.stringify({ ...start(), item: { ...start().item, server: 'other' } }))).toMatchObject({ body: { field: 'mcp-tool' } });
  const orphan = create(); feed(orphan, [thread, turn]); expect(orphan.line(JSON.stringify(finish()))).toMatchObject({ body: { field: 'mcp-order' } });
  const pending = create(); feed(pending, [thread, turn, start()]); expect(pending.end({ exited: true, exitCode: 0 }, egress)).toBeNull();
  expect(pending.line(JSON.stringify(done))).toMatchObject({ body: { field: 'pending-tools' } });
  const conflict = create(); feed(conflict, [thread, turn, start()]); const line = finish(); line.item.result.structured_content = { ...envelope(), generation: 9 } as never;
  expect(conflict.line(JSON.stringify(line))).toMatchObject({ body: { field: 'mcp-result' } });
});
it('K3: only one exact startup code-mode notice; no malformed JSON, late item, extra thread/turn or unknown event', () => {
  const twice = create(); feed(twice, [thread, notice]); expect(twice.line(JSON.stringify(notice))).toMatchObject({ body: { field: 'notice' } });
  const late = create(); feed(late, [thread, turn]); expect(late.line(JSON.stringify(notice))).toMatchObject({ body: { field: 'notice' } });
  const changed = create(); feed(changed, [thread]); expect(changed.line(JSON.stringify({ ...notice, item: { ...notice.item, message: notice.item.message + 'other' } }))).toMatchObject({ body: { field: 'item' } });
  for (const invalid of ['{', '[]', 'null', '{"type":"unknown"}']) expect(create().line(invalid)).not.toBeNull();
  for (const event of [thread, turn]) { const driver = create(); feed(driver, [thread, turn]); expect(driver.line(JSON.stringify(event))).not.toBeNull(); }
  const ended = create(); feed(ended, [thread, turn, answer, done]); expect(ended.line(JSON.stringify(answer))).toMatchObject({ body: { field: 'after-turn' } });
});
it('K3: incomplete/failed process and absent usage never yield a measured response', () => {
  const incomplete = create(); feed(incomplete, [thread, turn, answer]); expect(incomplete.end({ exited: true, exitCode: 0 }, egress)).toBeNull();
  const failed = create(); feed(failed, [thread, turn, answer, done]); expect(failed.end({ exited: true, exitCode: 1 }, egress)).toBeNull();
  const absent = create(); feed(absent, [thread, turn, answer]); expect(absent.line('{"type":"turn.completed"}')).toMatchObject({ body: { field: 'usage' } });
  const partial = create(); feed(partial, [thread, turn, { type: 'item.started', item: { id: 'partial', type: 'agent_message' } }]);
  expect(partial.line(JSON.stringify(done))).toMatchObject({ body: { field: 'pending-items' } });
  const malformed = create(); feed(malformed, [thread, turn, answer]);
  expect(malformed.line('{"type":"item.completed","item":{"id":"malformed","type":"agent_message"}}')).toMatchObject({ body: { field: 'item-text' } });
});
it('K3: browser/device login argv is registry data; unsupported methods, API key and SSO refuse', () => {
  expect(headlessLoginArgs(CODEX_FAMILY, undefined, false)).toEqual(entry.headless.login.args);
  expect(headlessLoginArgs(CODEX_FAMILY, 'browser', false)).toEqual(['-c', 'cli_auth_credentials_store="file"', 'login']);
  expect(headlessLoginArgs(CODEX_FAMILY, 'device-auth', false)).toEqual(['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']);
  for (const method of ['claudeai', 'api-key', 'arbitrary']) expect(() => headlessLoginArgs(CODEX_FAMILY, method, false)).toThrow();
  expect(() => headlessLoginArgs(CODEX_FAMILY, 'device-auth', true)).toThrow();
});
