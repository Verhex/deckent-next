import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseModelBindingDefinition, parseModelInvocationProfile, readHeadlessRejection, type ModelInvocationDelta } from '#domain/index.js';
import { NATIVE_CLI_HEADLESS_ADAPTER, createNativeCliHeadlessPort } from '#adapters/core/native-cli-headless/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { PINNED, assistantLine, headless, initLine, rateLimitLine, resultLine, uiLine, fullHelp, writeFakeCli, type FakeScenario, type FakeStep } from '../../fixtures/native-headless/stream.js';
import { PROMPT, binding, cleanupConnections, connection, request, testIsolation } from '../../fixtures/native-headless/connection.js';
import { CODEX_FAMILY, codexAnswer, codexHeadless, writeFakeCodexCli, type FakeCodexScenario } from '../../fixtures/native-headless/codex.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };
import { measureTestShellHost } from '../../fixtures/shell-host.js';
// S3-5: every headless CLI spawn runs in the bubblewrap realm; a host without one is covered by the real-sandbox guard, not silently here.
const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';

afterEach(cleanupConnections);
const happy = (text = '{"ok":true}'): FakeStep[] => [uiLine(), initLine(), assistantLine(text), rateLimitLine(), resultLine(text)].map(line => ({ line }));
const body = (result: unknown) => JSON.parse(Buffer.from((result as { evidence: { body: { data: string } } }).evidence.body.data, 'base64').toString('utf8'));
const DENIED = headless.env.deny;

describe.skipIf(process.platform !== 'linux' || !sandbox)('S3-2 headless native port with a fake CLI (no real CLI, no model call)', () => {
  it('runs one guarded turn: built env, prompt never in argv, stdin message, 0600 prompt file removed, chat-shaped counters without cost', async () => {
    const saved = Object.fromEntries(DENIED.map(name => [name, process.env[name]]));
    for (const name of DENIED) process.env[name] = `leak-${name}`;
    try {
      const c = await connection({ steps: happy() }), deltas: ModelInvocationDelta[] = [];
      const result = await c.call(null, {}, undefined, deltas);
      expect(result).toMatchObject({ schemaVersion: 1, native: { object: 'chat.completion', model: PINNED,
        choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], headless: { cliVersion: '9.1.0', guard: 'passed' } },
      usage: { prompt_tokens: 586, completion_tokens: 9, total_tokens: 595, modelUsage: { [PINNED]: { inputTokens: 2, outputTokens: 9 } },
        quota: { five_hour: { utilizationPermille: 250, resetsAtMs: 1792773600000 }, seven_day: { utilizationPermille: 730 } } } });
      expect(JSON.stringify(result)).not.toMatch(/cost|usd/iu);
      expect(deltas).toEqual([{ kind: 'text', text: '{"ok":true}' }]);
      const entries = await c.log(), callEntry = entries.find(entry => entry.mode === 'call')!;
      // S3-5: the hidden-flag probes run isolated with an empty temporary config dir, so they cannot log into the login dir (see the probe test).
      expect(entries.map(entry => entry.mode)).toEqual(['version', 'help', 'auth', 'call']);
      for (const entry of entries.filter(item => !item.mode.startsWith('probe'))) {
        // N24/N25/N1: every spawn has the same built environment, HOME = cwd = the connection's run dir, no deny name, no inherited variable.
        expect(Object.keys(entry.env).sort()).toEqual([...Object.keys(headless.env.fixed), ...headless.env.runDir, headless.env.configDir, ...headless.isolation.proxy.env,
          ...headless.isolation.proxy.clear].sort());
        expect(entry.env.HOME).toBe(c.runDir); expect(entry.cwd).toBe(c.runDir); expect(entry.env[headless.env.configDir]).toBe(c.configDir);
      }
      // N18: argv carries no prompt or message text; the turn is bounded and the model pinned.
      expect(JSON.stringify(callEntry.argv)).not.toContain('PROMPT-CANARY');
      expect(JSON.stringify(callEntry.argv)).not.toContain('Answer only JSON');
      expect(callEntry.argv).toEqual(expect.arrayContaining(['--restricted', '--safe-mode', '--max-turns', '1', '--model', PINNED, headless.systemPromptFlag]));
      expect(callEntry).toMatchObject({ stdin: PROMPT, system: 'You are a planner. Answer only JSON.', systemMode: 0o600, entries: [headless.systemPromptFile] });
      expect(existsSync(join(c.runDir, headless.systemPromptFile))).toBe(false);
      // N21: the preflight record keeps the login kind, never the account's email or organization.
      const record = await readFile(join(c.root, 'state', 'preflight.json'), 'utf8');
      expect(JSON.parse(record)).toMatchObject({ state: 'open', version: '9.1.0', auth: { authMethod: 'claude.ai', apiProvider: 'firstParty' } });
      expect(record).not.toMatch(/example\.invalid|org-fixture|Fixture Org/u);
      expect((await stat(join(c.root, 'state', 'preflight.json'))).mode & 0o777).toBe(0o600);
    } finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  });
  it('re-runs the preflight only when the executable changes; a failing preflight closes, a later pass reopens (N6)', async () => {
    const c = await connection({ steps: happy() });
    await c.call(); await c.call();
    expect((await c.log()).filter(entry => entry.mode === 'version')).toHaveLength(1);
    await c.write({ version: '8.9.9', steps: happy() }); await utimes(c.executable, new Date(), new Date(Date.now() + 5000));
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'version' } });
    expect(JSON.parse(await readFile(join(c.root, 'state', 'preflight.json'), 'utf8'))).toMatchObject({ state: 'closed', check: 'version' });
    await c.write({ version: '9.3.0', steps: happy().map(step => 'line' in step && typeof step.line === 'object' && step.line.subtype === 'init' ? { line: initLine({ claude_code_version: '9.3.0' }) } : step) });
    await utimes(c.executable, new Date(), new Date(Date.now() + 9000));
    await expect(c.call()).resolves.toMatchObject({ native: { headless: { cliVersion: '9.3.0' } } });
    expect(JSON.parse(await readFile(join(c.root, 'state', 'preflight.json'), 'utf8'))).toMatchObject({ state: 'open', version: '9.3.0' });
    // S7 (owner 2026-10-31): the person's path is kept and resolved per call. A self-update moves the symlink A → B and deletes A: one new check, then the
    // call runs B (doctor: "CLI updated"); a path that leads nowhere is the typed "CLI missing — reconnect" refusal, before any spawn.
    const linked = await connection({ steps: happy() }), link = join(linked.root, 'codex'), binB = join(linked.root, 'release-b');
    await symlink(linked.executable, link); await mkdir(binB);
    const pinned = parseModelInvocationProfile({ ...linked.profile, adapter: { ...linked.profile.adapter, definition: { ...linked.profile.adapter.definition as object, executable: link } } });
    const run = async () => { await linked.port.preflight(pinned); return linked.port.send(await linked.port.prepare(pinned, binding, request())); };
    await expect(run()).resolves.toMatchObject({ native: { headless: { cliVersion: '9.1.0' } } });
    const b = await writeFakeCli(binB, { initCwd: 'actual', logPath: linked.logPath, version: '9.3.0',
      steps: happy().map(step => 'line' in step && typeof step.line === 'object' && step.line.subtype === 'init' ? { line: initLine({ claude_code_version: '9.3.0' }) } : step) });
    await rm(link); await symlink(b, link); await rm(linked.executable);
    await expect(run()).resolves.toMatchObject({ native: { headless: { cliVersion: '9.3.0' } } });
    expect((await linked.log()).map(entry => entry.mode)).toEqual(['version', 'help', 'auth', 'call', 'version', 'help', 'auth', 'call']);
    expect(JSON.parse(await readFile(join(linked.root, 'state', 'preflight.json'), 'utf8'))).toMatchObject({ state: 'open', version: '9.3.0', updatedFrom: '9.1.0', executable: b });
    await rm(b);
    const missing = await linked.port.preflight(pinned).catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: 'HEADLESS_CLI_UNAVAILABLE' });
    expect(ErrorRegistry.get('HEADLESS_CLI_UNAVAILABLE', 'en')?.message).toContain('Reconnect: deckent models connect --connection <connection>');
    expect(ErrorRegistry.get('HEADLESS_CLI_UNAVAILABLE', 'tr')?.message).toContain('Yeniden bağlanın: deckent models connect --connection <bağlantı>');
    expect((await linked.log()).filter(entry => entry.mode === 'version')).toHaveLength(2);
  });
  it.each([
    ['N7 vanished executable', { executable: '/nonexistent/headless-cli' }, 'HEADLESS_CLI_UNAVAILABLE', undefined],
    ['N8 another uid', { ownerUid: (process.getuid!() + 1) }, 'HEADLESS_OWNER_MISMATCH', undefined],
    ['a config dir that is missing', { configDir: '/nonexistent/config' }, 'HEADLESS_PREFLIGHT_FAILED', 'config-dir'],
  ])('refuses %s before any spawn', async (_label, over, code, check) => {
    const c = await connection({ steps: happy() }, over);
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code, ...(check ? { params: { check } } : {}) });
    expect(await c.log()).toEqual([]);
  });
  it.each([
    ['N9 logged out', { auth: { loggedIn: false } }, 'HEADLESS_LOGIN_REQUIRED', undefined],
    ['an API-key login', { auth: { loggedIn: true, authMethod: 'api-key', apiProvider: 'firstParty' } }, 'HEADLESS_LOGIN_REQUIRED', undefined],
    ['a cloud provider', { auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' } }, 'HEADLESS_LOGIN_REQUIRED', undefined],
    ['another login directory', { auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', configDirectory: '/elsewhere' } }, 'HEADLESS_PREFLIGHT_FAILED', 'config-dir'],
    ['unreadable auth status', { auth: { state: 'unknown' } }, 'HEADLESS_PREFLIGHT_FAILED', 'auth-status'],
    ['a CLI without the restricted mode', { help: fullHelp().replace('--restricted', '--other') }, 'HEADLESS_PREFLIGHT_FAILED', 'flags'],
    ['a hidden turn flag the parser does not refuse', { probeRefusal: null }, 'HEADLESS_PREFLIGHT_FAILED', 'flags'],
    ['an unreadable version', { version: 'banana' }, 'HEADLESS_PREFLIGHT_FAILED', 'version'],
  ])('closes the channel typed for %s and never starts a login flow', async (_label, scenario, code, check) => {
    const c = await connection(scenario as Omit<FakeScenario, 'logPath'>);
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code, ...(check ? { params: { check } } : {}) });
    expect((await c.log()).some(entry => entry.mode === 'call' || entry.argv.includes('login'))).toBe(false);
  });
  it('proves help-hidden flags only by the parser refusal, each in an empty temporary config dir, never the login dir (lead real-CLI finding)', async () => {
    // CLI 2.1.309: --help lists neither the turn bound nor the system prompt file option; the fixture help omits both the same way.
    const hidden = headless.preflight.hiddenFlags.map(row => row.flag);
    expect(hidden).toEqual(expect.arrayContaining(['--max-turns', headless.systemPromptFlag]));
    for (const flag of hidden) expect(fullHelp().split(/\s+/u)).not.toContain(flag);
    // The fake answers a probe with the parser refusal only when it sees an empty config dir of its own (HOME = cwd = that dir, not the login
    // dir), so a passing preflight proves where the probes ran; isolated, they cannot write into the login dir, and their dirs are removed.
    const c = await connection({ steps: happy() });
    await expect(c.call()).resolves.toMatchObject({ native: { object: 'chat.completion' } });
    expect((await c.log()).filter(entry => entry.mode.startsWith('probe'))).toEqual([]);
    expect((await readdir(join(c.root, 'state'))).filter(name => name.startsWith('probe-'))).toEqual([]);
  });
  it('closes typed when the system prompt file option is unknown to the parser', async () => {
    const c = await connection({ systemProbeRefusal: null, steps: happy() });
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'flags' } });
    expect((await c.log()).some(entry => entry.mode === 'call')).toBe(false);
  });
});

describe.skipIf(process.platform !== 'linux' || !sandbox)('S3-2 headless guards and typed refusals (fake CLI)', () => {
  it.each([
    ['N2 an API key source', initLine({ apiKeySource: 'ANTHROPIC_API_KEY' }), 'invalid-response', { refusal: 'guard', field: 'apiKeySource' }],
    ['N3 a tool', initLine({ tools: ['Bash'] }), 'invalid-response', { refusal: 'guard', field: 'tools' }],
    ['N3 an MCP server', initLine({ mcp_servers: [{ name: 'x', status: 'connected' }] }), 'invalid-response', { refusal: 'guard', field: 'mcpServers' }],
    ['N3 a user plugin', initLine({ plugins: [{ name: 'user-plugin', path: '/home/x/plugins', source: 'user-plugin@market' }] }), 'invalid-response', { refusal: 'guard', field: 'plugins' }],
    ['a skill', initLine({ skills: ['skill'] }), 'invalid-response', { refusal: 'guard', field: 'skills' }],
    ['another permission mode', initLine({ permissionMode: 'bypassPermissions' }), 'invalid-response', { refusal: 'guard', field: 'permissionMode' }],
    ['another CLI version', initLine({ claude_code_version: '9.9.9' }), 'invalid-response', { refusal: 'guard', field: 'cliVersion' }],
    ['N20 another cwd', initLine({ cwd: '/repository' }), 'invalid-response', { refusal: 'guard', field: 'cwd' }],
    ['N4 another init model', initLine({ model: 'other-model' }), 'model-mismatch', { refusal: 'model-mismatch', field: 'init.model' }],
  ])('stops the process group on %s and settles a typed rejection, never a fallback', async (_label, init, reason, refusal) => {
    const c = await connection({ steps: [{ line: uiLine() }, { line: init }, { sleepMs: 30000 }, { line: resultLine('late') }] });
    const started = Date.now(), result = await c.call(null, {});
    expect(Date.now() - started).toBeLessThan(20000);
    expect(result).toMatchObject({ kind: 'rejected', evidence: { reason, adapter: NATIVE_CLI_HEADLESS_ADAPTER, body: { complete: true } } });
    expect(body(result)).toMatchObject({ schemaVersion: 1, ...refusal });
  });
  it.each([
    ['N4 model usage of another model', [{ line: initLine() }, { line: resultLine('x', {}, 'other-model') }], 'model-mismatch', { refusal: 'model-mismatch', field: 'modelUsage' }],
    ['an assistant message of another model', [{ line: initLine() }, { line: assistantLine('x', 'other-model') }], 'model-mismatch', { refusal: 'model-mismatch', field: 'assistant.model' }],
    ['N13 a rejected rate limit', [{ line: initLine() }, { line: rateLimitLine('rejected') }, { line: resultLine('', { is_error: true, subtype: 'error_during_execution', api_error_status: 429 }) }],
      'http-status', { refusal: 'quota', resetsAtMs: 1792773600000, status: 429 }],
    ['N13 credits required', [{ line: initLine() }, { line: rateLimitLine('rejected', { errorCode: 'credits_required' }) }], 'http-status', { refusal: 'credits-required' }],
    ['N14 the turn limit', [{ line: initLine() }, { line: resultLine('', { subtype: 'error_max_turns', is_error: true }) }, { exit: 1 }], 'invalid-response', { refusal: 'invalid-output', subtype: 'error_max_turns' }],
    ['a login failure inside the run', [{ line: initLine() }, { line: resultLine('', { is_error: true, api_error_status: 401, errors: ['authentication_failed'] }) }, { exit: 1 }], 'http-status', { refusal: 'login-required', status: 401 }],
    ['a retry line', [{ line: initLine() }, { line: { type: 'system', subtype: 'api_retry', attempt: 1 } }], 'invalid-response', { refusal: 'guard', field: 'api_retry' }],
    ['a result before init', [{ line: resultLine('x') }], 'invalid-response', { refusal: 'guard', field: 'init' }],
    ['two results', [{ line: initLine() }, { line: resultLine('x') }, { line: resultLine('y') }], 'invalid-response', { refusal: 'guard', field: 'result' }],
    ['a permission denial', [{ line: initLine() }, { line: resultLine('x', { permission_denials: [{ tool_name: 'Bash' }] }) }], 'invalid-response', { refusal: 'guard', field: 'permission_denials' }],
    ['N12 a line over the bound', [{ line: initLine() }, { floodBytes: headless.limits.maxLineBytes + 1024 }], 'response-limit', { refusal: 'response-limit' }],
  ])('settles %s as a typed rejection', async (_label, steps, reason, refusal) => {
    const c = await connection();
    const result = await c.call(steps as FakeStep[]);
    expect(result).toMatchObject({ kind: 'rejected', evidence: { reason } });
    expect(body(result)).toMatchObject(refusal);
  });
  it('N15 keeps a max-tokens stop as a length finish (the Brain reads it as truncated, not invalid); a result without valid counters is never a zero', async () => {
    const c = await connection();
    await expect(c.call([{ line: initLine() }, { line: resultLine('{"draft":', { stop_reason: 'max_tokens' }) }])).resolves
      .toMatchObject({ native: { choices: [{ message: { content: '{"draft":' }, finish_reason: 'length' }] } });
    // Astra 2848 R2: an empty, partial or malformed usage record is unknown consumption: typed, so no caller settles it as zero.
    for (const usage of [{}, { input_tokens: 2, output_tokens: 9 }, { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: '9' }]) {
      expect(body(await c.call([{ line: initLine() }, { line: resultLine('x', { usage }) }]))).toMatchObject({ refusal: 'guard', field: 'usage' });
    }
  });
  it.each([
    ['a missing result', [{ line: initLine() }, { exit: 0 }]],
    ['a crash after a success line', [{ line: initLine() }, { line: resultLine('x') }, { exit: 3 }]],
  ])('settles %s as incomplete evidence (the receipt stays unknown) with its exit code, with no retry', async (_label, steps) => {
    const c = await connection(), result = await c.call(steps as FakeStep[]);
    expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted', body: { complete: false } } });
    expect(body(result)).toMatchObject({ schemaVersion: 4, refusal: 'process-exit', exitCode: (steps.at(-1) as { exit: number }).exit, signal: null });
    expect((await c.log()).filter(entry => entry.mode === 'call')).toHaveLength(1);
  });
  it('N10/N11 interrupts on timeout and on cancel (SIGINT first), then reports an unknown outcome', async () => {
    const timed = await connection({}, {});
    const profile = parseModelInvocationProfile({ ...timed.profile, limits: { ...timed.profile.limits, timeoutMs: 400 } });
    await timed.write({ steps: [{ line: initLine() }, { hang: true }] });
    await timed.port.preflight(profile);
    await expect(timed.port.send(await timed.port.prepare(profile, binding, request()))).rejects.toThrow();
    expect((await timed.log()).map(entry => entry.mode)).toContain('interrupted');
    const cancelled = await connection({ steps: [{ line: initLine() }, { hang: true }] }), controller = new AbortController();
    await cancelled.port.preflight(cancelled.profile);
    const pending = cancelled.port.send(await cancelled.port.prepare(cancelled.profile, binding, request()), controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow();
    expect((await cancelled.log()).map(entry => entry.mode)).toContain('interrupted');
  });
  it.each([
    ['N5 a model alias', { model: registry.adapters.claude.modelAliases[0] }],
    ['a model other than the binding', { model: 'other-model' }],
    ['streaming options', { stream: true }],
    ['tools', { tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] }],
    ['a template switch', { chat_template_kwargs: { enable_thinking: false } }],
    ['three messages', { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'user', content: 'v' }] }],
    ['an unknown effort level', { reasoning_effort: 'none' }],
    ['a request over the profile bound', { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x'.repeat(70_000) }] }],
  ])('refuses %s at prepare, before any spawn', async (_label, over) => {
    const c = await connection();
    await expect(c.port.prepare(c.profile, binding, request(over))).rejects.toMatchObject({ code: 'HEADLESS_REQUEST_INVALID' });
    expect(await c.log()).toEqual([]);
  });
  it('estimates a prompt without a counter as the system and user UTF-8 bytes plus the registry framing allowance, with no spawn', async () => {
    const c = await connection(), user = 'Grüße '.repeat(10), prepared = await c.port.prepare(c.profile, binding, request({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: user }] }));
    expect(headless.promptFramingAllowance).toMatchObject({ basis: 'measured', tokens: 2048 });
    expect(c.port.estimatePrompt!(prepared)).toBe(1 + Buffer.byteLength(user, 'utf8') + headless.promptFramingAllowance.tokens);
    expect(() => c.port.estimatePrompt!({})).toThrow(); expect(await c.log()).toEqual([]);
  });
  it('passes a registry effort level as the effort flag', async () => {
    const c = await connection({ steps: happy() });
    await c.call(null, { reasoning_effort: 'low' });
    expect((await c.log()).find(entry => entry.mode === 'call')!.argv.join(' ')).toContain('--effort low');
  });
  it('refuses a profile that is not a v2 subscription profile of this adapter', async () => {
    const c = await connection();
    for (const profile of [{ ...c.profile, billingAxis: 'metered' }, { ...c.profile, adapter: { ...c.profile.adapter, version: 2 } }, { ...c.profile, protocol: { family: 'codex-exec-json', version: 'v1' } }]) {
      await expect(c.port.prepare(profile, binding, request())).rejects.toMatchObject({ code: 'HEADLESS_REQUEST_INVALID' });
    }
    expect(c.port.billingAxis).toBe('subscription');
    // N5: an alias as the bound native id never reaches the argv.
    const alias = registry.adapters.claude.modelAliases[0]!, aliased = parseModelBindingDefinition({ ...binding, model: { ...binding.model, nativeId: alias } });
    await expect(c.port.prepare(c.profile, aliased, request({ model: alias }))).rejects.toMatchObject({ code: 'HEADLESS_REQUEST_INVALID', params: { reason: 'model-alias' } });
  });
});

describe.skipIf(process.platform !== 'linux' || !sandbox)('Codex headless turn (fake Codex CLI, no real CLI, no model call)', () => {
  it('runs one read-only, tool-less exec turn and settles a tool item, a quota failure and a non-subscription login as typed refusals', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'deckent-codex-headless-'))), configDir = join(root, 'login'), bin = join(root, 'bin'), logPath = join(configDir, 'config.toml');
    try {
      await mkdir(configDir, { mode: 0o700 }); await mkdir(bin);
      let bump = 0;
      const write = async (scenario: Omit<FakeCodexScenario, 'logPath'>) => { const path = await writeFakeCodexCli(bin, { logPath, ...scenario }); await utimes(path, new Date(), new Date(Date.now() + ++bump * 9000)); return path; };
      const executable = await write({ steps: codexAnswer('{"ok":true}').map(line => ({ line })) });
      const codexBinding = parseModelBindingDefinition({ encodingVersion: 1, provider: { id: 'cli-subscription', version: 1 },
        model: { id: 'pinned', version: 1, nativeId: PINNED, protocols: [{ family: CODEX_FAMILY, version: 'v1', capabilities: [] }] } });
      const profile = parseModelInvocationProfile({ schemaVersion: 2, billingAxis: 'subscription', id: 'codex', version: 1, scopeId: 'scope',
        reference: { providerId: 'cli-subscription', providerVersion: 1, modelId: 'pinned', modelVersion: 1 }, bindingDigest: 'a'.repeat(64), protocol: { family: CODEX_FAMILY, version: 'v1' },
        adapter: { ...NATIVE_CLI_HEADLESS_ADAPTER, definition: { schemaVersion: 1, executable, configDir, stateDir: join(root, 'state'), ownerUid: process.getuid!(), minCliVersion: '9.0.0', delegatedUse: null } },
        allocation: { id: 'allocation', maxCalls: null, maxInFlight: 1 }, limits: { requestMaxBytes: 65_536, responseMaxBytes: 65_536, timeoutMs: 5000 } });
      const port = createNativeCliHeadlessPort({ now: () => 1, isolation: testIsolation }), deltas: ModelInvocationDelta[] = [];
      const call = async () => { await port.preflight(profile); return port.send(await port.prepare(profile, codexBinding, request({ reasoning_effort: 'high' })), undefined, delta => deltas.push(delta)); };
      const log = async () => (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { mode: string; argv: string[]; env: Record<string, string>; stdin?: string; system?: string });
      // The answer: the argv-pinned model, the CLI's split input counters, the user message on stdin and the system prompt as the instructions file.
      await expect(call()).resolves.toMatchObject({ native: { model: PINNED, choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], headless: { cliVersion: '9.1.0', guard: 'passed', modelEvidence: 'argv' } },
        usage: { prompt_tokens: 1200, completion_tokens: 7, cache_read: 1000, modelUsage: { [PINNED]: { inputTokens: 200, outputTokens: 7, cacheReadInputTokens: 1000 } } } });
      expect(deltas.map(delta => delta.text).join('')).toBe('{"ok":true}');
      const spawned = await log(), made = spawned.find(entry => entry.mode === 'call')!;
      expect(spawned.map(entry => entry.mode)).toEqual(['version', 'help', 'auth', 'call']);
      expect(made.stdin).toBe(PROMPT); expect(made.system).toBe('You are a planner. Answer only JSON.'); expect(made.argv.join(' ')).not.toContain(PROMPT);
      expect(made.argv.slice(0, 11)).toEqual(['exec', '--json', '--color', 'never', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--strict-config', '--sandbox', 'read-only']);
      expect(made.argv).toEqual(expect.arrayContaining(['approval_policy="never"', 'features.shell_tool=false', 'features.unified_exec=false', 'web_search="disabled"', 'features.view_image=false', 'features.apps=false',
        'features.multi_agent=false', 'features.hooks=false', 'model_reasoning_effort=high', '--model', PINNED]));
      expect(made.argv).not.toContain('--max-turns');
      for (const flag of codexHeadless.forbiddenFlags) expect(made.argv.some(arg => arg === flag || arg.startsWith(flag + '='))).toBe(false);
      expect(made.env).toMatchObject({ CODEX_HOME: configDir, HOME: join(root, 'state', 'run'), PATH: '/usr/bin:/bin' });
      for (const name of codexHeadless.env.deny) expect(made.env).not.toHaveProperty(name);
      // A tool item stops the process (the guard, never a run tool); a quota failure is quota; an API-key or absent login refuses before any call.
      await write({ steps: [...codexAnswer('x').slice(0, 2), { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } }].map(line => ({ line })) });
      expect(body(await call())).toMatchObject({ refusal: 'guard', field: 'item.command_execution' });
      await write({ steps: [...codexAnswer('x').slice(0, 2), { type: 'turn.failed', error: { message: 'You have hit your usage limit reached for this plan' } }].map(line => ({ line })) });
      expect(body(await call())).toMatchObject({ refusal: 'quota' });
      // 1b (WALK21): a CLI that ends before a complete turn (a refused argv: exit 2, plain stderr carrying a secret) is incomplete evidence, so the outcome
      // stays unknown with its exit code and a redacted, bounded stderr tail (never a cause-less throw).
      await write({ steps: [{ stderr: 'Error loading config.toml: unknown configuration field `tools.view_image` in -c/--config override\nAuthorization: Bearer w12Fictional0123456789\n' }, { exit: 2 }] });
      const exited = await call();
      expect(exited).toMatchObject({ kind: 'rejected', evidence: { reason: 'interrupted', httpStatus: null, body: { complete: false } } });
      expect(body(exited)).toMatchObject({ schemaVersion: 4, refusal: 'process-exit', exitCode: 2, signal: null, stderrSummary: expect.stringContaining('unknown configuration field `tools.view_image`') });
      expect(JSON.stringify(body(exited))).not.toContain('w12Fictional0123456789');
      expect(Buffer.byteLength(body(exited).stderrSummary)).toBeLessThanOrEqual(codexHeadless.limits.stderrSummaryBytes);
      expect(readHeadlessRejection((exited as { evidence: Parameters<typeof readHeadlessRejection>[0] }).evidence)).toMatchObject({ schemaVersion: 4, refusal: 'process-exit', exitCode: 2 });
      // Lead 2026-10-31: the CLI's own counted reconnect notices (probe/2 shape) are tolerated up to the registry bound; past it, or any other error line, refuses.
      const reconnect = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'error', message: `Reconnecting... ${i + 2}/5 (stream disconnected before completion: failed to lookup address information: Try again)` }));
      const answered = codexAnswer('R');
      await write({ steps: [...answered.slice(0, 2), ...reconnect(2), ...answered.slice(2)].map(line => ({ line })) });
      await expect(call()).resolves.toMatchObject({ native: { choices: [{ message: { content: 'R' } }] } });
      await write({ steps: [...answered.slice(0, 2), ...reconnect(codexHeadless.guards.maxReconnects + 1), ...answered.slice(2)].map(line => ({ line })) });
      expect(body(await call())).toMatchObject({ refusal: 'invalid-output', subtype: 'reconnect-limit' });
      await write({ steps: [...answered.slice(0, 2), { type: 'error', message: 'Reconnecting... waiting for network' }, ...answered.slice(2)].map(line => ({ line })) });
      expect(body(await call())).toMatchObject({ refusal: 'invalid-output', subtype: 'error' });
      // Astra 2848 R2/R3: unknown counters are no zero, and nothing after the completed turn changes its answer; a reported zero stays a zero.
      const ended = (usage: unknown, after: Record<string, unknown>[] = []) => [...codexAnswer('A').slice(0, 4), { type: 'turn.completed', usage }, ...after].map(line => ({ line }));
      const valid = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 };
      for (const usage of [{}, { output_tokens: 2 }, { ...valid, input_tokens: '10' }, { ...valid, output_tokens: -1 }, { ...valid, cached_input_tokens: 11 }, { ...valid, cache_write_input_tokens: 1.5 }]) {
        await write({ steps: ended(usage) });
        expect(body(await call())).toMatchObject({ refusal: 'guard', field: 'usage' });
      }
      for (const late of [{ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: 'B' } }, 'not json']) {
        await write({ steps: ended(valid, [late as Record<string, unknown>]) });
        expect(body(await call())).toMatchObject({ refusal: 'guard', field: 'after-turn' });
      }
      await write({ steps: ended({ input_tokens: 0, output_tokens: 0 }) });
      await expect(call()).resolves.toMatchObject({ native: { choices: [{ message: { content: 'A' } }] }, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
      for (const login of ['api-key', 'none'] as const) {
        const before = (await log()).filter(entry => entry.mode === 'call').length;
        await write({ login, steps: codexAnswer('x').map(line => ({ line })) });
        await expect(call()).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_REQUIRED' });
        expect((await log()).filter(entry => entry.mode === 'call')).toHaveLength(before);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
