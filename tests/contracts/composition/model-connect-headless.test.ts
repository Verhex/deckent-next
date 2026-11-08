// S3-3 `models connect claude-cli-subscription` through the real configured paths (governed config writer, ledger catalog, activation, audit) with
// a scripted fake CLI: no real CLI and no model call. Model ids come from the packaged seed, never from this file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { DRIVER } from '../support/pty-steps.js';
import * as adapters from '#adapters/index.js';
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer, type McpApplications } from '#surfaces/core/mcp/index.js';
import { connectModel } from '../../../src/index.js';
import * as platform from '#platform/index.js';
import * as catalog from '#composition/core/provider-catalog/index.js';
import * as configComposition from '#composition/core/config/index.js';
import { providerPanelPort } from '#surfaces/core/terminal-provider/index.js';
import { withMcpPrincipal } from '#adapters/index.js';
import { connectConfiguredModel, loginConfiguredHeadless, readConfiguredHeadlessLogins, inspectConfiguredModelReadiness } from '#composition/core/model-connect/index.js';
import { configureNativeCodingTemplate, initializeNativeCodingRegistry } from '#composition/core/native-coding/index.js';
import { configuredSetup } from '#composition/core/setup/index.js';
import { inspectPolicyTemplate } from '#composition/core/installation/index.js';
import { listIdentityProfiles } from '#composition/core/identity-profile/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { Writable } from 'node:stream';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { resolveConfiguredModelUse } from '#composition/core/model-use/index.js';
import { parseModelInvocationProfile } from '#domain/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { inspectConfiguredInvocableModels } from '#composition/core/model-invocation/index.js';
import { inspectConfiguredModelCatalog } from '#composition/core/model-activation/index.js';
import seed from '../../../assets/model-catalog/claude-cli-subscription.json' with { type: 'json' };
import codexSeed from '../../../assets/model-catalog/codex-cli-subscription.json' with { type: 'json' };
import { textOnlyModelInvocationRequest, roleModelInvocationReference, planSetup } from '#engine/index.js';
import { CODEX_FAMILY, writeFakeCodexCli } from '../../fixtures/native-headless/codex.js';
import { initLine, assistantLine, resultLine, rateLimitLine, writeFakeCli } from '../../fixtures/native-headless/stream.js';
import { me, runtime } from '../support/chat-turn-harness.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';
import { settleOnboarding } from '../../fixtures/onboarding-settled.js';

// The MCP actor holds the same grants, so the refusal below is the person-only rule itself, not a missing grant.
const both = [...me, { issuer: `${me[0]!.issuer}/mcp`, subject: me[0]!.subject }];
const grants = [{ id: 'chat', effect: 'allow', actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], scopes: 'all', principals: both, resource: { kind: 'model-invocation', ids: 'all' } },
  { id: 'config', effect: 'allow', actions: ['write'], scopes: 'all', principals: both, resource: { kind: 'config', ids: 'all' } },
  { id: 'activation', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals: both, resource: { kind: 'model-activation', ids: 'all' } }];
const nativeId = seed.recommendedActivations[0]!.modelIds[0]!;
type Profile = { schemaVersion: number; billingAxis?: string; adapter: { id: string; definition: Record<string, unknown> } };
async function harness(preview: boolean | null, auth?: Record<string, unknown>) {
  // S3-5: the CLI runs isolated, so the fake logs into its own state file in the login dir (the one place it may write).
  const f = await runtime({ extraGrants: grants, noServer: true }), configDir = join(f.data, 'claude-login'), bin = join(f.data, 'bin'), logPath = join(configDir, '.claude.json');
  await mkdir(configDir, { mode: 0o700 }); await mkdir(bin);
  vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
  const executable = await writeFakeCli(bin, { logPath, ...(auth ? { auth } : {}) }), options = { env: f.env };
  // alpha.55.1: the retired key is protected, so the fixture sets it as the person at a terminal (the witness attests).
  if (preview !== null) await createConfiguredConfigApplication(f.project, options, undefined, { attest: async () => true }).submit('set', { keyPath: 'models.headless.preview', value: preview, layer: 'global',
    commandId: 'preview-on', scopeId: 'scope', principal: await resolveConfiguredConfigPrincipal(f.project, 'scope', options) });
  const connect = (commandId: string, over: Record<string, unknown> = {}) => connectConfiguredModel(f.project, { schemaVersion: 1, commandId, scopeId: 'scope',
    connection: 'claude-cli-subscription', endpoint: null, model: { nativeId }, cli: { executable, configDir }, ...over }, options);
  const profile = async () => ((JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8')) as { provider_invocation_profiles: { profiles: Profile[] } })
    .provider_invocation_profiles.profiles.find(item => item.adapter.id === 'native-cli-headless'));
  const spawns = async () => existsSync(logPath) ? (await readFile(logPath, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { mode: string }).mode) : [];
  return { f, configDir, executable, connect, profile, spawns };
}

async function unwitnessedDelegation(h: Awaited<ReturnType<typeof harness>>) {
  vi.mocked(adapters.attestLocalInteractiveTerminal).mockResolvedValue(false);
  const path = join(h.f.project, '.deckent/config.json'), original = await readFile(path, 'utf8');
  const argv = ['models', 'connect', '--scope', 'scope', '--connection', 'claude-cli-subscription', '--model', nativeId,
    '--executable', h.executable, '--config-dir', h.configDir, '--delegate', 'ai,system', '--command-id', 'f11-cli', '--json'];
  const cli = resolve('dist/composition/core/cli/internal/entry.js');
  // Keep the reproducer's /dev/null input and piped output, without altering the actual models.connect command.
  const denied = await promisify(execFile)('/bin/sh', ['-c', 'exec "$@" </dev/null', 'f11-fixture', process.execPath, cli, ...argv], { cwd: h.f.project,
    env: { ...h.f.env, CLAUDECODE: '1', AI_AGENT: 'fixture-agent' } }).then(value => ({ code: 0, ...value }),
    (error: { code: number; stdout: string; stderr: string }) => error);
  console.info('F11 non-TTY AI CLI:', JSON.stringify(denied));
  expect(denied.code).not.toBe(0); expect(denied.stderr).toContain('AUTHORITY_WITNESS_REQUIRED');
  expect(await readFile(path, 'utf8')).toBe(original); expect(await h.spawns()).toEqual([]);
  await expect(connectModel(h.f.project, { schemaVersion: 1, commandId: 'sdk-delegate', scopeId: 'scope', connection: 'claude-cli-subscription',
    model: { nativeId }, cli: { executable: h.executable, configDir: h.configDir }, delegate: ['ai'] }, { env: h.f.env }))
    .rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(await readFile(path, 'utf8')).toBe(original);
  const person = async (extraEnv: Record<string, string>, commandId: string) => {
    // A synthetic person on this test's disposable install, with its own controlling terminal; never the host's login or authority.
    const { stdout } = await promisify(execFile)('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, ...argv.slice(0, -3), '--command-id', commandId, '--json']), '[]', 'tty', 'until-exit'],
      { cwd: h.f.project, env: { ...h.f.env, ...extraEnv }, timeout: 60_000 });
    return JSON.parse(stdout) as { status: number; output: string };
  };
  const agentPty = await person({ CLAUDECODE: '1' }, 'agent-pty');
  expect(agentPty.status).not.toBe(0); expect(agentPty.output).toContain('AUTHORITY_WITNESS_REQUIRED');
  expect(await readFile(path, 'utf8')).toBe(original);
  return { person, cli, argv };
}

afterEach(() => vi.restoreAllMocks());
const platformPrune = platform.pruneConfigBackups;
const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';
describe.skipIf(process.platform !== 'linux' || !sandbox)('S3-3 models connect claude-cli-subscription (fake CLI, no model call)', () => {
  it('K29: connected profile authors v2 through governed config, lists its connection and returns the same kind to Docker', async () => {
    const h = await harness(null); await h.connect('k29-connect');
    const path = join(h.f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8'));
    const profile = config.provider_invocation_profiles.profiles.find((row: { adapter: { id: string } }) => row.adapter.id === 'native-cli-headless');
    const docker = { imageId: `sha256:${'a'.repeat(64)}`, memoryBytes: 268435456, cpus: 1, pids: 64, logMaxSizeKiB: 64, logMaxFiles: 2,
      tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
    const template = adapters.createNativeCodingTemplate(docker, { provider: 'claude', cliVersion: '9.1.0 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' });
    config.terminal.scopeId = 'scope';
    config.execution = { docker: { ...docker, executable: 'docker' }, git: { gitExecutable: 'git', timeoutMs: 5000 } };
    config.admission = { poolId: 'k29-pool', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'k29-before', profiles: [template],
      kinds: [{ kind: 'coding', profile: { id: template.id, version: template.version } }], evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } };
    await writeFile(path, JSON.stringify(config)); platform.clearConfigCache();
    const request = { provider: 'claude', kind: 'coding', connection: profile.id, apply: false }, options = { env: h.f.env }, person = { witness: { attest: async () => true } };
    const before = await readFile(path, 'utf8'), spawns = await h.spawns();
    const preview = await configureNativeCodingTemplate(h.f.project, request, options, person);
    expect(preview.profile.adapter.version).toBe(2); expect(preview.profile.parameters['invocation']).toMatchObject({ discovery: { mode: 'disabled' } }); expect(await readFile(path, 'utf8')).toBe(before); expect(await h.spawns()).toEqual(spawns);
    expect(preview.profile.parameters['worker']).toMatchObject({ definition: profile.adapter.definition, protocolFamily: profile.protocol.family });
    await expect(configureNativeCodingTemplate(h.f.project, { ...request, discovery: 'repository' }, options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_CONNECTION_DISCOVERY_UNSUPPORTED' });
    // Owner R8 (2026-11-05, 2026-11-08): without a Docker toolchain pin the template records the CLI version the connection last proved (the
    // fixture's 9.1.0), not its floor; the floor stays the minimum.
    const pinless = { ...config, admission: { ...config.admission, registry: { ...config.admission.registry, profiles: [{ ...template, parameters: { ...template.parameters,
      invocation: { ...(template.parameters['invocation'] as object), provider: 'codex', cliVersion: 'codex-cli 9.1.0' } } }] } } };
    await writeFile(path, JSON.stringify(pinless)); platform.clearConfigCache();
    const floor = await configureNativeCodingTemplate(h.f.project, request, options, person).catch((error: unknown) => error);
    expect(profile.adapter.definition.minCliVersion).not.toBe('9.1.0'); expect(floor).toMatchObject({ profile: { parameters: { invocation: { cliVersion: '9.1.0' } } } });
    await writeFile(path, before); platform.clearConfigCache();
    const applied = await configureNativeCodingTemplate(h.f.project, { ...request, apply: true }, options, person);
    expect(applied.registry).toEqual(preview.registry); expect(applied.status).toBe('applied');
    expect((await configureNativeCodingTemplate(h.f.project, { ...request, apply: true }, options, person)).status).toBe('unchanged');
    let output = ''; const stdout = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    expect(await main(['coding', '--json'], { root: h.f.project, env: h.f.env, stdout })).toBe(0);
    expect(JSON.parse(output).profiles[0]).toMatchObject({ runtime: 'subscription', connection: profile.id });
    // R8c: people see the connection as CLI · model (its id only in --json); R8b: `--connection` alone names the provider.
    const host = { workerCliOf: (family: string) => adapters.nativeCliAgent(family)?.id ?? null, configureCodingTemplate: configureNativeCodingTemplate };
    output = ''; expect(await main(['coding'], { root: h.f.project, env: h.f.env, stdout, ...host })).toBe(0);
    expect(output).toContain(`claude · ${profile.reference.modelId}`); expect(output).not.toContain(profile.id);
    output = ''; expect(await main(['coding', 'template', '--connection', profile.id, '--kind', 'coding', '--preview', '--json'], { root: h.f.project, env: h.f.env, stdout, ...host })).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ status: 'unchanged', connection: profile.id });
    const back = await configureNativeCodingTemplate(h.f.project, { provider: 'claude', kind: 'coding', detach: true, apply: false }, options, person);
    expect(back.profile.adapter.version).toBe(1); expect(back.profile.parameters).not.toHaveProperty('worker');
    expect((await configureNativeCodingTemplate(h.f.project, { provider: 'claude', kind: 'coding', detach: true, discovery: 'repository', apply: true }, options, person)).profile).toEqual(template);
    const stable = await readFile(path, 'utf8');
    await expect(adapters.withMcpPrincipal(() => configureNativeCodingTemplate(h.f.project, { ...request, apply: true }, options))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await readFile(path, 'utf8')).toBe(stable);
    for (const connection of ['missing', profile.id]) {
      if (connection === profile.id) { delete profile.adapter.definition.sourceBinding; config.provider_invocation_profiles.profiles = [profile]; await writeFile(path, JSON.stringify(config)); platform.clearConfigCache(); }
      await expect(configureNativeCodingTemplate(h.f.project, { ...request, connection }, options, person)).rejects.toMatchObject({ code: 'NATIVE_AGENT_RECONNECT_REQUIRED' });
    }
    const unsupported = { ...profile, protocol: { family: 'cursor-agent-stream-json', version: 'v1' } };
    config.provider_invocation_profiles.profiles = [unsupported]; await writeFile(path, JSON.stringify(config)); platform.clearConfigCache();
    const unsupportedBefore = await readFile(path, 'utf8');
    await expect(configureNativeCodingTemplate(h.f.project, request, options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_CONNECTION_UNSUPPORTED' });
    expect(await readFile(path, 'utf8')).toBe(unsupportedBefore);
  });

  it('K29: Codex connection selects its registry capability and refuses a different provider without writing', async () => {
    const h = await harness(null), configDir = join(h.f.data, 'codex-k29'), path = join(h.f.project, '.deckent/config.json');
    await mkdir(configDir, { mode: 0o700 });
    const executable = await writeFakeCodexCli(join(h.f.data, 'bin'), { logPath: join(configDir, 'config.toml') });
    await connectConfiguredModel(h.f.project, { schemaVersion: 1, commandId: 'codex-k29', scopeId: 'scope', connection: 'codex-cli-subscription',
      model: { nativeId: codexSeed.recommendedActivations[0]!.modelIds[0]! }, cli: { executable, configDir }, delegate: ['ai', 'system'] }, { env: h.f.env });
    const config = JSON.parse(await readFile(path, 'utf8')), profile = config.provider_invocation_profiles.profiles.find((row: { protocol: { family: string } }) => row.protocol.family === CODEX_FAMILY);
    const docker = { imageId: `sha256:${'b'.repeat(64)}`, memoryBytes: 268435456, cpus: 1, pids: 64, logMaxSizeKiB: 64, logMaxFiles: 2,
      tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
    const template = adapters.createNativeCodingTemplate(docker, { provider: 'codex', cliVersion: 'codex-cli 9.1.0', discovery: { schemaVersion: 1, mode: 'disabled' }, permissionMode: 'unattended' });
    config.terminal.scopeId = 'scope';
    config.execution = { docker: { ...docker, executable: 'docker' }, git: { gitExecutable: 'git', timeoutMs: 5000 } };
    config.admission = { poolId: 'k29-pool', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { schemaVersion: 1, revision: 'k29-codex', profiles: [template],
      kinds: [{ kind: 'coding', profile: { id: template.id, version: template.version } }], evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] } };
    await writeFile(path, JSON.stringify(config)); platform.clearConfigCache();
    const before = await readFile(path, 'utf8'), request = { provider: 'codex', kind: 'coding', connection: profile.id, apply: false }, options = { env: h.f.env };
    const result = await configureNativeCodingTemplate(h.f.project, request, options);
    expect(result.profile.adapter.version).toBe(2); expect(result.profile.parameters['worker']).toMatchObject({ protocolFamily: CODEX_FAMILY, definition: profile.adapter.definition });
    await expect(configureNativeCodingTemplate(h.f.project, { ...request, provider: 'claude' }, options)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_CONNECTION_UNSUPPORTED' });
    expect(await readFile(path, 'utf8')).toBe(before);
    // R8b (owner D1): without Docker the first registry comes from the connection alone (its CLI floor, no image, no detection container);
    // a plain Docker registry without an image stays refused.
    config.execution = { git: { gitExecutable: 'git', timeoutMs: 5000 } }; delete config.admission; await writeFile(path, JSON.stringify(config)); platform.clearConfigCache();
    // NF-2: onboarding's "use my subscription" answer, once the Git setting is written, proposes the first kind from that connection (it read Docker-only facts).
    const answers = { 'work:kind': { connection: profile.id } }, wired = configuredSetup({ listIdentityProfiles, inspectPolicyTemplate });
    const observed = await wired.observeSetup(h.f.project, { ...options, person: true, answers });
    expect(planSetup(observed.observation, { schemaVersion: 2, values: answers }, observed.registry, { phase: 'onboarding' }).stages.find(row => row.id === 'work:kind'))
      .toMatchObject({ state: 'ready', operation: { id: 'work.registry', input: { connection: profile.id, provider: 'codex' } } });
    const person = { witness: { attest: async () => true } }, init = { schemaVersion: 1, scopeId: 'scope', provider: 'codex', kind: 'coding', poolId: 'k29-pool', executionSlots: 1, inFlightSlots: 1, apply: true };
    await expect(initializeNativeCodingRegistry(h.f.project, init, options, person)).rejects.toMatchObject({ code: 'CODING_TEMPLATE_IMAGE_REQUIRED' });
    const first = await initializeNativeCodingRegistry(h.f.project, { ...init, connection: profile.id }, options, { ...person, detect: async () => { throw new Error('no detection without Docker'); } });
    expect(first.status).toBe('applied'); expect(first.profile.parameters['docker']).not.toHaveProperty('imageId');
    const proved = (JSON.parse(await readFile(join(profile.adapter.definition.stateDir, 'preflight.json'), 'utf8')) as { version: string }).version;
    expect(proved).not.toBe(profile.adapter.definition.minCliVersion); expect(first.profile.parameters['invocation']).toMatchObject({ cliVersion: proved, discovery: { mode: 'disabled' } });
    expect((await configureNativeCodingTemplate(h.f.project, { ...request, kind: 'review', apply: true }, options, person)).registry.kinds.map(row => row.kind)).toEqual(['coding', 'review']);
  });

  it('S3-5/A62: connects without a preview switch; subscription text chat streams, carries history and Esc cancels in the built terminal', async () => {
    expect(textOnlyModelInvocationRequest({ model: 'fixture', max_completion_tokens: 1, messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'raw role input' }] })['messages']).toEqual([{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'raw role input' }]);
    expect(adapters.terminalTextChatFamilies).toContain(seed.providers[0]!.channel.protocolFamily);
    expect(adapters.terminalTextChatFamilies).toContain(CODEX_FAMILY);
    for (const preview of [null, false]) {
      const h = await harness(preview);
      await expect(h.connect('c-1')).resolves.toMatchObject({ status: 'connected' });
      expect(await h.spawns()).toEqual(expect.arrayContaining(['version', 'help', 'auth'])); expect(await h.profile()).toBeDefined();
      const reference = { providerId: seed.providers[0]!.id, providerVersion: seed.providers[0]!.version,
        modelId: seed.providers[0]!.models.find(model => model.nativeId === nativeId)!.id, modelVersion: 1 };
      await expect(inspectConfiguredModelReadiness(h.f.project, 'scope', reference, { env: h.f.env })).resolves.toMatchObject({ refreshRequired: false, command: { nativeRequest: { stream: false, messages: [{ role: 'system', content: '' }, { role: 'user', content: ' ' }] } } });
      if (preview !== null) continue;
      const configPath = join(h.f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
      delete config.provider_spending;
      config.terminal.chat.reference = reference;
      config.provider_invocation_profiles.profiles = config.provider_invocation_profiles.profiles.filter((profile: Profile) => profile.adapter.id === 'native-cli-headless');
      await writeFile(configPath, JSON.stringify(config)); platform.clearConfigCache();
      const complete = (text: string) => [{ line: initLine({ model: nativeId }) }, { line: assistantLine(text, nativeId) },
        { line: rateLimitLine() }, { line: resultLine(text, {}, nativeId) }];
      await writeFakeCli(join(h.f.data, 'bin'), { logPath: join(h.configDir, '.claude.json'), initCwd: 'actual', stepsByCall: [
        complete('CLAUDE-CHAT-FIRST'), [{ line: initLine({ model: nativeId }) }, { line: assistantLine('CLAUDE-CHAT-WAIT', nativeId) }, { hang: true }],
        complete('CLAUDE-CHAT-SECOND'), [{ line: initLine({ model: nativeId }) }, { line: rateLimitLine('rejected') }],
      ] });
      expect((await inspectConfiguredInvocableModels(h.f.project, 'scope', { env: h.f.env })).models.find(model => model.reference.providerId === reference.providerId && model.reference.modelId === reference.modelId)?.availability).toEqual({ invocable: true, reason: null });
      // Not a first-run test: onboarding is settled through the product's deferral store, so no setup or welcome card takes the steps' keys.
      await settleOnboarding(platform.resolveProductLayout({ projectRoot: h.f.project, root: h.f.data }));
      await h.f.start();
      const cli = resolve('dist/composition/core/cli/internal/entry.js');
      const steps = [['Deckent workline', '/model\r'], ['Models · scope', '\r'], ['Agent readiness unknown:', '\u001b'], ['claude-cli-subscription ›', '\u001b', 'fresh'],
        ['Ready', '/provider\r', 'fresh'], ['Deckent never reads, copies or shares it.', '\u001b'], ['Ready', 'first hello\r', 'fresh'], ['CLAUDE-CHAT-FIRST', 'wait please\r'],
        ['CLAUDE-CHAT-WAIT', '\u001b'], ['cancelled (model response)', 'remember first hello\r'],
        ['CLAUDE-CHAT-SECOND', 'quota please\r'], ['Your subscription usage limit', '/exit\r', 'fresh']];
      const { stdout } = await promisify(execFile)('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, 'terminal', 'workline', '--scope', 'scope']),
        JSON.stringify(steps), 'tty', 'until-exit'], { cwd: h.f.project, env: { ...h.f.env, TERM: 'xterm-256color', NO_COLOR: '1', DECKENT_LANGUAGE: 'en' },
        timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const result = JSON.parse(stdout) as { status?: number; timeout?: string; output: string };
      console.info('A62 Claude text chat PTY:', JSON.stringify(result));
      expect(result.timeout, result.output).toBeUndefined(); expect(result.status, result.output).toBe(0);
      expect(result.output).not.toContain('Set a budget');
      const calls = (await readFile(join(h.configDir, '.claude.json'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        .filter(entry => entry.mode === 'call') as { stdin: string; argv: string[] }[];
      expect(calls).toHaveLength(4);
      expect(calls[2]!.stdin).toContain('first hello'); expect(calls[2]!.stdin).toContain('CLAUDE-CHAT-FIRST');
      expect(calls[2]!.stdin).toContain('remember first hello');
      for (const call of calls) { expect(call.argv[call.argv.indexOf('--tools') + 1]).toBe(''); expect(call.argv).toContain('--strict-mcp-config'); }
      expect(h.f.rows('SELECT count(*) AS count FROM model_invocation_spend_reservations')).toEqual([{ count: 0 }]);
      const turns = h.f.rows('SELECT record FROM agent_turns').map(row => JSON.parse(row.record as string));
      expect(turns.map(turn => turn.outcome?.finish)).toEqual(expect.arrayContaining(['stop', 'cancelled', 'error']));
    }
  }, 120_000);
  it('K18: reads the alpha.62 profile shape, refuses unwitnessed rebinding and seals it only on a witnessed reconnect', async () => {
    const h = await harness(null);
    await h.connect('k18-first');
    const path = join(h.f.project, '.deckent/config.json'), original = JSON.parse(await readFile(path, 'utf8'));
    const profile = original.provider_invocation_profiles.profiles.find((p: Profile) => p.adapter.id === 'native-cli-headless');
    const bound = profile.adapter.definition.sourceBinding;
    const context = await loadConfiguredScopeContext(h.f.project, 'scope', { env: h.f.env }, 'read');
    expect(bound).toEqual({ schemaVersion: 1, installationId: context.installationId, companyId: context.config.company.id, scopeId: 'scope', principal: me[0] });
    delete profile.adapter.definition.sourceBinding;
    await writeFile(path, JSON.stringify(original)); platform.clearConfigCache();
    const legacy = parseModelInvocationProfile(profile), before = await readFile(path, 'utf8');
    await expect(resolveConfiguredModelUse(h.f.project, legacy, context.principal, { env: h.f.env })).rejects.toMatchObject({ code: 'NATIVE_AGENT_RECONNECT_REQUIRED' });
    expect(await readFile(path, 'utf8')).toBe(before);
    vi.mocked(adapters.attestLocalInteractiveTerminal).mockResolvedValue(false);
    await expect(h.connect('k18-no-witness')).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await readFile(path, 'utf8')).toBe(before);
    vi.mocked(adapters.attestLocalInteractiveTerminal).mockResolvedValue(true);
    await expect(h.connect('k18-reconnect')).resolves.toMatchObject({ status: 'connected', steps: { profile: 'written' } });
    expect((await h.profile())!.adapter.definition.sourceBinding).toEqual(bound);
    const fresh = parseModelInvocationProfile(await h.profile());
    await expect(resolveConfiguredModelUse(h.f.project, fresh, context.principal, { env: h.f.env })).resolves.toBeNull();
    // A witnessed reconnect cannot launder a source bound in another company/installation/scope/person.
    for (const changed of [{ ...bound, installationId: 'another-installation' }, { ...bound, companyId: 'another-company' },
      { ...bound, scopeId: 'another-scope' }, { ...bound, principal: { ...me[0], subject: 'another-person' } }]) {
      const copied = JSON.parse(await readFile(path, 'utf8'));
      copied.provider_invocation_profiles.profiles.find((p: Profile) => p.adapter.id === 'native-cli-headless').adapter.definition.sourceBinding = changed;
      await writeFile(path, JSON.stringify(copied)); platform.clearConfigCache();
      const unchanged = await readFile(path, 'utf8');
      await expect(h.connect('k18-copied')).rejects.toMatchObject({ code: 'PROJECT_ATTACHMENT_DENIED' });
      expect(await readFile(path, 'utf8')).toBe(unchanged);
    }
  });
  it('N19: an MCP actor can neither connect the person\'s login nor change its consent', async () => {
    const h = await harness(true);
    const path = join(h.f.project, '.deckent/config.json'), before = await readFile(path, 'utf8');
    await expect(withMcpPrincipal(() => h.connect('c-0'))).rejects.toMatchObject({ code: 'HEADLESS_PERSON_REQUIRED' });
    await expect(withMcpPrincipal(() => h.connect('c-1', { delegate: ['ai'] }))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    const server = createMcpServer({ connectModel: command => withMcpPrincipal(() => connectModel(h.f.project, command, { env: h.f.env })) } as McpApplications,
      { maxConcurrentCalls: 1, responseMaxBytes: 1_000_000 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); const client = new Client({ name: 'f11-fixture', version: '1' }); await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'connect_model', arguments: { schemaVersion: 1, commandId: 'mcp-delegate', scopeId: 'scope',
        connection: 'claude-cli-subscription', model: { nativeId }, cli: { executable: h.executable, configDir: h.configDir }, delegate: ['ai', 'system'] } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('AUTHORITY_WITNESS_REQUIRED');
    } finally { await client.close(); await server.close(); }
    expect(await readFile(path, 'utf8')).toBe(before); expect(await h.spawns()).toEqual([]);
  });
  it('the person connects: preflight without a model call, uid floor and login dir sealed, subscription profile with no key; consent is theirs to give, keep and withdraw', async () => {
    const h = await harness(true), { person, cli, argv } = await unwitnessedDelegation(h), path = join(h.f.project, '.deckent/config.json');
    vi.mocked(adapters.attestLocalInteractiveTerminal).mockResolvedValue(true);
    const first = await h.connect('c-1');
    vi.mocked(adapters.attestLocalInteractiveTerminal).mockResolvedValue(false);
    expect(first).toMatchObject({ status: 'connected', credentialRef: null, tariff: 'unmetered', cli: { configDir: h.configDir, delegate: [] },
      steps: { catalog: 'written', declaration: 'written', profile: 'written', activation: 'written' } });
    expect(await h.spawns()).toEqual(expect.arrayContaining(['version', 'help', 'auth']));
    expect(await h.spawns()).not.toContain('call');
    const profile = (await h.profile())!;
    expect(profile).toMatchObject({ schemaVersion: 2, billingAxis: 'subscription', allocation: { maxCalls: null, maxInFlight: 1 }, adapter: { id: 'native-cli-headless', definition: { schemaVersion: 1, executable: h.executable,
      configDir: h.configDir, ownerUid: process.getuid!(), delegatedUse: null } } });
    expect(String(profile.adapter.definition['stateDir'])).toContain(join('headless', ''));
    const granted = await person({}, 'c-2');
    console.info('F11 synthetic-person PTY:', JSON.stringify(granted));
    expect(granted.status).toBe(0); expect(granted.output).toContain('"delegate":["ai","system"]');
    const consent = (await h.profile())!.adapter.definition['delegatedUse'];
    expect(consent).toEqual({ consentedBy: me[0], atMs: expect.any(Number), classes: ['ai', 'system'] });
    // A reconnect without a consent choice keeps it byte for byte; the same choice again changes nothing.
    expect(await h.connect('c-3')).toMatchObject({ steps: { profile: 'present' }, cli: { delegate: ['ai', 'system'] } });
    expect(await h.connect('c-4', { delegate: ['ai', 'system'] })).toMatchObject({ steps: { profile: 'present' } });
    expect((await h.profile())!.adapter.definition['delegatedUse']).toEqual(consent);
    expect(await h.connect('c-shrink', { delegate: ['ai'] })).toMatchObject({ cli: { delegate: ['ai'] } });
    const beforeExpand = await readFile(path, 'utf8');
    await expect(h.connect('c-expand', { delegate: ['ai', 'system'] })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await readFile(path, 'utf8')).toBe(beforeExpand);
    const revoked = await promisify(execFile)(process.execPath, [cli, ...argv.map(value => value === 'ai,system' ? 'none' : value === 'f11-cli' ? 'c-5' : value)],
      { cwd: h.f.project, env: { ...h.f.env, CLAUDECODE: '1', AI_AGENT: 'fixture-agent' } });
    expect(JSON.parse(revoked.stdout)).toMatchObject({ steps: { profile: 'written' }, cli: { delegate: [] } });
    expect((await h.profile())!.adapter.definition['delegatedUse']).toBeNull();
    vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
    // R5: real config publication followed by a rejected prune/read/binding, through the production provider port.
    for (const wanted of [['ai'], []] as const) for (const fault of ['before', 'prune', 'layers', 'binding'] as const) {
      const before = wanted.length ? [] : ['ai'];
      await h.connect(`reset-${wanted.length}-${fault}`, { delegate: before });
      const path = join(h.f.project, '.deckent/config.json'), bytesBefore = await readFile(path, 'utf8');
      let attempts = 0, caught: unknown;
      const readLayers = configComposition.snapshotConfiguredConfig, readBinding = catalog.inspectModelBinding;
      let published = false;
      const prune = vi.spyOn(platform, 'pruneConfigBackups').mockImplementation(async (...args) => {
        if (fault === 'prune') throw new Error('fixture prune rejection after publication');
        await platformPrune(...args); published = true;
      });
      const layers = vi.spyOn(configComposition, 'snapshotConfiguredConfig').mockImplementation(async (...args) => {
        if (fault === 'layers' && published) throw platform.ErrorRegistry.createError('CONFIG_READ_IO_HOLD');
        return readLayers(...args);
      });
      const binding = vi.spyOn(catalog, 'inspectModelBinding').mockImplementation(async (...args) => {
        if (fault === 'binding' && published) throw platform.ErrorRegistry.createError('POLICY_DENIED');
        return readBinding(...args);
      });
      try {
        const port = providerPanelPort(h.f.project, 'scope', { providerConnect: {
          kinds: [{ id: 'claude-cli-subscription', labelKey: 'tui.provider.kind.claudeCli', available: true, endpointDefault: null, endpointEditable: false,
            keyRequired: false, secretName: null, probePath: null, endpointChoices: [], headlessLogin: true }], endpoint: () => ({ ok: false, reason: 'unused' }),
          probe: async () => { throw new Error('unused'); }, loginDir: async () => ({ owned: h.configDir }), login: async () => null },
          connectModel: async (_root, command) => {
            attempts++;
            try { return await h.connect(command.commandId, { delegate: command.delegate, ...(fault === 'before' ? { model: { nativeId: 'missing-fixture-model' } } : {}) }); }
            catch (error) { caught = error; throw error; }
          } }, { env: h.f.env }, 'en', error => String((error as { code: string }).code)).subscription!;
        const outcome = await port.connect('claude-cli-subscription', null, wanted);
        const code = fault === 'before' ? 'MODEL_CONNECT_MODEL_UNKNOWN' : fault === 'prune' ? 'CONFIG_BACKUP_PRUNE_FAILED' : fault === 'layers' ? 'CONFIG_READ_IO_HOLD' : 'POLICY_DENIED';
        expect(caught).toMatchObject({ code, params: { connectPhase: fault === 'before' ? 'before-profile-write' : fault === 'prune' ? 'profile-write-started' : 'profile-written' } });
        expect(outcome).toMatchObject({ connected: false, delegate: null, state: fault === 'before' ? 'not-applied' : fault === 'prune' ? 'unknown' : 'applied-unverified' });
        expect(outcome.lines.map(line => line.text).join('\n')).toContain(code); expect(attempts).toBe(1);
        if (fault === 'prune') expect(outcome.summary).toContain('/provider');
        if (fault === 'before') expect(await readFile(path, 'utf8')).toBe(bytesBefore);
        else expect(await readFile(path, 'utf8')).not.toBe(bytesBefore);
        const consent = (await h.profile())!.adapter.definition['delegatedUse'] as { classes: string[] } | null;
        expect(consent?.classes ?? []).toEqual(fault === 'before' ? before : wanted);
      } finally { prune.mockRestore(); layers.mockRestore(); binding.mockRestore(); }
    }
  });
  it('without flags: the first CLI of the registry name in PATH (S7: that path, not its realpath) and s3c the Brain\'s own login dir (never ~/.claude); none in PATH is refused typed', async () => {
    const h = await harness(true), bin = join(h.f.data, 'path-bin'), home = h.f.env.HOME;
    await mkdir(bin); await symlink(h.executable, join(bin, 'claude')); await mkdir(join(home, '.claude'), { mode: 0o700 });
    const run = (env: Record<string, string>, commandId: string) => connectConfiguredModel(h.f.project, { schemaVersion: 1, commandId, scopeId: 'scope',
      connection: 'claude-cli-subscription', endpoint: null, model: { nativeId } }, { env: { ...h.f.env, ...env } });
    await expect(run({ PATH: join(h.f.data, 'empty-bin') }, 'c-0')).rejects.toMatchObject({ code: 'HEADLESS_CLI_UNAVAILABLE' });
    expect(await h.spawns()).toEqual([]);
    const owned = join(await realpath(home), '.deckent', 'headless', 'logins', 'claude');
    await expect(run({ PATH: bin }, 'c-1')).resolves.toMatchObject({ status: 'connected', cli: { configDir: owned, owned: true } });
    expect((await h.profile())!.adapter.definition).toMatchObject({ executable: join(bin, 'claude'), configDir: owned });
    expect((await lstat(owned)).mode & 0o777).toBe(0o700);
    // An explicit dir is the person's override, never the default; the doctor tells the two apart (no spawn, nothing created).
    expect(await h.connect('c-2')).toMatchObject({ cli: { configDir: h.configDir, owned: false } });
    const section = () => readFile(join(h.f.project, '.deckent/config.json'), 'utf8').then(text => (JSON.parse(text) as Record<string, unknown>)['provider_invocation_profiles']);
    expect((await readConfiguredHeadlessLogins(await section(), 'scope', { env: h.f.env })).map(login => [login.configDir, login.owned])).toEqual([[h.configDir, false]]);
    await run({ PATH: bin }, 'c-3');
    expect((await readConfiguredHeadlessLogins(await section(), 'scope', { env: h.f.env })).map(login => [login.configDir, login.owned])).toEqual([[owned, true]]);
  });
  it('s3c models login: an MCP actor or a caller without the terminal witness is refused before anything is created or started; the person signs the own dir in', async () => {
    const h = await harness(null), owned = join(await realpath(h.f.env.HOME), '.deckent', 'headless', 'logins');
    const exe = await writeFakeCli(join(h.f.data, 'bin'), { logPath: join(h.configDir, '.claude.json'), authFromLogin: true });
    const login = (confirm: () => Promise<boolean>, attest = true, over: Record<string, unknown> = {}) => loginConfiguredHeadless({ connection: 'claude-cli-subscription',
      executable: exe, ...over }, { env: h.f.env }, confirm, { attest: async () => attest });
    const asked: unknown[] = [], yes = async (dir?: unknown) => { asked.push(dir); return true; };
    await expect(withMcpPrincipal(() => login(yes))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    await expect(login(yes, false)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(asked).toEqual([]); expect(existsSync(owned)).toBe(false); expect(await h.spawns()).toEqual([]);
    await expect(login(yes, true, { connection: 'anthropic-api' })).rejects.toMatchObject({ code: 'MODEL_CONNECT_NOT_CONNECTABLE' });
    // The card answered no: the dir exists (0700, empty), nothing ran.
    expect(await login(async () => false)).toBeNull();
    expect(await readdir(join(owned, 'claude'))).toEqual([]); expect(await h.spawns()).toEqual([]);
    const done = await login(yes);
    expect(done).toMatchObject({ configDir: join(owned, 'claude'), owned: true, exit: 'completed', signedIn: true, authMethod: 'claude.ai' });
    expect(asked).toEqual([{ configDir: join(owned, 'claude'), owned: true }]);
    expect(await h.spawns()).toEqual(['login']);
    // The person's override signs a dir they name in instead (an AI actor never reaches this: refused above for every input).
    expect(await login(yes, true, { configDir: h.configDir })).toMatchObject({ configDir: h.configDir, owned: false });
    // K3: the existing person witness and declined-card path also fence an explicit Codex login method.
    const codexDir = join(h.f.data, 'codex-login'); await mkdir(codexDir, { mode: 0o700 });
    const codexExe = await writeFakeCodexCli(join(h.f.data, 'bin'), { logPath: join(codexDir, 'config.toml'), authFromLogin: true });
    const codexLogin = (loginMethod: string, confirm = yes) => loginConfiguredHeadless({ connection: 'codex-cli-subscription', configDir: codexDir,
      executable: codexExe, loginMethod }, { env: h.f.env }, confirm, { attest: async () => true });
    await expect(withMcpPrincipal(() => codexLogin('device-auth'))).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
    expect(await codexLogin('device-auth', async () => false)).toBeNull();
    expect(await readdir(codexDir)).toEqual([]);
    for (const method of ['browser', 'device-auth']) expect(await codexLogin(method)).toMatchObject({ exit: 'completed', signedIn: true, authMethod: 'chatgpt' });
    const logged = (await readFile(join(codexDir, 'config.toml'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { mode: string; argv: string[] });
    expect(logged.filter(row => row.mode === 'login').map(row => row.argv)).toEqual([
      ['-c', 'cli_auth_credentials_store="file"', 'login'], ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']]);
    expect((await lstat(join(codexDir, 'auth.json'))).mode & 0o777).toBe(0);
  });
  it('N9: a CLI that is not logged in is refused typed and nothing is written; Codex: the headless profile connects without a worker image, the image gates only the worker activation', async () => {
    const h = await harness(true, { loggedIn: false });
    await expect(h.connect('c-1')).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_REQUIRED' });
    expect(await h.profile()).toBeUndefined();
    // Codex (owner 2026-10-31, gate narrowed): without a worker image the connect writes the declaration, the headless profile (catalog family, the
    // consent given) and the chat activation, activates no worker model and says so; with an admitted image it also activates the worker model.
    // Preflight only: no model call.
    const codexDir = join(h.f.data, 'codex-login'), codexModel = codexSeed.recommendedActivations[0]!.modelIds[0]!, path = join(h.f.project, '.deckent/config.json');
    await mkdir(codexDir, { mode: 0o700 });
    const codexExe = await writeFakeCodexCli(join(h.f.data, 'bin'), { logPath: join(codexDir, 'config.toml') });
    vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
    const codex = (commandId: string) => connectConfiguredModel(h.f.project, { schemaVersion: 1, commandId, scopeId: 'scope', connection: 'codex-cli-subscription', endpoint: null,
      model: { nativeId: codexModel }, cli: { executable: codexExe, configDir: codexDir }, delegate: ['ai'] }, { env: h.f.env });
    const workerModel = async () => (await inspectConfiguredModelCatalog(h.f.project, { schemaVersion: 1, scopeId: 'scope', channelId: 'codex-cli-subscription' }, { env: h.f.env }))
      .channels.find(channel => channel.channelId === 'codex-cli-subscription')?.models.find(entry => entry.model.nativeId === codexModel)?.activation?.state ?? null;
    await expect(codex('x-0')).resolves.toMatchObject({ status: 'connected', cli: { configDir: codexDir, delegate: ['ai'] }, worker: 'image-required',
      steps: { declaration: 'written', profile: 'written', activation: 'written' } });
    expect(await workerModel()).not.toBe('active');
    expect((await inspectConfiguredInvocableModels(h.f.project, 'scope', { env: h.f.env })).models.find(model => model.nativeId === codexModel)?.availability).toEqual({ invocable: true, reason: null });
    const written = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const profiles = (written['provider_invocation_profiles'] as { profiles: (Profile & { protocol: { family: string } })[] }).profiles;
    expect(profiles.find(item => item.protocol.family === CODEX_FAMILY)).toMatchObject({ schemaVersion: 2, billingAxis: 'subscription', adapter: { id: 'native-cli-headless',
      definition: { executable: codexExe, configDir: codexDir, delegatedUse: { classes: ['ai'] } } } });
    expect(roleModelInvocationReference({ modelRoles: undefined, providerCatalog: written['provider_catalog'], activation: async () => null }, written['provider_invocation_profiles'], 'scope',
      { channelId: 'codex-cli-subscription', modelId: codexModel })).toMatchObject({ providerId: 'codex-cli-subscription' });
    await writeFile(path, JSON.stringify({ ...written, admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: { profiles: [{ id: 'codex-worker', version: 1,
      parameters: { nativeSubscription: { provider: 'codex', preflight: { cliVersion: 'codex-cli 9.1.0' } } } }] } } }));
    await expect(codex('x-1')).resolves.toMatchObject({ status: 'connected', worker: 'written', steps: { declaration: 'present', profile: 'present', activation: 'written' } });
    expect(await workerModel()).toBe('active');
  });
});
