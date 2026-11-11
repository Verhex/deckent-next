import { nativeBuiltinPlugins, createClaudeAgentDriver, classifyClaudeRateLimit, nativeQuotaRejection, nativeQuotaText, type ToolSessionPort } from '#capabilities/index.js';
import { headlessRejectionBodySchema } from '#domain/index.js';
import { nativeHeadlessInitRefusal as initGuard } from '#adapters/core/native-cli-headless/index.js';
import { resolve } from 'node:path';
import { nativeCliHeadlessDefinitionSchema } from '#adapters/core/native-cli-headless/index.js';
import { describe, expect, it } from 'vitest';
import { nativeCliHeadless, nativeCliAgent, parseNativeCliRegistry } from '#adapters/core/native-cli-registry/index.js';
import { headlessFlagSetDigest, nativeAgentFlagSetDigest, nativeAgentInitReason, nativeAgentItemReason, toolSessionSchema, nativeAgentCorrelationSchema,
  nativeAgentToolResultSchema, nativeAgentReadinessSchema, nativeAgentReadinessReasonSchema } from '#adapters/core/native-cli-headless/index.js';
import { t, clockText } from '#platform/core/i18n/index.js';
import { nativeQuotaPolicy, parseClaudeStreamLine } from '#adapters/core/native-connection/index.js';
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
  it('accepts Claude builtins as a class while refusing foreign provenance, duplicates and expanded tool surfaces', () => {
    const { agent, bridge } = nativeCliAgent(FAMILY)!;
    if (agent.transport.kind !== 'claude-mcp') throw new Error('fixture');
    const entry = nativeCliHeadless(FAMILY)!;
    if (!('apiKeySources' in entry.headless.guards)) throw new Error('fixture');
    const headlessGuards = entry.headless.guards;
    const textGuard = (over: Record<string, unknown>) => { const line = parseClaudeStreamLine(JSON.stringify(initLine(over)));
      if (line.kind !== 'init') throw new Error('fixture');
      return initGuard(line, { model: PINNED }, headlessGuards, { version: '9.1.0' }, '/run/dir'); };
    const policy = agent.transport.guards.plugins, textPolicy = registry.adapters.claude.headless.guards.plugins;
    expect(policy).toEqual(textPolicy);
    for (const guards of ['headless', 'agent'] as const) {
      for (const over of [{ path: '/tmp/plugin' }, { sourceTemplate: '{name}@inline' }]) {
        const invalid = structuredClone(registry);
        Object.assign(guards === 'headless' ? invalid.adapters.claude.headless.guards.plugins : invalid.adapters.claude.agent.transport.guards.plugins, over);
        expect(() => parseNativeCliRegistry(invalid)).toThrow('NATIVE_CLI_REGISTRY_INVALID');
      }
    }
    const five = ['cc-plugin-sec-default', 'cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring']
      .map(name => ({ name, path: 'builtin', source: `${name}@builtin` }));
    expect(nativeBuiltinPlugins(five, policy)).not.toBeNull();
    expect(nativeBuiltinPlugins(five, textPolicy)).not.toBeNull();
    const unseen = { name: 'cc-plugin-unseen', path: 'builtin', source: 'cc-plugin-unseen@builtin' };
    expect(nativeBuiltinPlugins([unseen], policy)).toEqual(['cc-plugin-unseen']);
    expect(textGuard({ plugins: [...five, unseen] })).toBeNull();
    expect(textGuard({ plugins: five, tools: ['Bash'] })).toMatchObject({ body: { field: 'tools' } });
    // Both paths require source, including an init where no entry carries it.
    expect(textGuard({ plugins: [{ name: unseen.name, path: 'builtin' }] })).toMatchObject({ body: { field: 'plugins' } });
    for (const plugins of [[{ ...unseen, path: '/tmp/plugin' }], [{ ...unseen, source: 'cc-plugin-unseen@market' }],
      [{ ...unseen, source: 'another-name@builtin' }], [{ ...unseen, path: '/tmp/plugin', source: 'cc-plugin-unseen@inline' }],
      [{ ...unseen, path: '/tmp/plugin', source: 'cc-plugin-unseen@builtin' }],
      [{ name: 'cc-plugin-privacy', path: '/tmp/plugin', source: 'cc-plugin-privacy@inline' }, ...five], [unseen, unseen], [null], [{}],
      [{ ...unseen, name: 3 }], [{ ...unseen, name: '' }], [unseen, { name: 'missing-source', path: 'builtin' }]]) {
      expect(nativeBuiltinPlugins(plugins, policy)).toBeNull();
      expect(nativeBuiltinPlugins(plugins, textPolicy)).toBeNull();
      expect(textGuard({ plugins })).toMatchObject({ body: { field: 'plugins' } });
    }
    expect(nativeBuiltinPlugins([{ name: unseen.name, path: 'builtin' }], policy)).toBeNull();
    // Literal wire shape from A0-2(c); source has more tools, this session deliberately exposes only read_file.
    const init = { type: 'system', subtype: 'init', tools: ['mcp__deckent__read_file'], mcp_servers: [{ name: 'deckent', status: 'connected', source: 'dynamic' }],
      plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' }], skills: [], slash_commands: [], permissionMode: 'dontAsk', apiKeySource: 'none' };
    expect(nativeAgentInitReason(agent, bridge, session, init)).toBeNull();
    for (const plugins of [[{ ...unseen, path: '/tmp/plugin' }], [{ ...unseen, source: 'cc-plugin-unseen@inline' }],
      [{ ...unseen, source: 'another-name@builtin' }], [{ ...unseen, path: '/tmp/plugin', source: 'cc-plugin-unseen@inline' }],
      [unseen, unseen], [{ name: 'cc-plugin-privacy', path: '/tmp/plugin', source: 'cc-plugin-privacy@inline' }, ...five]]) {
      expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins })).toBe('NATIVE_AGENT_PLUGIN_UNEXPECTED');
    }
    for (const plugins of [[null], [{}], [{ name: unseen.name, path: 'builtin' }], [{ ...unseen, name: 3 }]]) {
      expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    }

    expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins: [...five, unseen] })).toBeNull();
    // Presentation bounds never narrow the provenance class, including odd and very long identities.
    for (const names of [['x'.repeat(4096)], ['cc-plugin-new\n\t\u0001name'], Array.from({ length: 100 }, (_, i) => `cc-plugin-new-${i}`)]) {
      const plugins = names.map(name => ({ name, path: 'builtin', source: `${name}@builtin` }));
      expect(nativeBuiltinPlugins(plugins, policy)).toEqual(names);
      expect(textGuard({ plugins })).toBeNull();
      expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins })).toBeNull();
    }
    const closure = { turnId: session.turnId, generation: session.generation, pendingCallIds: [], termination: 'confirmed' as const, effects: 'settled' as const };
    const port: ToolSessionPort = { session, propose: async () => { throw new Error('no tool expected'); },
      cancel: async () => ({ ...closure, kind: 'cancelled' }), revoke: async () => ({ ...closure, kind: 'revoked' }) };
    const stream = createClaudeAgentDriver({ entry: nativeCliAgent(FAMILY)!, port, model: PINNED, cliVersion: '2.1.322', runDir: '/run/dir', outputMaxBytes: 8192, quotaPolicy: nativeQuotaPolicy() });
    expect(stream.line(JSON.stringify({ ...init, plugins: [...five, unseen], model: PINNED, claude_code_version: '2.1.322', cwd: '/run/dir' }))).toBeUndefined();
    expect(stream.builtinPlugins()).toContain('cc-plugin-unseen');
    expect(stream.line(JSON.stringify(resultLine('ok')))).toBeUndefined();
    expect(stream.finish({ reason: 'exit', exitCode: 0, stdoutTruncated: false, stderrTruncated: false })).toMatchObject({ kind: 'completed' });
    for (const extra of [{ plugin_errors: [{ plugin: 'cc-plugin-unseen', type: 'failed' }] }, { plugin_errors: {} }]) {
      const failed = createClaudeAgentDriver({ entry: nativeCliAgent(FAMILY)!, port, model: PINNED, cliVersion: '2.1.322', runDir: '/run/dir', outputMaxBytes: 8192, quotaPolicy: nativeQuotaPolicy() });
      expect(failed.line(JSON.stringify({ ...init, plugins: five, model: PINNED, claude_code_version: '2.1.322', cwd: '/run/dir', ...extra }))).toBe('stop');
      expect(textGuard({ plugins: five, ...extra })).toMatchObject({ body: { field: 'pluginErrors' } });
    }

    expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins: [{ ...init.plugins[0], path: '/tmp/plugin' }] })).toBe('NATIVE_AGENT_PLUGIN_UNEXPECTED');
    for (const extra of [{ skills: ['skill'] }, { slash_commands: ['command'] }, { mcp_servers: [...init.mcp_servers, { name: 'extra', status: 'connected' }] }]) {
      expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins: five, ...extra })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
      if (!('slash_commands' in extra)) expect(textGuard({ plugins: five, ...extra })).not.toBeNull();
    }
    for (const tools of [['Read'], ['mcp__foreign__read_file'], ['mcp__deckent__decide_approval'], ['mcp__deckent__read_file', 'mcp__deckent__write_file'], undefined]) {
      expect(nativeAgentInitReason(agent, bridge, session, { ...init, plugins: five, tools })).toBe('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
    }
  });
  it('stops Claude limits using registry policy, preserves bounded v1 evidence and renders EN/TR without a realm', () => {
    const { bridge } = nativeCliAgent(FAMILY)!;
    const init = initLine({ tools: session.tools.map(tool => bridge.toolPrefix + tool.name), mcp_servers: [{ name: bridge.serverName, status: 'connected' }] });
    const closure = { turnId: session.turnId, generation: 1, pendingCallIds: [], termination: 'confirmed' as const, effects: 'settled' as const };
    const port: ToolSessionPort = { session, propose: async () => { throw new Error('no tool expected'); },
      cancel: async () => ({ ...closure, kind: 'cancelled' }), revoke: async () => ({ ...closure, kind: 'revoked' }) };
    const start = (quotaPolicy = nativeQuotaPolicy(), paidExtraUsage: 'continue' | 'stop-at-limit' = 'continue') => {
      const driver = createClaudeAgentDriver({ entry: nativeCliAgent(FAMILY)!, port, model: PINNED, cliVersion: '2.1.322', runDir: '/run/dir', outputMaxBytes: 8192, quotaPolicy, paidExtraUsage });
      driver.line(JSON.stringify({ ...init, model: PINNED, claude_code_version: '2.1.322', cwd: '/run/dir' }));
      return driver;
    };
    for (const status of ['allowed', 'allowed_warning']) {
      const driver = start();
      expect(driver.line(JSON.stringify(rateLimitLine(status)))).toBeUndefined();
      driver.line(JSON.stringify(resultLine('ok')));
      expect(driver.finish({ reason: 'exit', exitCode: 0, stdoutTruncated: false, stderrTruncated: false }).kind).toBe('completed');
    }
    const unrecognisedOverage = start();
    expect(unrecognisedOverage.line(JSON.stringify(rateLimitLine('rejected', { overageStatus: 'future-overage' })))).toBeUndefined();
    expect(unrecognisedOverage.paidExtraUsage()).toBeNull(); // Only registry-recognized paid availability produces the billing notice.
    for (const info of [
      { status: 'rejected', overageStatus: 'allowed', rateLimitType: 'five_hour', resetsAt: 1792773600 },
      { status: 'allowed', isUsingOverage: true }, { status: 'allowed_warning', overageInUse: true },
      { status: 'rejected', isUsingOverage: true, overageStatus: 'rejected' },
    ]) {
      const driver = start();
      expect(driver.line(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }))).toBeUndefined();
      expect(driver.paidExtraUsage()).toMatchObject({ kind: 'overage', status: info.status });
      driver.line(JSON.stringify(resultLine('ok')));
      expect(driver.finish({ reason: 'exit', exitCode: 0, stdoutTruncated: false, stderrTruncated: false }).kind).toBe('completed');
      const stopped = start(nativeQuotaPolicy(), 'stop-at-limit');
      expect(stopped.line(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }))).toBe('stop');
      expect(stopped.paidExtraUsage()).toBeNull();
      expect(stopped.finish({ reason: 'cancelled', exitCode: null, stdoutTruncated: false, stderrTruncated: false })).toMatchObject({ limit: { kind: 'quota' } });
    }
    for (const info of [
      { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792773600 },
      { status: 'rejected', rateLimitType: 'seven_day_opus', overageStatus: 'rejected' },
      { status: 'rejected', rateLimitType: 'odd\n\u001b' + 'x'.repeat(200), resetsAt: -1 },
      { status: 'rejected', rateLimitType: 'seven_day_sonnet', resetsAt: Number.MAX_SAFE_INTEGER },
      { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 'tomorrow' },
      { status: 'future-status', isUsingOverage: true, rateLimitType: 'odd\n\u001b' + 'x'.repeat(200) }, {},
      { status: 'rejected', errorCode: 'credits_required' },
    ]) {
      const driver = start();
      expect(driver.line(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }))).toBe('stop');
      expect(driver.signal.aborted).toBe(true);
      const result = driver.finish({ reason: 'cancelled', exitCode: null, stdoutTruncated: false, stderrTruncated: false });
      expect(result).toMatchObject({ kind: 'refused', field: !('status' in info) || info.status === 'future-status' ? 'rate-limit-status' : 'rate-limit' });
      if (result.kind === 'refused') {
        expect(result.detail!.length).toBeLessThanOrEqual(64); expect(result.detail).not.toContain('\n'); expect(result.detail).not.toContain('\u001b');
        const body = headlessRejectionBodySchema.parse({ schemaVersion: 1, ...nativeQuotaRejection(result.limit!) });
        for (const language of ['en', 'tr'] as const) {
          const text = nativeQuotaText(body, language)!;
          expect(text).not.toMatch(/\{\w+\}/u); expect(text).not.toContain('\n'); expect(text).not.toContain('\u001b');
          if ('errorCode' in info) expect(text).toContain(language === 'en' ? 'extra credits' : 'ek kredi');
          else if (info.status === 'future-status' || !('status' in info)) {
            expect(text).toContain(language === 'en' ? 'Unknown limit status' : 'Bilinmeyen limit durumu');
            expect(text).toContain('status' in info ? info.status! : '?');
          } else {
            expect(text).toContain(info.resetsAt === 1792773600 ? clockText(1792773600000) : language === 'en' ? 'unknown' : 'bilinmiyor');
            expect(text).toContain(language === 'en' ? 'stopped this turn instead of continuing on paid extra usage' : 'bu turu ücretli ek kullanımla sürdürmek yerine durdurdu');
            expect(text).toContain('deckent models login --connection claude-cli-subscription');
            if (info.rateLimitType === 'five_hour') expect(text).toContain(language === 'en' ? 'five-hour window' : 'beş saatlik pencere');
            if (info.rateLimitType === 'seven_day') expect(text).toContain(language === 'en' ? 'weekly window' : 'haftalık pencere');
            if (info.rateLimitType === 'seven_day_opus') expect(text).toContain(language === 'en' ? 'weekly window for Opus' : 'Opus için haftalık pencere');
            if (info.rateLimitType === 'seven_day_sonnet') expect(text).toContain(language === 'en' ? 'weekly window for Sonnet' : 'Sonnet için haftalık pencere');
            if (info.rateLimitType?.startsWith('odd')) expect(text).toContain('odd__' + 'x'.repeat(19));
          }
        }
      }
    }
    const missing = start();
    expect(missing.line('{"type":"rate_limit_event"}')).toBe('stop');
    expect(missing.finish({ reason: 'exit', exitCode: 0, stdoutTruncated: false, stderrTruncated: false })).toMatchObject({ field: 'rate-limit-status', limit: { status: '?', resetsAtMs: null } });
    // Registry changes drive both hosts; a formerly allowed spelling must not bypass a new policy.
    const quotaPolicy = { ...nativeQuotaPolicy(), claudeAllowedStatuses: ['new-allowed'], claudeRejectedStatuses: ['allowed'] };
    expect(classifyClaudeRateLimit({ status: 'allowed' }, quotaPolicy, []).kind).toBe('quota');
    expect(start(quotaPolicy).line(JSON.stringify(rateLimitLine('allowed', { overageStatus: 'allowed' })))).toBe('stop');
    for (const language of ['en', 'tr'] as const) {
      const legacy = nativeQuotaText({ schemaVersion: 1, refusal: 'quota', resetsAtMs: null }, language)!;
      expect(legacy).toContain('/model');
      expect(legacy).not.toContain('claude-cli-subscription');
      const missingResult = missing.finish({ reason: 'exit', exitCode: 0, stdoutTruncated: false, stderrTruncated: false });
      if (missingResult.kind !== 'refused') throw new Error('fixture');
      const body = headlessRejectionBodySchema.parse({ schemaVersion: 1, ...nativeQuotaRejection(missingResult.limit!) });
      expect(nativeQuotaText(body, language)).toContain(language === 'en' ? 'Unknown limit status' : 'Bilinmeyen limit durumu');
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
