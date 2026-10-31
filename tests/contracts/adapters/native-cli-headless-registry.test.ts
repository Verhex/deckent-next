import { describe, expect, it } from 'vitest';
import { nativeCliHeadless, parseNativeCliRegistry } from '#adapters/core/native-cli-registry/index.js';
import { parseClaudeStreamLine, nativeQuotaPolicy } from '#adapters/core/native-connection/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };
import { CODEX_FAMILY } from '../../fixtures/native-headless/codex.js';
import { FAMILY, PINNED, assistantLine, happyLines, initLine, rateLimitLine, resultLine, uiLine } from '../../fixtures/native-headless/stream.js';

describe('S3-1 headless registry data', () => {
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
    expect(codex.command.capabilities.eventStream).toBe('codex-exec-json');
    expect(codex.headless.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', 'approval_policy="never"',
      'features.shell_tool=false', 'features.unified_exec=false', 'web_search="disabled"', 'tools.view_image=false', 'features.apps=false', 'features.multi_agent=false']));
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
