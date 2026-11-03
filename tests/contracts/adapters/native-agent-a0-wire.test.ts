import { describe, expect, it } from 'vitest';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeAgentInitReason, nativeAgentItemReason, toolSessionSchema, nativeAgentCorrelationSchema, nativeAgentToolResultSchema } from '#capabilities/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };
import { a0Events } from '../../fixtures/native-agent-a0/fixture.js';

describe('A63-K10 A0 wire through K0 public seams', () => {
  it('accepts the complete recorded Claude init and refuses plugin provenance and native-tool fault injections', async () => {
    const init = (await a0Events('claude-tools')).find(event => event['subtype'] === 'init')!;
    const family = registry.adapters.claude.capabilities.eventStream;
    const { agent, bridge } = nativeCliAgent(family)!;
    const session = toolSessionSchema.parse({ schemaVersion: 1, turnId: 'fixture-turn', generation: 1, approvalTtlMs: 120000,
      tools: (init['tools'] as string[]).map(name => ({ name: name.slice(bridge.toolPrefix.length), version: 1, toolClass: 'mcp', description: 'Retained spike tool (no execution)', inputSchema: { type: 'object', properties: {} } })) });
    expect(nativeAgentInitReason(agent, bridge, session, init)).toBeNull();
    // Fault injection only: A0 never measured a foreign plugin. The retained wire remains untouched.
    const injected = structuredClone(init) as typeof init & { plugins: { name: string; path: string; source: string }[] };
    injected.plugins[0]!.source = 'fixture-foreign@builtin';
    expect(nativeAgentInitReason(agent, bridge, session, injected)).toBe('NATIVE_AGENT_PLUGIN_UNEXPECTED');
    expect(nativeAgentInitReason(agent, bridge, session, { ...init, tools: [...init['tools'] as string[], 'Bash'] })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins: undefined })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    expect(await a0Events('claude-tools')).toContainEqual(init);
  });

  it('keeps Claude tool_use identity and demonstrates that Codex item.id is not the MCP call identity', async () => {
    const claude = await a0Events('claude-tools');
    const calls = claude.flatMap(event => (event['message'] as { content?: { type: string; id?: string; tool_use_id?: string }[] } | undefined)?.content ?? []);
    const ids = calls.filter(part => part.type === 'tool_use').map(part => part.id);
    const results = calls.filter(part => part.type === 'tool_result').map(part => part.tool_use_id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(results)).toEqual(new Set(ids));
    let correlated = 0;
    for (const event of await a0Events('codex-tools')) {
      const item = event['item'] as { type: string; id: string; result?: { content: { text: string }[] } } | undefined;
      if (item?.type !== 'mcp_tool_call' || !item.result) continue;
      const echoed = JSON.parse(item.result.content[0]!.text);
      expect(echoed.meta.callId).toMatch(/^call_/u);
      expect(echoed.meta.itemId).toMatch(/^fc_/u);
      expect(item.id).not.toBe(echoed.meta.callId);
      expect(item.id).not.toBe(echoed.meta.itemId);
      correlated++;
    }
    expect(correlated).toBe(4);
  });

  it('allows only the exact recorded Codex code-mode error notice and rejects a native escape injection', async () => {
    const { agent } = nativeCliAgent(registry.adapters.codex.headless.protocolFamily)!;
    const events = await a0Events('codex-tools');
    const items = events.map(event => event['item']).filter(Boolean) as Record<string, unknown>[];
    expect(items.some(item => item['type'] === 'error')).toBe(true);
    for (const item of items) expect(nativeAgentItemReason(agent, item)).toBeNull();
    const notice = items.find(item => item['type'] === 'error')!;
    expect(nativeAgentItemReason(agent, { ...notice, message: notice['message'] + ' foreign' })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    expect(nativeAgentItemReason(agent, { type: 'command_execution', command: 'fixture-native-escape' })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
  });

  it('retains timeout/revoke/cancel failures without turning process success into effect success', async () => {
    const claudeCancel = await a0Events('claude-cancel');
    expect(claudeCancel.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution', is_error: true });
    const codexCancel = await a0Events('codex-cancel');
    expect(codexCancel.at(-1)).toMatchObject({ type: 'item.started', item: { type: 'mcp_tool_call', status: 'in_progress', result: null } });
    for (const id of ['claude-timeout', 'codex-timeout']) expect(JSON.stringify(await a0Events(id))).toContain('timed out');
    for (const id of ['claude-revoke', 'codex-revoke']) expect(JSON.stringify(await a0Events(id))).toContain('revoked');
    for (const id of ['claude-idle', 'codex-idle']) expect(JSON.stringify(await a0Events(id))).toMatch(/ECONNRESET|Transport send error/u);
    for (const id of ['claude-keepalive', 'codex-keepalive']) expect(JSON.stringify(await a0Events(id))).toContain('relay-http');
    // A0 echoes are spike data, not a fabricated Deckent result envelope.
    expect(nativeAgentCorrelationSchema.safeParse({ kind: 'codex-mcp', itemId: 'item_2' }).success).toBe(false);
    expect(nativeAgentToolResultSchema.safeParse({ status: 'recorded-no-effect' }).success).toBe(false);
  });
});
