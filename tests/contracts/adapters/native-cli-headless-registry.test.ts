import { resolve } from 'node:path';
import { nativeCliHeadlessDefinitionSchema } from '#adapters/core/native-cli-headless/index.js';
import { describe, expect, it } from 'vitest';
import { nativeCliHeadless, nativeCliAgent, parseNativeCliRegistry } from '#adapters/core/native-cli-registry/index.js';
import { headlessFlagSetDigest, nativeAgentFlagSetDigest, nativeAgentInitReason, nativeAgentItemReason, toolSessionSchema, nativeAgentCorrelationSchema,
  nativeAgentToolResultSchema, nativeAgentReadinessSchema, nativeAgentReadinessReasonSchema } from '#adapters/core/native-cli-headless/index.js';
import { t } from '#platform/core/i18n/index.js';
import { parseClaudeStreamLine, nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };
import { CODEX_FAMILY } from '../../fixtures/native-headless/codex.js';
import { FAMILY, PINNED, assistantLine, happyLines, initLine, rateLimitLine, resultLine, uiLine } from '../../fixtures/native-headless/stream.js';

describe('S3-1 headless registry data', () => {
  it('never copies identity files through configEphemeral, even when they are visible', () => {
    for (const file of ['auth.json', '.credentials.json', '.claude.json']) {
      const invalid = structuredClone(registry);
      invalid.adapters.codex.headless.isolation.configVisible.push(file);
      invalid.adapters.codex.headless.isolation.configEphemeral.files = [file];
      expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
    }
  });
  it('selects the headless CLI by protocol family data and keeps every forbidden flag out of the argv', () => {
    const found = nativeCliHeadless(FAMILY);
    expect(found).not.toBeNull();
    const { headless, command } = found!;
    expect(command.capabilities.eventStream).toBe(FAMILY);
    expect(headless.args).toEqual(expect.arrayContaining(['--safe-mode', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']));
    expect(headless.args[headless.args.indexOf('--tools') + 1]).toBe('');
    expect(headless.forbiddenFlags).toEqual(expect.arrayContaining(['--fallback-model', '--bare', '--dangerously-skip-permissions', '--mcp-config', '--json-schema']));
    for (const flag of headless.forbiddenFlags) expect(headless.args.some(arg => arg === flag || arg.startsWith(flag + '='))).toBe(false);
    expect(headless.maxTurns).toBe(1);
    expect(nativeCliHeadless('unknown-family')).toBeNull();
    // Codex: found by its catalog family (not its event-stream name), every tool switch off, read-only, one turn bounded by the line guard.
    expect(nativeCliHeadless('codex-exec-json')).toBeNull();
    const codex = nativeCliHeadless(CODEX_FAMILY)!;
    expect(codex.headless.revision).toBe('codex-headless-2026-11-01-r4');
    expect(codex.headless.guards).toMatchObject({ maxNotices: 1 });
    for (const guards of [{ ...registry.adapters.codex.headless.guards, maxNotices: 0 },
      { ...registry.adapters.codex.headless.guards, noticePatterns: undefined }]) {
      const invalid = structuredClone(registry);
      Object.assign(invalid.adapters.codex.headless, { guards });
      expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
    }
    expect(codex.headless.isolation.configVisible).toEqual(['auth.json', 'config.toml', 'installation_id']);
    expect(codex.headless.isolation.configEphemeral).toEqual({ files: ['installation_id'], maxBytes: 4096 });
    for (const configEphemeral of [{ files: ['..'], maxBytes: 4096 }, { files: ['not-visible'], maxBytes: 4096 }, { files: ['installation_id'], maxBytes: 0 }]) {
      const invalid = structuredClone(registry);
      invalid.adapters.codex.headless.isolation.configEphemeral = configEphemeral;
      expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
    }
    expect(codex.command.capabilities.eventStream).toBe('codex-exec-json');
    expect(codex.headless.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', 'approval_policy="never"',
      'features.code_mode_host=false', 'features.shell_tool=false', 'features.unified_exec=false', 'web_search="disabled"', 'features.view_image=false', 'features.apps=false', 'features.multi_agent=false']));
    for (const flag of codex.headless.forbiddenFlags) expect(codex.headless.args.some(arg => arg === flag || arg.startsWith(flag + '='))).toBe(false);
    expect([codex.command.capabilities.maxTurns, codex.headless.turnBound]).toEqual([null, 'stream']);
    const unbounded = structuredClone(registry) as unknown as { adapters: { codex: { headless: Record<string, unknown> } } };
    delete unbounded.adapters.codex.headless.turnBound;
    expect(() => parseNativeCliRegistry(unbounded)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  });
  it('builds the environment from named data only: retries 0, no updater, and every credential override is a deny name', () => {
    const { env } = nativeCliHeadless(FAMILY)!.headless;
    expect(env.fixed).toMatchObject({ CLAUDE_CODE_MAX_RETRIES: '0', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(env.runDir).toEqual(expect.arrayContaining(['HOME', 'TMPDIR']));
    expect(env.deny).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_RETRY_WATCHDOG']));
    const built = [...Object.keys(env.fixed), ...env.runDir, env.configDir];
    expect(built.filter(name => env.deny.includes(name))).toEqual([]);
  });
  it.each([
    ['a forbidden flag in the argv', (h: Record<string, unknown>) => { h.args = [...(h.args as string[]), '--fallback-model']; }],
    ['a forbidden flag with an inline value', (h: Record<string, unknown>) => { h.args = [...(h.args as string[]), '--bare=1']; }],
    ['a deny name in the built environment', (h: Record<string, unknown>) => { (h.env as Record<string, unknown>).fixed = { ...(h.env as { fixed: object }).fixed, ANTHROPIC_API_KEY: 'x' }; }],
    ['an unknown field', (h: Record<string, unknown>) => { h.extra = true; }],
    ['a missing bound', (h: Record<string, unknown>) => { delete (h.limits as Record<string, unknown>).killGraceMs; }],
    ['a non-positive bound', (h: Record<string, unknown>) => { (h.limits as Record<string, unknown>).maxLineBytes = 0; }],
    ['an empty deny list', (h: Record<string, unknown>) => { (h.env as Record<string, unknown>).deny = []; }],
    ['no isolation realm (S3-5)', (h: Record<string, unknown>) => { delete h.isolation; }],
    ['a proxy off the realm loopback', (h: Record<string, unknown>) => { ((h.isolation as Record<string, unknown>).proxy as Record<string, unknown>).host = '0.0.0.0'; }],
    ['a gateway socket outside /run', (h: Record<string, unknown>) => { (h.isolation as Record<string, unknown>).socketPath = '/home/x/egress.sock'; }],
    ['a visible login entry that climbs out', (h: Record<string, unknown>) => { (h.isolation as Record<string, unknown>).configVisible = ['..']; }],
    ['a proxy variable that is a deny name', (h: Record<string, unknown>) => { (h.env as { deny: string[] }).deny = [...(h.env as { deny: string[] }).deny, 'HTTPS_PROXY']; }],
    ['a relative realm shell', (h: Record<string, unknown>) => { (h.isolation as Record<string, unknown>).shell = 'sh'; }],
    ['f5 a relative limiter', (h: Record<string, unknown>) => { ((h.isolation as Record<string, unknown>).limits as Record<string, unknown>).limiter = 'prlimit'; }],
    ['f5 no CPU time bound', (h: Record<string, unknown>) => { delete ((h.isolation as Record<string, unknown>).limits as Record<string, unknown>).cpuSeconds; }],
    ['f5 two bounds sharing one exit code', (h: Record<string, unknown>) => { ((h.isolation as Record<string, unknown>).limits as Record<string, unknown>).exits = { 'cpu-time': 201, processes: 201, memory: 203 }; }],
  ])('refuses a registry with %s', (_label, change) => {
    const asset = structuredClone(registry) as unknown as { adapters: { claude: { headless: Record<string, unknown> } } };
    change(asset.adapters.claude.headless);
    expect(() => parseNativeCliRegistry(asset)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  });
  it('shares the worker quota classification instead of a second list', () => {
    expect(nativeQuotaPolicy().claudeRejectedStatuses).toEqual(['rejected']);
  });
});

describe('S3-1 shared stream-json line parser', () => {
  it('types the measured line shapes', () => {
    const [ui, init, assistant, rate, result] = happyLines('{"ok":true}').map(line => parseClaudeStreamLine(JSON.stringify(line)));
    expect(ui).toMatchObject({ kind: 'system', subtype: 'ui_invalidate' });
    expect(init).toMatchObject({ kind: 'init', model: PINNED, cliVersion: '9.1.0', apiKeySource: 'none', permissionMode: 'dontAsk', tools: [], mcpServers: [], skills: [] });
    expect(assistant).toMatchObject({ kind: 'assistant', blocks: [{ type: 'text', text: '{"ok":true}' }], message: { model: PINNED } });
    expect(rate).toMatchObject({ kind: 'rate-limit', status: 'allowed', resetsAt: 1792773600, window: 'five_hour', errorCode: null });
    expect(rate.kind === 'rate-limit' && rate.windows.map(([key]) => key)).toEqual(['five_hour', 'seven_day']);
    expect(result).toMatchObject({ kind: 'result', subtype: 'success', isError: false, stopReason: 'end_turn', result: '{"ok":true}', apiErrorStatus: null, errors: [] });
    expect(result.kind === 'result' && Object.keys(result.modelUsage ?? {})).toEqual([PINNED]);
  });
  it('is total: invalid, blank, non-object, untyped and mistyped fields never throw', () => {
    expect(parseClaudeStreamLine('not json')).toEqual({ kind: 'invalid', reason: 'non-json' });
    expect(parseClaudeStreamLine('   ')).toEqual({ kind: 'invalid', reason: 'blank' });
    for (const raw of ['5', 'null', '"text"', '[1]']) expect(parseClaudeStreamLine(raw)).toEqual({ kind: 'invalid', reason: 'non-object' });
    expect(parseClaudeStreamLine('{"x":1}')).toMatchObject({ kind: 'other', type: 'untyped' });
    expect(parseClaudeStreamLine(JSON.stringify(initLine({ model: 7, apiKeySource: null })))).toMatchObject({ kind: 'init', model: null, apiKeySource: null });
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'assistant', message: { content: [null, 'x', { type: 'text', text: 'a' }] } })))
      .toMatchObject({ kind: 'assistant', blocks: [{}, {}, { type: 'text', text: 'a' }] });
    expect(parseClaudeStreamLine(JSON.stringify(rateLimitLine('rejected', { unifiedWindows: 'bad', errorCode: 'credits_required' }))))
      .toMatchObject({ kind: 'rate-limit', status: 'rejected', windows: [], errorCode: 'credits_required' });
    expect(parseClaudeStreamLine(JSON.stringify(resultLine('', { modelUsage: [1], api_error_status: 429, errors: ['authentication_failed', 3] }))))
      .toMatchObject({ kind: 'result', modelUsage: null, apiErrorStatus: 429, errors: ['authentication_failed'] });
    expect(parseClaudeStreamLine(JSON.stringify(uiLine())).kind).toBe('system');
    expect(parseClaudeStreamLine(JSON.stringify(assistantLine('a', 'other-model')))).toMatchObject({ message: { model: 'other-model' } });
  });
});

const tool = { name: 'read_file', version: 1, toolClass: 'read' as const, description: 'Read the scoped record', inputSchema: { type: 'object' as const, properties: {} } };
const session = toolSessionSchema.parse({ schemaVersion: 1, turnId: 'turn-1', generation: 1, tools: [tool], approvalTtlMs: 120000 });
describe('A63-K0 separate NativeAgentExecution v1 contract', () => {
  it('keeps both v1 seals and argv intact while sealing a separate sourced HTTP agent profile', () => {
    const claude = nativeCliAgent(FAMILY)!, codex = nativeCliAgent(CODEX_FAMILY)!;
    expect(headlessFlagSetDigest(claude)).toBe('05c1077990d8c3a58cb7b572a0c9e7c26764daac1233d42fb02bad33f645d739');
    expect(headlessFlagSetDigest(codex)).toBe('d2486ce12d386924b1e9fa39140d3d677d11bc4164c4cdf4c336e0689fe76704');
    expect(nativeAgentFlagSetDigest(claude)).not.toBe(headlessFlagSetDigest(claude));
    expect(nativeAgentFlagSetDigest({ ...claude, bridge: { ...claude.bridge, bodyMaxBytes: claude.bridge.bodyMaxBytes + 1 } })).not.toBe(nativeAgentFlagSetDigest(claude));
    expect(claude.agent.args).toEqual([...claude.headless.args.filter((arg, index, args) => arg !== '--safe-mode' && arg !== '--disallowedTools' && args[index - 1] !== '--disallowedTools'),
      '--mcp-config', '{mcpConfigFile}', '--allowedTools', '{toolList}', '--max-turns', '{maxTurns}']);
    expect(codex.agent.args).toEqual([codex.headless.args[0], '-c', 'agents.enabled=false', '-c', 'features.plugins=false', ...codex.headless.args.slice(1)]);
    expect(codex.agent.configSources).toEqual([
      { value: 'agents.enabled=false', source: expect.stringContaining('config/mod.rs:1690') },
      { value: 'features.plugins=false', source: expect.stringContaining('manager.rs:2894') },
    ]);
    expect(codex.agent.transport).toMatchObject({ mcpConfig: { url: '{bridgeUrl}', bearer_token_env_var: '{turnTokenEnv}',
      required: true, enabled_tools: '{toolNames}', omit_tools_from: ['deferred', 'code_mode'], default_tools_approval_mode: 'approve', tool_timeout_sec: '{approvalTtlSeconds}' } });
    expect(claude.agent.loginMethods.map(row => row.method)).toEqual(['claudeai']);
    expect(codex.agent.loginMethods.map(row => row.method)).toEqual(['browser', 'device-auth']);
    expect(codex.agent.loginMethods[1]!.args).toEqual([...codex.headless.login.args, '--device-auth']);
    expect(codex.bridge).toMatchObject({ topology: 'relay-http', sentinelHost: 'deckent-mcp.invalid', path: '/mcp', fallback: { enabled: false } });
    expect(nativeCliAgent('unknown')).toBeNull();
    expect(toolSessionSchema.safeParse({ ...session, approvalTtlMs: 0 }).success).toBe(false);
    expect(toolSessionSchema.safeParse({ ...session, tools: [{ ...tool, name: 'decide_approval' }] }).success).toBe(false);
    const result = { schemaVersion: 1, turnId: session.turnId, generation: session.generation, deckentCallId: 'deckent-1', outcome: { status: 'error', text: 'revoked' } };
    expect(nativeAgentToolResultSchema.safeParse(result).success).toBe(true);
    expect(nativeAgentToolResultSchema.safeParse({ ...result, deckentCallId: undefined }).success).toBe(false);
    expect(nativeAgentCorrelationSchema.safeParse({ kind: 'claude-tool-use', toolUseId: 'toolu_1', deckentCallId: 'deckent-1' }).success).toBe(true);
    expect(nativeAgentCorrelationSchema.safeParse({ kind: 'codex-mcp', callId: 'call_1', itemId: 'fc_1', deckentCallId: 'deckent-1' }).success).toBe(true);
    expect(nativeAgentCorrelationSchema.safeParse({ kind: 'codex-mcp', itemId: 'item_1', deckentCallId: 'deckent-1' }).success).toBe(false);
    expect(nativeAgentReadinessSchema.safeParse({ state: 'ready' }).success).toBe(false);
    for (const reason of nativeAgentReadinessReasonSchema.options) {
      expect(nativeAgentReadinessSchema.safeParse({ state: 'unknown', reason }).success).toBe(true);
      for (const locale of ['en', 'tr'] as const) expect(t(`headless.agent.reason.${reason}`, {}, locale)).not.toBe(`headless.agent.reason.${reason}`);
    }
  });
  it('accepts only the generated MCP template and refuses free paths, inline overrides and stdio configuration', () => {
    const legacy = structuredClone(registry);
    legacy.adapters.claude.agent.transport.mcpConfig.server.headers.Authorization = '{turnTokenHeader}';
    expect(() => parseNativeCliRegistry(legacy)).not.toThrow();
    expect(() => parseNativeCliRegistry(registry)).not.toThrow();
    const literal = structuredClone(registry);
    literal.adapters.claude.agent.transport.mcpConfig.server.headers.Authorization = 'not-a-token-reference';
    expect(() => parseNativeCliRegistry(literal)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
    for (const value of ['/tmp/foreign-mcp.json', '{arbitraryFile}', '--mcp-config=/tmp/foreign.json']) {
      const invalid = structuredClone(registry), args = invalid.adapters.claude.agent.args;
      args[args.indexOf('--mcp-config') + 1] = value;
      expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
    }
    const inline = structuredClone(registry);
    inline.adapters.claude.agent.args.push('--mcp-config=/tmp/foreign.json');
    expect(() => parseNativeCliRegistry(inline)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
    const stdio = structuredClone(registry);
    Object.assign(stdio.adapters.codex.agent.transport.mcpConfig, { command: 'node', args: [] });
    expect(() => parseNativeCliRegistry(stdio)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  });
  it('refuses a Claude seal for a foreign plugin, plugin provenance or tool; missing fields also fail closed', () => {
    const { agent, bridge } = nativeCliAgent(FAMILY)!;
    // Literal wire shape from A0-2(c); source has more tools, this session deliberately exposes only read_file.
    const init = { type: 'system', subtype: 'init', tools: ['mcp__deckent__read_file'], mcp_servers: [{ name: 'deckent', status: 'connected', source: 'dynamic' }],
      plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' }], skills: [], slash_commands: [], permissionMode: 'dontAsk', apiKeySource: 'none' };
    expect(nativeAgentInitReason(agent, bridge, session, init)).toBeNull();
    expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins: [...init.plugins, { name: 'foreign', path: 'builtin', source: 'foreign@builtin' }] })).toBe('NATIVE_AGENT_PLUGIN_UNEXPECTED');
    expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins: [{ ...init.plugins[0], path: '/tmp/plugin' }] })).toBe('NATIVE_AGENT_PLUGIN_UNEXPECTED');
    for (const tools of [['Read'], ['mcp__foreign__read_file'], ['mcp__deckent__decide_approval'], ['mcp__deckent__read_file', 'mcp__deckent__write_file'], undefined]) {
      expect(nativeAgentInitReason(agent, bridge, session, { ...init, tools })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    }
  });
  it('fails closed on native/unknown Codex items and allows only the exact measured code-mode notice', () => {
    const { agent } = nativeCliAgent(CODEX_FAMILY)!;
    for (const type of ['agent_message', 'mcp_tool_call', 'reasoning']) expect(nativeAgentItemReason(agent, { type })).toBeNull();
    for (const type of ['command_execution', 'file_change', 'web_search', 'unknown']) expect(nativeAgentItemReason(agent, { type })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    const message = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
    expect(nativeAgentItemReason(agent, { type: 'error', message })).toBeNull();
    expect(nativeAgentItemReason(agent, { type: 'error', message: message + '\nforeign' })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    expect(nativeAgentItemReason(agent, { type: 'error' })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    const invalid = structuredClone(registry);
    invalid.adapters.codex.agent.transport.guards.allowedItems.push('command_execution');
    expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
  });
  it('inherits deny-env enforcement and requires the sentinel to stay behind the existing HTTP proxy', () => {
    for (const cli of ['claude', 'codex'] as const) {
      for (const name of registry.adapters[cli].headless.env.deny) {
        const invalid = structuredClone(registry);
        Object.assign(invalid.adapters[cli].headless.env.fixed, { [name]: 'forbidden' });
        expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
      }
      const invalid = structuredClone(registry);
      invalid.agentBridge.tokenEnvName = invalid.adapters[cli].headless.env.deny[0]!;
      expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
      const bypass = structuredClone(registry);
      bypass.adapters[cli].headless.isolation.proxy.clear = [];
      Object.assign(bypass.adapters[cli].headless.env.fixed, { NO_PROXY: 'deckent-mcp.invalid' });
      expect(() => parseNativeCliRegistry(bypass)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
      const collision = structuredClone(registry);
      collision.agentBridge.tokenEnvName = 'HTTP_PROXY';
      expect(() => parseNativeCliRegistry(collision)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
    }
  });
});

it('expands the strict legacy headless definition with only a versioned optional source binding', () => {
  const legacy = { schemaVersion: 1, executable: resolve('fixture-cli'), configDir: resolve('fixture-login'), stateDir: resolve('fixture-state'),
    ownerUid: 1000, minCliVersion: '1.0.0', delegatedUse: null };
  expect(nativeCliHeadlessDefinitionSchema.parse(legacy)).toEqual(legacy);
  const sourceBinding = { schemaVersion: 1, installationId: 'installation', companyId: 'company', scopeId: 'scope', principal: { issuer: 'host', subject: '1000' } };
  expect(nativeCliHeadlessDefinitionSchema.parse({ ...legacy, sourceBinding })).toEqual({ ...legacy, sourceBinding });
  expect(nativeCliHeadlessDefinitionSchema.safeParse({ ...legacy, unknown: true }).success).toBe(false);
  expect(nativeCliHeadlessDefinitionSchema.safeParse({ ...legacy, sourceBinding: { ...sourceBinding, schemaVersion: 2 } }).success).toBe(false);
  expect(nativeCliHeadlessDefinitionSchema.safeParse({ ...legacy, sourceBinding: { ...sourceBinding, principal: {} } }).success).toBe(false);
  expect(nativeCliHeadlessDefinitionSchema.safeParse({ ...legacy, sourceBinding: { ...sourceBinding, extra: true } }).success).toBe(false);
});
