// S3-5 customer isolation of the headless subscription Brain: the CLI runs inside a bubblewrap realm (the bundled locked build in tests) that shows
// it only the system prefixes, its own executable, the person's bound login dir and its private run dir; its network is the provider allowlist
// through the gateway. A scripted fake CLI probes the realm from inside: no real CLI, no model call, no real credential.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bubblewrapObservation } from '#adapters/index.js';
import { readHeadlessRejection } from '#domain/index.js';
import { prepareHeadlessConnection, readHeadlessLogins } from '#adapters/core/native-cli-headless/index.js';
import { assistantLine, headless, initLine, rateLimitLine, resultLine, uiLine, type BoundProbe, type FakeStep, type IsolationProbe } from '../../fixtures/native-headless/stream.js';
import { cleanupConnections, connection, testIsolation } from '../../fixtures/native-headless/connection.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

const servers: Server[] = [];
afterEach(async () => { await cleanupConnections(); await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve)))); });
const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';
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
    expect(JSON.parse(record)).toMatchObject({ schemaVersion: 1, refused: 5, hosts: { 'example.invalid': 3, 'api.anthropic.com': 1 }, other: 1 });
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
    await expect(c.call(bounded({ burn: 'abort' }))).rejects.toThrow('HEADLESS_OUTCOME_UNKNOWN');
    await expect(c.call([{ line: initLine() }, { exit: headless.isolation.limits.exits['cpu-time'] }])).rejects.toThrow('HEADLESS_OUTCOME_UNKNOWN');
  }, 30_000);
  it('f5 negative: an interrupted turn near the data bound is never named a bound (its outcome stays unknown)', async () => {
    const c = await connection();
    await expect(c.call(bounded({ lower: ['--data=+1048576'], burn: 'interrupt' }))).rejects.toThrow('HEADLESS_OUTCOME_UNKNOWN');
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
  it('refuses typed before any spawn when no bubblewrap launcher is usable (preflight and connect)', async () => {
    const c = await connection({ steps: happy({}) }, {}, 'a'.repeat(64), unavailable);
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE', params: { check: 'launcher' } });
    await expect(prepareHeadlessConnection({ protocol: { family: c.profile.protocol.family, version: 'v1' }, minCliVersion: '9.0.0', stateDir: join(c.root, 'state'),
      executable: c.executable, configDir: c.configDir, env: {}, now: () => 1, isolation: unavailable })).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE' });
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
