// S3-5 customer isolation of the headless subscription Brain: the CLI runs inside a bubblewrap realm (the bundled locked build in tests) that shows
// it only the system prefixes, its own executable, the person's bound login dir and its private run dir; its network is the provider allowlist
// through the gateway. A scripted fake CLI probes the realm from inside: no real CLI, no model call, no real credential.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { Server as HttpServer } from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/server';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bubblewrapObservation } from '#adapters/index.js';
import * as processRunner from '#adapters/core/process-runner/index.js';
import * as egressGateway from '#adapters/core/native-connection/index.js';
import { readHeadlessRejection } from '#domain/index.js';
import { prepareHeadlessConnection, readHeadlessLogins, runHeadlessLogin, resolveHeadlessExecutable, runHeadlessIsolated } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { createClaudeAgentDriver, nativeWorkerProcessResult } from '#capabilities/core/native-agent-execution/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { headlessDiagnosticCases } from '#platform/core/errors/index.js';
import { renderHeadlessLogin } from '#surfaces/core/cli-models/index.js';
import { doctorChecks, type DoctorCheckFacts } from '#surfaces/core/doctor/index.js';
import { assistantLine, fullHelp, headless, initLine, rateLimitLine, resultLine, uiLine, type BoundProbe, type FakeStep, type IsolationProbe } from '../../fixtures/native-headless/stream.js';
import { binding, cleanupConnections, connection, request, testIsolation } from '../../fixtures/native-headless/connection.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const servers: Server[] = [];
vi.mock('node:fs/promises', async original => ({ ...await original<typeof files>() }));
afterEach(async () => { await cleanupConnections(); await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';
const cleanupEntry = nativeCliAgent('claude-code-stream-json')!;
async function workerCleanupFixture() {
  const c = await connection(), stateDir = join(c.root, 'state'), runDir = join(stateDir, 'work');
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(process.execPath, { bigint: true });
  const isolation = async () => ({ ...bubblewrapObservation('available'), status: 'available' as const,
    launcher: { source: 'system' as const, path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
      identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` } });
  const program = await resolveHeadlessExecutable(cleanupEntry, c.executable, process.getuid!());
  const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async input => ({
    schemaVersion: 1, requestId: input.requestId, started: true, reason: 'exit', exitCode: 0, signal: null,
    stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
  }));
  const run = async (mcp?: Awaited<ReturnType<typeof createNativeToolBridge>>, line?: Parameters<typeof runHeadlessIsolated>[5]) => {
    let refused = false;
    const evidence = await runHeadlessIsolated(cleanupEntry, isolation, { program, executable: c.executable, args: [], env: {},
      stateDir, runDir, configDir: c.configDir, mcp, now: Date.now }, { timeoutMs: 1000, outputBytes: 4096, stderrBytes: 4096,
      maxLineBytes: 4096, interruptGraceMs: 100 }, undefined, line && (async (raw, signal) => {
      const decision = await line(raw, signal);
      refused ||= decision === 'stop';
      return decision;
    }));
    expect(runner).toHaveBeenCalledOnce();
    expect(evidence).toMatchObject({ started: true, exitCode: 0 });
    return nativeWorkerProcessResult(evidence, false, refused, refused ? undefined : { kind: 'completed', text: 'otherwise usable work' });
  };
  return { ...c, run, runDir, runner };
}

it.skipIf(process.platform !== 'linux')('keeps a worker guard refusal when removing its login marker fails', async () => {
  const f = await workerCleanupFixture(), remove = files.rm, removalFailed = vi.fn();
  const guard = createClaudeAgentDriver({ entry: cleanupEntry, model: 'fixture-model', cliVersion: '9.1.0', runDir: f.runDir,
    outputMaxBytes: 4096, quotaPolicy: egressGateway.nativeQuotaPolicy(),
    port: { session: { schemaVersion: 1, turnId: 'fixture-turn', generation: 1, tools: [], approvalTtlMs: 1000 },
      propose: vi.fn(), cancel: vi.fn(), revoke: vi.fn() } });
  const finish = f.runner.getMockImplementation()!;
  f.runner.mockImplementationOnce(async (request, signal, onLine) => {
    expect(await onLine?.('{"type":"assistant"}', signal ?? new AbortController().signal)).toBe('stop');
    return finish(request, signal, onLine);
  });
  const marker = vi.spyOn(files, 'rm').mockImplementation(async (...args) => {
    if (typeof args[0] === 'string' && args[0].endsWith('.lock')) {
      expect(f.runner).toHaveBeenCalledOnce();
      expect(guard.signal.aborted).toBe(true);
      removalFailed();
      throw new Error('fixture marker removal failure');
    }
    return remove(...args);
  });
  try {
    const result = await f.run(undefined, guard.line);
    expect(removalFailed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'failed', termination: 'unverified', text: '',
      cleanupError: { params: { check: 'lock-marker-remove' } } });
    expect(result).toHaveProperty('refusal', 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED');
  } finally { marker.mockRestore(); f.runner.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('blocks worker completion when closing the enumerated configuration directory fails', async () => {
  const f = await workerCleanupFixture(), openDirectory = files.opendir, closeFailed = vi.fn();
  const directory = vi.spyOn(files, 'opendir').mockImplementation(async (...args) => {
    const opened = await openDirectory(...args);
    if (args[0] === f.configDir) {
      const close = opened.close.bind(opened);
      opened.close = async () => { await close(); closeFailed(); throw new Error('fixture configuration directory close error'); };
    }
    return opened;
  });
  try {
    const result = await f.run();
    expect(closeFailed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'failed', termination: 'unverified', text: '', cleanupError: { params: { check: 'realm-config-directory-close' } } });
  } finally { directory.mockRestore(); f.runner.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('blocks worker completion when the gateway server close callback reports an error', async () => {
  const f = await workerCleanupFixture(), close = HttpServer.prototype.close, closeFailed = vi.fn();
  const gateway = vi.spyOn(HttpServer.prototype, 'close').mockImplementation(function (this: HttpServer, callback) {
    return close.call(this, () => { closeFailed(); callback?.(new Error('fixture gateway close callback error')); });
  });
  try {
    const result = await f.run();
    expect(closeFailed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'failed', termination: 'unverified', text: '', cleanupError: { params: { check: 'realm-gateway-close' } } });
  } finally { gateway.mockRestore(); f.runner.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('blocks worker completion when the bridge already failed to close', async () => {
  const f = await workerCleanupFixture();
  const bridge = await createNativeToolBridge({ bridge: cleanupEntry.bridge, correlationKind: 'claude-tool-use',
    limits: { idleMs: 300, maxConnections: 2, replayMaxEntries: 4, replayMaxBytes: cleanupEntry.bridge.frameMaxBytes * 4 },
    port: { session: { schemaVersion: 1, turnId: 'fixture-turn', generation: 1, tools: [], approvalTtlMs: 1000 },
      propose: vi.fn(), cancel: vi.fn(), revoke: vi.fn() } });
  const close = McpServer.prototype.close;
  const sdk = vi.spyOn(McpServer.prototype, 'close').mockImplementationOnce(async function (this: McpServer) {
    await close.call(this); throw new Error('fixture first bridge close error');
  });
  try {
    const first = bridge.close();
    await expect(first).rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'realm-bridge-close' } });
    expect(await f.run(bridge)).toMatchObject({ status: 'failed', termination: 'unverified', text: '',
      cleanupError: { params: { check: 'realm-bridge-close' } } });
    expect(bridge.close()).toBe(first);
    await expect(bridge.close()).rejects.toMatchObject({ params: { check: 'realm-bridge-close' } });
    expect(sdk).toHaveBeenCalledOnce();
  } finally { sdk.mockRestore(); f.runner.mockRestore(); }
});

const happy = (probe: IsolationProbe): FakeStep[] => [{ line: uiLine() }, { line: initLine() }, { isolation: probe }, { line: assistantLine('{"ok":true}') },
  { line: rateLimitLine() }, { line: resultLine('{"ok":true}') }];
type Results = { read: Record<string, string>; list: Record<string, string[] | string>; write: Record<string, string>; replace: Record<string, string>;
  exists: Record<string, boolean>; homeSsh: boolean; limits: Record<string, string>; tty: string; userns: number | null; connect: string[];
  proxy: ({ reached: boolean; response: string | null } | string)[] };
const results = async (c: Awaited<ReturnType<typeof connection>>) => (await c.log()).find(entry => entry.mode === 'isolation') as unknown as { results: Results; env: Record<string, string> };

describe.skipIf(process.platform !== 'linux' || !sandbox)('S3-5 the headless CLI runs isolated (bundled bubblewrap, fake CLI)', () => {
  it('sees only its login dir and run dir: the rest of HOME is absent, other login entries are masked, writes outside the bind fail', async () => {
    const c = await connection();
    const home = join(c.root, 'home'), canary = join(home, '.ssh', 'id_canary'), outside = join(c.root, 'outside.txt');
    await mkdir(join(home, '.ssh'), { recursive: true }); await writeFile(canary, 'SSH-CANARY');
    // The person's login dir: the CLI's own state files stay visible; every other existing entry is masked.
    await writeFile(join(c.configDir, '.credentials.json'), 'FIXTURE-LOGIN', { mode: 0o600 });
    await writeFile(join(c.configDir, '.claude.json.backup'), 'STATE-BEFORE', { mode: 0o600 });
    await writeFile(join(c.configDir, 'settings.json'), 'PERSON-SETTINGS'); await mkdir(join(c.configDir, 'projects'));
    await writeFile(join(c.configDir, 'projects', 'history.jsonl'), 'PERSON-HISTORY');
    const result = await c.call(happy({ read: [canary, join(c.configDir, '.credentials.json'), join(c.configDir, 'settings.json')],
      list: [join(c.configDir, 'projects'), c.root], exists: [home],
      write: [outside, '/deckent-realm-probe', join(c.configDir, 'settings.json'), join(c.configDir, 'projects', 'new.txt'), join(c.runDir, 'scratch.txt'), join(c.root, 'bin', 'planted')],
      replace: [join(c.configDir, '.claude.json.backup')] }));
    expect(result).toMatchObject({ native: { headless: { guard: 'passed' } } });
    const { results: r } = await results(c);
    expect(r.read[canary]).toBe('error:ENOENT'); expect(r.exists[home]).toBe(false); expect(r.homeSsh).toBe(false);
    expect(r.list[c.root]).not.toContain('home');
    expect(r.read[join(c.configDir, '.credentials.json')]).toBe('FIXTURE-LOGIN');
    expect(r.read[join(c.configDir, 'settings.json')]).toMatch(/^error:/u);
    expect(r.list[join(c.configDir, 'projects')]).toEqual([]);
    // Outside the login dir nothing reaches the host: the realm's root is read-only, and a path under its private /tmp lands in memory only.
    expect(r.write['/deckent-realm-probe']).toBe('error:EROFS');
    expect(existsSync(outside)).toBe(false); expect(existsSync(join(c.root, 'bin', 'planted'))).toBe(false);
    expect(r.write[join(c.configDir, 'settings.json')]).toMatch(/^error:/u); expect(await readFile(join(c.configDir, 'settings.json'), 'utf8')).toBe('PERSON-SETTINGS');
    // A masked directory and the run dir are private memory: what the CLI writes there never reaches the host.
    expect(r.write[join(c.configDir, 'projects', 'new.txt')]).toBe('written'); expect(existsSync(join(c.configDir, 'projects', 'new.txt'))).toBe(false);
    expect(r.write[join(c.runDir, 'scratch.txt')]).toBe('written'); expect(existsSync(join(c.runDir, 'scratch.txt'))).toBe(false);
    // The CLI's own state file is replaced the way the CLI writes it (sibling temporary file + rename) and the result stays on the host.
    expect(r.replace[join(c.configDir, '.claude.json.backup')]).toBe('replaced');
    expect(await readFile(join(c.configDir, '.claude.json.backup'), 'utf8')).toBe('SANDBOX-REPLACE');
  });
  it('has no network but the provider allowlist through the gateway: host loopback unreachable, a host outside the allowlist refused', async () => {
    const server = createServer(socket => socket.end('HOST-LOOPBACK')); servers.push(server);
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
    const c = await connection();
    await c.call(happy({ connect: [{ host: '127.0.0.1', port }], proxy: ['example.invalid:443', 'api.anthropic.com:80'] }));
    const { results: r, env } = await results(c);
    expect(r.connect[0]).toMatch(/^error:/u);
    // The relay answers inside the realm and hands every CONNECT to the gateway, which refuses both without a tunnel (no 200).
    for (const answer of r.proxy) expect(answer).toMatchObject({ reached: true });
    for (const answer of r.proxy) expect((answer as { response: string | null }).response ?? '').not.toMatch(/ 200 /u);
    expect(env[headless.isolation.proxy.env[0]!]).toBe(`http://${headless.isolation.proxy.host}:${headless.isolation.proxy.port}`);
    for (const name of headless.isolation.proxy.clear) expect(env[name]).toBe('');
  });
  it('f5: names the gateway refusals in the call record, the rejected body and the doctor record: counts and host names only', async () => {
    const c = await connection();
    const probe = { proxy: ['example.invalid:443', 'api.anthropic.com:80', 'Not_A_Host:443', 'example.invalid:443'] };
    const responded = await c.call(happy(probe));
    const egress = { connected: 0, refused: 4, hosts: { 'example.invalid': 2, 'api.anthropic.com': 1 }, other: 1 };
    expect(responded).toMatchObject({ native: { headless: { guard: 'passed', egress } } });
    // A rejected call carries the same summary in its adapter body (the guard stops the turn after the probe).
    const rejected = await c.call([{ line: initLine() }, { isolation: { proxy: ['example.invalid:443'] } }, { line: assistantLine('x', 'other-model') }]);
    expect(rejected).toMatchObject({ kind: 'rejected' });
    const body = readHeadlessRejection((rejected as { evidence: Parameters<typeof readHeadlessRejection>[0] }).evidence);
    expect(body).toMatchObject({ refusal: 'model-mismatch', egress: { connected: 0, refused: 1, hosts: { 'example.invalid': 1 }, other: 0 } });
    // Doctor's record is cumulative over the connection's spawns and holds no target text beyond host names.
    const record = await readFile(join(c.root, 'state', 'egress.json'), 'utf8');
    expect(JSON.parse(record)).toMatchObject({ schemaVersion: 2, refused: 5, hosts: { 'example.invalid': 3, 'api.anthropic.com': 1 }, other: 1 });
    expect(record).not.toMatch(/Not_A_Host|:443|:80/u);
    const [login] = await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId);
    expect(login?.egress).toMatchObject({ refused: 5, hosts: ['example.invalid', 'api.anthropic.com'], other: 1 });
  });
  it('records the realm of a passing check for doctor (launcher kind and version, never a path)', async () => {
    const c = await connection({ steps: happy({}) });
    await c.call();
    const [login] = await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId), launcher = (await testIsolation()).launcher!;
    expect(login).toMatchObject({ state: 'open', isolation: { launcher: launcher.source, version: launcher.version } });
    expect(JSON.stringify(JSON.parse(await readFile(join(c.root, 'state', 'preflight.json'), 'utf8')).isolation)).not.toContain('/');
  });
  it('runs under process limits: no core dump, bounded file size and descriptors, no nested user namespace, no controlling terminal', async () => {
    const c = await connection();
    await c.call(happy({}));
    const { results: r } = await results(c);
    expect(r.limits['core file size']).toBe('0');
    expect(r.limits['file size']).toBe(String(headless.isolation.limits.fileSizeBlocks * 512));
    expect(r.limits['open files']).toBe(String(headless.isolation.limits.openFiles));
    // f5: CPU time (soft:hard), the realm's tasks and the data size come from the registry through the limiter.
    const caps = headless.isolation.limits;
    expect(r.limits['cpu time']).toBe(`${caps.cpuSeconds}:${caps.cpuSeconds + caps.cpuGraceSeconds}`);
    expect(r.limits['processes']).toBe(String(caps.processes)); expect(r.limits['data size']).toBe(String(caps.dataBytes));
    if (existsSync('/usr/bin/unshare')) expect(r.userns).not.toBe(0);
    expect(r.tty).toMatch(/^error:/u);
  });
  // f5: a bound that stops the CLI is a typed rejected receipt naming it; a crash away from every bound stays an unknown outcome.
  const bounded = (probe: BoundProbe): FakeStep[] => [{ line: initLine() }, { bound: probe }];
  const limitOf = async (probe: BoundProbe) => {
    const c = await connection(), result = await c.call(bounded(probe));
    expect(result).toMatchObject({ kind: 'rejected', evidence: { reason: 'response-limit' } });
    return readHeadlessRejection((result as { evidence: Parameters<typeof readHeadlessRejection>[0] }).evidence);
  };
  it('f5: the CPU time bound stops a spinning CLI at the soft limit (SIGXCPU) and, when it ignores that, at the hard one', async () => {
    expect(await limitOf({ lower: ['--cpu=1:2'], burn: 'cpu' })).toMatchObject({ refusal: 'resource-limit', field: 'cpu-time' });
    expect(await limitOf({ lower: ['--cpu=1:2'], burn: 'cpu-ignore' })).toMatchObject({ refusal: 'resource-limit', field: 'cpu-time' });
  }, 30_000);
  it('f5: the realm task bound refuses one more process and the CLI that aborts on it is named', async () => {
    expect(await limitOf({ burn: 'processes' })).toMatchObject({ refusal: 'resource-limit', field: 'processes' });
  }, 30_000);
  it('f5: the data size bound refuses memory and the CLI that aborts on it is named', async () => {
    expect(await limitOf({ lower: ['--data=+134217728'], burn: 'memory' })).toMatchObject({ refusal: 'resource-limit', field: 'memory' });
  }, 30_000);
  it('f5 negative: a crash away from every bound, or a CLI exit with a reserved code, is never named a bound (unknown outcome)', async () => {
    const c = await connection();
    // 1b: the crash settles as incomplete evidence (unknown receipt) with the mirrored exit code, never a typed bound.
    for (const [steps, exitCode] of [[bounded({ burn: 'abort' }), 134], [[{ line: initLine() }, { exit: headless.isolation.limits.exits['cpu-time'] }], 1]] as const) {
      const evidence = (await c.call(steps as FakeStep[]) as { evidence: Parameters<typeof readHeadlessRejection>[0] & { reason: string } }).evidence;
      expect(evidence).toMatchObject({ reason: 'interrupted', body: { complete: false } });
      expect(readHeadlessRejection(evidence)).toMatchObject({ refusal: 'process-exit', exitCode });
    }
  }, 30_000);
  it('f5 negative: an interrupted turn near the data bound is never named a bound (its outcome stays unknown)', async () => {
    const c = await connection();
    expect(await c.call(bounded({ lower: ['--data=+1048576'], burn: 'interrupt' }))).toMatchObject({ evidence: { reason: 'interrupted', body: { complete: false } } });
    expect((await c.log()).map(entry => entry.mode)).toContain('interrupted');
  }, 30_000);
  it('keeps SIGINT first through the realm: a cancelled turn is interrupted inside the sandbox, then the outcome is unknown', async () => {
    const c = await connection({ steps: [{ line: initLine() }, { hang: true }] }), controller = new AbortController();
    await c.port.preflight(c.profile);
    const { binding, request } = await import('../../fixtures/native-headless/connection.js');
    const pending = c.port.send(await c.port.prepare(c.profile, binding, request()), controller.signal);
    setTimeout(() => controller.abort(), 400);
    await expect(pending).rejects.toThrow();
    expect((await c.log()).map(entry => entry.mode)).toContain('interrupted');
  });
});

describe.skipIf(process.platform !== 'linux')('S3-5 no unisolated fallback', () => {
  const unavailable = async () => bubblewrapObservation('unavailable', 'no bubblewrap launcher');
  const doctor = (logins: DoctorCheckFacts['headlessLogins'], locale: 'en' | 'tr', checkId = 'work.brainLogin') => doctorChecks({
    platform: 'linux', host: { cpuCores: 1, totalMemMB: 1024, recommendedMaxWorkers: 1 }, company: { companyId: 'default' },
    principal: { id: 'fixture' }, secretStore: null, imageRefresh: null, installationBinding: null, shellRealm: null,
  }, { scopeId: 'scope', toolchainsRequested: false, identityProfile: null, backupPassphraseStored: null,
    retiringModels: [], poolStatus: 'unconfigured', toolchainUpdateEnabled: false, imageId: null, headlessLogins: logins }, locale)
    .find(row => row.id === checkId)?.text;

  it('Doctor preserves the bind-race diagnostic after persistence and treats ambiguous legacy checks as unverified', async () => {
    const c = await connection({}, {}, 'a'.repeat(64), async () => launcher);
    const path = join(c.root, 'bin', 'fake-launcher');
    await writeFile(path, '#!/bin/sh\necho "bwrap: Race condition binding dirfd" >&2\nexit 1\n', { mode: 0o700 });
    const info = lstatSync(path, { bigint: true }), launcher = { ...bubblewrapObservation('available'), status: 'available' as const,
      launcher: { source: 'system' as const, path, version: '0.13.0', sha256: null, overlay: true,
        identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` } };
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ params: { check: 'executable-changed', reason: 'bind-race-diagnostic' } });
    const logins = () => readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId);
    const stored = await logins();
    expect.soft(doctor(stored, 'en')).toContain('The process exited with a bind-race diagnostic.');
    expect.soft(doctor(stored, 'tr')).toContain('Süreç, bağlama yarışı tanısıyla sonlandı.');
    expect.soft(doctor(stored, 'en')).not.toContain('identity differs');
    expect.soft(doctor(stored, 'en')).not.toContain('outside');
    expect(await readFile(join(c.root, 'state', 'preflight.json'), 'utf8')).not.toContain(c.executable);
    for (const check of ['executable-changed', 'npm-layout-unknown']) {
      await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'closed', refusal: 'HEADLESS_PREFLIGHT_FAILED', check }));
      expect.soft(doctor(await logins(), 'en')).toContain('The provider-program diagnostic could not be verified.');
    }
    await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'closed', refusal: 'HEADLESS_PREFLIGHT_FAILED', check: 'realm-scratch-create' }));
    expect(doctor(await logins(), 'en')).toContain('The temporary directory for the isolated login view could not be created.');
    await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'closed', refusal: 'HEADLESS_ISOLATION_UNAVAILABLE', check: 'limits' }));
    const legacy = await logins();
    expect.soft(doctor(legacy, 'en')).toContain('The check recorded an isolation refusal. The previous check concerned isolation limits. The specific cause could not be determined.');
    expect.soft(doctor(legacy, 'tr')).toContain('Önceki denetim yalıtım sınırlarıyla ilgiliydi. Kesin neden belirlenemedi.');
    expect(legacy[0]?.isolation).toBe('unavailable');
    await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'closed', refusal: 'HEADLESS_LOGIN_REQUIRED', check: null }));
    expect.soft(doctor(await logins(), 'en')).toContain('The previous check recorded a sign-in requirement. The specific reason could not be verified.');
    expect.soft(doctor(await logins(), 'tr')).toContain('Önceki denetimde oturum açma gerekliliği kaydedildi. Kesin neden doğrulanamadı.');
    for (const [refusal, check, en, tr] of [
      ['HEADLESS_PREFLIGHT_FAILED', 'version', 'The previous check concerned the CLI version. The specific cause could not be determined.',
        'Önceki denetim CLI sürümüyle ilgiliydi. Kesin neden belirlenemedi.'],
      ['HEADLESS_PREFLIGHT_FAILED', 'flags', 'The previous check concerned CLI options. The specific cause could not be determined.',
        'Önceki denetim CLI seçenekleriyle ilgiliydi. Kesin neden belirlenemedi.'],
      ['HEADLESS_PREFLIGHT_FAILED', 'spawn', 'The previous check concerned running a CLI probe. The specific cause could not be determined.',
        'Önceki denetim CLI yoklamasının çalıştırılmasıyla ilgiliydi. Kesin neden belirlenemedi.'],
      ['HEADLESS_PREFLIGHT_FAILED', 'config-dir', 'The previous check concerned the CLI login configuration directory. The specific cause could not be determined.',
        'Önceki denetim CLI oturum açma yapılandırma diziniyle ilgiliydi. Kesin neden belirlenemedi.'],
      ['HEADLESS_ISOLATION_UNAVAILABLE', 'login-lock', 'The previous check could not acquire the sign-in lock. The specific cause could not be verified.',
        'Önceki denetim oturum açma kilidini alamadı. Kesin neden doğrulanamadı.'],
      ['HEADLESS_LIMIT_REACHED', null, 'The previous check recorded a resource limit. Which limit was reached could not be verified.',
        'Önceki denetimde bir kaynak sınırı kaydedildi. Hangi sınıra ulaşıldığı doğrulanamadı.'],
      ['HEADLESS_LOGIN_BUSY', null, 'The previous check recorded a busy sign-in lock. The holder could not be verified.',
        'Önceki denetimde oturum açma kilidi meşgul olarak kaydedildi. Kilidi kimin tuttuğu doğrulanamadı.'],
    ] as const) {
      await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'closed', refusal, check }));
      const history = await logins();
      expect.soft(doctor(history, 'en')).toContain(en);
      expect.soft(doctor(history, 'tr')).toContain(tr);
    }
    await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'open', version: '9.0.0' }));
    expect.soft((await logins())[0]?.state).toBe('unknown');
    expect.soft(doctor(await logins(), 'en')).toContain('The previous subscription CLI check record could not be interpreted.');
  });

  it('Doctor and the shared error renderer treat malformed diagnostic cases as unverified for every code', async () => {
    const c = await connection({}, {}, 'a'.repeat(64), unavailable);
    await mkdir(join(c.root, 'state'), { mode: 0o700 });
    for (const code of new Set(headlessDiagnosticCases.map(row => row.code))) {
      const params = { invalid: '/private/g3-r9-diagnostic-canary' };
      await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'closed', refusal: { code, params } }));
      const logins = await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId);
      const error = ErrorRegistry.createError(code, { params });
      for (const [locale, expected] of [['en', 'The provider-program diagnostic could not be verified.'],
        ['tr', 'Sağlayıcı programına ilişkin tanı doğrulanamadı.']] as const) {
        expect.soft(doctor(logins, locale), code).toContain(expected);
        expect.soft(error.localize?.(locale).message, code).toBe(expected);
      }
      expect(JSON.stringify(error)).not.toContain(params.invalid);
    }
    for (const version of ['2.0.0', '10.0.0']) {
      await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'closed',
        refusal: { code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'version', reason: 'too-old', version, minimum: '2.0.0' } } }));
      const logins = await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId);
      expect(doctor(logins, 'en')).toContain('The provider-program diagnostic could not be verified.');
      expect(doctor(logins, 'tr')).toContain('Sağlayıcı programına ilişkin tanı doğrulanamadı.');
    }
  });
  it('keeps the text response limit when deleting the prompt fails', async () => {
    const info = lstatSync(process.execPath, { bigint: true });
    const c = await connection({}, {}, 'a'.repeat(64), async () => ({ ...bubblewrapObservation('available'), status: 'available',
      launcher: { source: 'system', path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
        identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` } }));
    const parserRefusals = "option '--max-turns <turns>' argument 'invalid' is invalid. must be a number\noption '--system-prompt-file <file>' argument missing";
    const preflightReplies = ['9.1.0 (Claude Code)', fullHelp(), parserRefusals, parserRefusals,
      JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'fixture', configDirectory: c.configDir })];
    const replies = [...preflightReplies];
    let stdoutBound = false;
    const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async input => {
      const body = replies.shift();
      return { schemaVersion: 1, requestId: input.requestId, started: true, reason: body === undefined ? 'output-limit' : 'exit',
        exitCode: body === undefined ? null : 0, signal: null, stdoutBase64: Buffer.from(body ?? (stdoutBound ? '/fixture/private-stdout' : '')).toString('base64'),
        stderrBase64: body === undefined && !stdoutBound ? Buffer.from('/fixture/private-stderr').toString('base64') : '',
        stdoutTruncated: body === undefined && stdoutBound, stderrTruncated: body === undefined && !stdoutBound, durationMs: 1 };
    });
    const remove = files.rm;
    const cleanup = vi.spyOn(files, 'rm').mockImplementation(async (...args) => {
      if (args[0] === join(c.root, 'state', 'run', headless.systemPromptFile)) throw new Error('fixture prompt cleanup failure');
      return remove(...args);
    });
    try {
      await mkdir(join(c.root, 'state'), { mode: 0o700 });
      await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ state: 'open', version: '2.0.0', executable: '' }), { mode: 0o600 });
      await c.port.preflight(c.profile);
      const logins = await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId);
      expect.soft(logins[0]).toMatchObject({ state: 'open', cliUpdated: null });
      expect.soft(doctor(logins, 'en', 'work.cliUpdated')).toBeUndefined();
      expect.soft(doctor(logins, 'tr', 'work.cliUpdated')).toBeUndefined();
      const recordPath = join(c.root, 'state', 'preflight.json');
      const current = JSON.parse(await readFile(recordPath, 'utf8'));
      for (const [minimum, prior] of [
        ['9.0.1', { state: 'open', version: '2.0.0' }],
        ['9.0.2', { ...current, schemaVersion: 1, updatedFrom: '2.0.0' }],
        ['9.0.3', { ...current, schemaVersion: 2, updatedFrom: '2.0.0' }],
      ] as const) {
        await writeFile(recordPath, JSON.stringify(prior));
        replies.push(...preflightReplies);
        await c.port.preflight({ ...c.profile, adapter: { ...c.profile.adapter, definition: { ...c.profile.adapter.definition as object, minCliVersion: minimum } } });
        expect.soft(JSON.parse(await readFile(recordPath, 'utf8'))).toMatchObject({ schemaVersion: 1, version: '9.1.0', updatedFrom: null });
      }
      for (const which of ['stderr', 'stdout']) {
        stdoutBound = which === 'stdout';
        const result = await c.port.send(await c.port.prepare(c.profile, binding, request()));
        expect(result).toMatchObject({ kind: 'rejected' });
        if ('kind' in result) {
          const body = readHeadlessRejection(result.evidence);
          expect(body).toMatchObject({ refusal: 'response-limit' });
          expect(body).not.toHaveProperty('field');
          expect(JSON.stringify(body)).not.toContain(`/fixture/private-${which}`);
        }
        await remove(join(c.root, 'state', 'run', headless.systemPromptFile));
      }
    } finally { cleanup.mockRestore(); runner.mockRestore(); }
  });

  it('preserves the sign-in command exit and the positive nonzero status when realm cleanup fails', async () => {
    const c = await connection({ loginExit: 130 });
    const info = lstatSync(process.execPath, { bigint: true });
    const isolation = async () => ({ ...bubblewrapObservation('available'), status: 'available' as const,
      launcher: { source: 'system' as const, path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
        identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` } });
    const openGateway = egressGateway.openNativeEgressGateway;
    const gateway = vi.spyOn(egressGateway, 'openNativeEgressGateway').mockImplementation(async input => {
      const opened = await openGateway(input);
      return { ...opened, async close() { await opened.close(); throw new Error('fixture gateway cleanup failure'); } };
    });
    const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async input => ({
      schemaVersion: 1, requestId: input.requestId, started: true, reason: 'exit', exitCode: 9, signal: null,
      stdoutBase64: Buffer.from(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'fixture', configDirectory: c.configDir })).toString('base64'),
      stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
    }));
    try {
      const result = await runHeadlessLogin({ family: c.profile.protocol.family, stateDir: join(c.root, 'state'), configDir: c.configDir,
        owned: true, executable: c.executable, sso: false, env: {}, now: Date.now, isolation });
      expect(result).toMatchObject({ exit: 'cancelled', signedIn: true, statusIssue: { params: { check: 'login-status-positive-nonzero' } },
        cleanupIssue: { params: { check: 'realm-gateway-close' } } });
      expect(renderHeadlessLogin(result, 'en', 'fixture')).toContain('The sign-in command was interrupted.');
      expect(renderHeadlessLogin(result, 'tr', 'fixture')).toContain('Giriş komutu kesildi.');
    } finally { gateway.mockRestore(); runner.mockRestore(); }
  });

  it('Doctor shows a completed negative parser probe even when its scratch cleanup fails', async () => {
    const info = lstatSync(process.execPath, { bigint: true });
    const c = await connection({}, {}, 'a'.repeat(64), async () => ({ ...bubblewrapObservation('available'), status: 'available',
      launcher: { source: 'system', path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
        identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` } }));
    const remove = files.rm;
    const cleanup = vi.spyOn(files, 'rm').mockImplementation(async (...args) => {
      if (typeof args[0] === 'string' && /\/probe-[^/]+$/u.test(args[0])) throw new Error('fixture probe cleanup failure');
      return remove(...args);
    });
    const replies = ['9.1.0 (Claude Code)', fullHelp(), 'parser output without the required refusal'];
    const openGateway = egressGateway.openNativeEgressGateway;
    const closeFailed = vi.fn();
    const gateway = vi.spyOn(egressGateway, 'openNativeEgressGateway').mockImplementation(async input => {
      const opened = await openGateway(input);
      return { ...opened, async close() {
        await opened.close();
        if (!replies.length) { closeFailed(); throw new Error('fixture realm gateway cleanup failure'); }
      } };
    });
    const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async input => ({
      schemaVersion: 1, requestId: input.requestId, started: true, reason: 'exit', exitCode: 0, signal: null,
      stdoutBase64: Buffer.from(replies.shift() ?? '').toString('base64'), stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
    }));
    try {
      await expect.soft(c.port.preflight(c.profile)).rejects.toMatchObject({ params: { check: 'flags', reason: 'parser-unverified' } });
      expect(cleanup.mock.calls.some(([path]) => typeof path === 'string' && /\/probe-[^/]+$/u.test(path))).toBe(true);
      expect(closeFailed).toHaveBeenCalledOnce();
      const logins = await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId);
      expect(doctor(logins, 'en')).toContain('parser');
      expect(doctor(logins, 'tr')).toContain('ayrıştırıcı');
    } finally { cleanup.mockRestore(); gateway.mockRestore(); runner.mockRestore(); }
  });
  it('refuses typed before any spawn when no bubblewrap launcher is usable (preflight and connect)', async () => {
    const c = await connection({ steps: happy({}) }, {}, 'a'.repeat(64), unavailable);
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE', params: { check: 'launcher' } });
    await expect(prepareHeadlessConnection({ protocol: { family: c.profile.protocol.family, version: 'v1' }, minCliVersion: '9.0.0', stateDir: join(c.root, 'state'),
      executable: c.executable, configDir: c.configDir, env: {}, now: () => 1, isolation: unavailable })).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE' });
    expect(await c.log()).toEqual([]);
    // Doctor requires evidence for the preceding version even when the current executable matches.
    const program = await resolveHeadlessExecutable(cleanupEntry, c.executable, process.getuid!());
    const observed = { state: 'open', updatedFrom: '1.0.0', version: '2.0.0', executable: c.executable,
      revision: headless.revision, size: program.size, mtimeMs: Math.trunc(program.mtimeMs) };
    const update = async (record: object) => {
      await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify(record));
      return (await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId))[0]?.cliUpdated;
    };
    expect.soft(await update(observed)).toBeNull();
    const sealed = { ...observed, schemaVersion: 2, revision: `${headless.revision}:${program.identity}` };
    expect.soft(await update({ ...sealed, updatedFrom: 'not-a-version' })).toBeNull();
    expect.soft(await update({ ...sealed, updatedFrom: observed.version })).toBeNull();
    await writeFile(join(c.root, 'state', 'preflight.json'), JSON.stringify({ ...sealed, schemaVersion: 1 }));
    const logins = await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId);
    expect(doctor(logins, 'en')).toContain('channel open');
    expect(doctor(logins, 'tr')).toContain('kanal açık');
    expect(doctor(logins, 'en', 'work.cliUpdated')).toBeUndefined();
    expect(doctor(logins, 'tr', 'work.cliUpdated')).toBeUndefined();
    await update(sealed);
    expect((await readHeadlessLogins({ profiles: [c.profile] }, c.profile.scopeId))[0]?.cliUpdated).toEqual({ cli: 'fake-cli', from: '1.0.0', to: '2.0.0' });
    expect(await c.log()).toEqual([]);
  });
  it('closes the channel typed when the realm itself cannot start (a launcher that refuses), and never runs the CLI outside it', async () => {
    const c = await connection({ steps: happy({}) }, {}, 'a'.repeat(64), async () => broken);
    const path = join(c.root, 'bin', 'bwrap-refusing');
    await writeFile(path, '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n'); await chmod(path, 0o700);
    const info = lstatSync(path, { bigint: true }), broken = { ...bubblewrapObservation('available'), status: 'available' as const, launcher: { source: 'system' as const, path,
      version: '0.13.0', sha256: null, overlay: true, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` } };
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE', params: { check: 'realm' } });
    expect(await c.log()).toEqual([]);
    const profiles = { profiles: [{ ...c.profile, scopeId: 'scope' }] };
    expect(await readHeadlessLogins(profiles, 'scope')).toMatchObject([{ state: 'closed', isolation: 'unavailable' }]);
  });
  it('refuses typed when the kernel restricts the user namespace the realm needs', async () => {
    const restricted = async () => ({ ...(await testIsolation()), status: 'restricted' as const });
    const c = await connection({ steps: happy({}) }, {}, 'a'.repeat(64), restricted);
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE', params: { check: 'user-namespace' } });
    expect(await c.log()).toEqual([]);
  });
});
