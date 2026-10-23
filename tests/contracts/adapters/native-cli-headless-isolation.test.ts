// S3-5 customer isolation of the headless subscription Brain: the CLI runs inside a bubblewrap realm (the bundled locked build in tests) that shows
// it only the system prefixes, its own executable, the person's bound login dir and its private run dir; its network is the provider allowlist
// through the gateway. A scripted fake CLI probes the realm from inside: no real CLI, no model call, no real credential.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bubblewrapObservation } from '#adapters/index.js';
import { prepareHeadlessConnection } from '#adapters/core/native-cli-headless/index.js';
import { assistantLine, headless, initLine, rateLimitLine, resultLine, uiLine, type FakeStep, type IsolationProbe } from '../../fixtures/native-headless/stream.js';
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
  it('runs under process limits: no core dump, bounded file size and descriptors, no nested user namespace, no controlling terminal', async () => {
    const c = await connection();
    await c.call(happy({}));
    const { results: r } = await results(c);
    expect(r.limits['core file size']).toBe('0');
    expect(r.limits['file size']).toBe(String(headless.isolation.limits.fileSizeBlocks * 512));
    expect(r.limits['open files']).toBe(String(headless.isolation.limits.openFiles));
    if (existsSync('/usr/bin/unshare')) expect(r.userns).not.toBe(0);
    expect(r.tty).toMatch(/^error:/u);
  });
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
  it('refuses typed when the kernel restricts the user namespace the realm needs', async () => {
    const restricted = async () => ({ ...(await testIsolation()), status: 'restricted' as const });
    const c = await connection({ steps: happy({}) }, {}, 'a'.repeat(64), restricted);
    await expect(c.port.preflight(c.profile)).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE', params: { check: 'user-namespace' } });
    expect(await c.log()).toEqual([]);
  });
});
