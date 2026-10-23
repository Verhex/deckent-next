// s3c (owner 2026-10-24): the subscription Brain's own Deckent-owned login dir and the person's sign-in through the CLI's own login. A scripted fake
// CLI stands in for the real one (no real sign-in, no model call). The credential canary it writes has mode 0000: no reader, Deckent included.
import { chmod, lstat, mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headlessOwnedLoginDir, runHeadlessLogin } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliHeadless, parseNativeCliRegistry } from '#adapters/core/native-cli-registry/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };
import { FAMILY } from '../../fixtures/native-headless/stream.js';
import { cleanupConnections, connection, testIsolation } from '../../fixtures/native-headless/connection.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

afterEach(cleanupConnections);
const CANARY = 'CREDENTIAL-CANARY-91c2', SECRET = 'sk-ant-SENTINEL-4d1e';
type Logged = { mode: string; argv: string[]; env: Record<string, string>; cwd: string };

type H = { login?: { env: { inherit: string[]; fixed: Record<string, string> }; timeoutMs: number }; isolation: { refreshLock: { staleMs: number } } };
describe('s3c login registry data', () => {
  it('the sign-in is registry data: the subscription login argv, an SSO switch, a bound below the lock\'s stale age, and no deny name in its environment', () => {
    const { headless } = nativeCliHeadless(FAMILY)!;
    expect(headless.login.args).toEqual(['auth', 'login', '--claudeai']);
    expect(headless.login.ssoFlag).toBe('--sso');
    expect(headless.login.timeoutMs).toBeLessThan(headless.isolation.refreshLock.staleMs);
    expect([...headless.login.env.inherit, ...Object.keys(headless.login.env.fixed)].filter(name => headless.env.deny.includes(name))).toEqual([]);
    expect(headless.connect).not.toHaveProperty('configDirDefault');
  });
  it.each([
    ['a deny name inherited by the sign-in', (h: H) => { h.login!.env.inherit = [...h.login!.env.inherit, 'ANTHROPIC_API_KEY']; }],
    ['a deny name fixed for the sign-in', (h: H) => { h.login!.env.fixed = { ...h.login!.env.fixed, CLAUDE_CODE_OAUTH_TOKEN: 'x' }; }],
    ['the login dir name inherited from the person', (h: H) => { h.login!.env.inherit = [...h.login!.env.inherit, 'CLAUDE_CONFIG_DIR']; }],
    ['a sign-in bound past the lock\'s stale age', (h: H) => { h.login!.timeoutMs = h.isolation.refreshLock.staleMs; }],
    ['no sign-in block', (h: H) => { delete h.login; }],
  ])('refuses %s', (_name, mutate) => {
    const copy = structuredClone(registry) as unknown as { adapters: { claude: { headless: Record<string, unknown> } } };
    mutate(copy.adapters.claude.headless as unknown as H);
    expect(() => parseNativeCliRegistry(copy)).toThrow();
  });
});

const sandbox = process.platform === 'linux' && (await measureTestShellHost()).bubblewrap.status === 'available';
describe.skipIf(!sandbox)('s3c the Brain\'s own login dir and the person\'s sign-in (fake CLI)', () => {
  it('the owned dir is <resource>/<registry CLI id>, created 0700; an existing open or linked one is refused typed', async () => {
    const c = await connection(), resource = join(c.root, 'logins');
    await mkdir(resource, { mode: 0o700 });
    const dir = await headlessOwnedLoginDir(FAMILY, resource);
    expect(dir).toBe(join(resource, 'claude'));
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect(await headlessOwnedLoginDir(FAMILY, resource)).toBe(dir);
    await chmod(dir, 0o750);
    await expect(headlessOwnedLoginDir(FAMILY, resource)).rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'config-dir' } });
    const other = join(c.root, 'linked'); await mkdir(join(other), { mode: 0o700 }); await symlink(c.configDir, join(other, 'claude'));
    await expect(headlessOwnedLoginDir(FAMILY, other)).rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'config-dir' } });
    await expect(headlessOwnedLoginDir('codex-exec-json', resource)).rejects.toMatchObject({ code: 'HEADLESS_REQUEST_INVALID' });
  });
  it('the sign-in runs the registry argv with a built environment (no key, token or unrelated name of the person), then the CLI\'s own status says signed in', async () => {
    const c = await connection({ authFromLogin: true });
    const person = { HOME: '/home/person', PATH: '/usr/bin:/bin', TERM: 'xterm-256color', BROWSER: 'wslview', ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET,
      ANTHROPIC_BASE_URL: 'https://proxy.invalid', CLAUDE_CONFIG_DIR: '/home/person/.claude', UNRELATED_SECRET: SECRET };
    const login = (sso = false) => runHeadlessLogin({ family: FAMILY, stateDir: join(c.root, 'login-state'), configDir: c.configDir, owned: true, executable: c.executable, sso,
      env: person, now: () => 1, isolation: testIsolation });
    const result = await login();
    expect(result).toEqual({ schemaVersion: 1, configDir: c.configDir, owned: true, exit: 'completed', signedIn: true, authMethod: 'claude.ai', subscriptionType: 'fixture' });
    const signIn = (await c.log() as Logged[]).filter(entry => entry.mode === 'login');
    expect(signIn).toHaveLength(1);
    expect(signIn[0]!.argv).toEqual(registry.adapters.claude.headless.login.args);
    const { inherit, fixed } = registry.adapters.claude.headless.login.env;
    expect(Object.keys(signIn[0]!.env).sort()).toEqual([...new Set([...inherit.filter(name => name in person), ...Object.keys(fixed), 'CLAUDE_CONFIG_DIR'])].sort());
    expect(signIn[0]!.env).toMatchObject({ CLAUDE_CONFIG_DIR: c.configDir, HOME: '/home/person', BROWSER: 'wslview', ...fixed });
    expect(JSON.stringify(signIn)).not.toContain(SECRET);
    expect(signIn[0]!.cwd).toBe(join(c.root, 'login-state', 'run'));
    // The status after it ran inside the realm with the call's built environment (HOME = Deckent's run dir); its account fields stay out of the result.
    const status = (await c.log() as Logged[]).filter(entry => entry.mode === 'auth').at(-1)!;
    expect(status.env).toMatchObject({ HOME: join(c.root, 'login-state', 'run'), CLAUDE_CONFIG_DIR: c.configDir });
    expect(JSON.stringify(result)).not.toMatch(/person@|org-fixture|Fixture Org/u);
    await login(true);
    expect((await c.log() as Logged[]).filter(entry => entry.mode === 'login')[1]!.argv).toEqual([...registry.adapters.claude.headless.login.args, '--sso']);
    // Deckent's own record of the sign-in sits beside the lock, never in the login dir; the login dir holds only what the CLI wrote.
    expect((await readdir(join(c.root, 'login-locks'))).some(name => name.endsWith('.login'))).toBe(true);
    expect((await readdir(c.configDir)).sort()).toEqual(['.claude.json', '.credentials.json']);
    expect((await lstat(join(c.configDir, '.credentials.json'))).mode & 0o777).toBe(0);
  });
  it('a sign-in since the last check re-runs the preflight (the account may have changed); without one it stays cached', async () => {
    const c = await connection({ authFromLogin: true });
    const auths = async () => (await c.log() as Logged[]).filter(entry => entry.mode === 'auth').length;
    await runHeadlessLogin({ family: FAMILY, stateDir: join(c.root, 'login-state'), configDir: c.configDir, owned: true, executable: c.executable, sso: false, env: {}, now: () => 1,
      isolation: testIsolation });
    await c.port.preflight(c.profile); const first = await auths();
    await c.port.preflight(c.profile); expect(await auths()).toBe(first);
    await runHeadlessLogin({ family: FAMILY, stateDir: join(c.root, 'login-state'), configDir: c.configDir, owned: true, executable: c.executable, sso: false, env: {}, now: () => 2,
      isolation: testIsolation });
    const signedIn = await auths();
    await c.port.preflight(c.profile); expect(await auths()).toBe(signedIn + 1);
    // The preflight record keeps the allowlisted login kind and plan only; the credential canary is in no Deckent file.
    const preflight = await readFile(join(c.root, 'state', 'preflight.json'), 'utf8');
    expect(JSON.parse(preflight)).toMatchObject({ state: 'open', auth: { authMethod: 'claude.ai', subscriptionType: 'fixture' } });
    for (const file of [preflight, ...await Promise.all((await readdir(join(c.root, 'login-locks'))).map(name => readFile(join(c.root, 'login-locks', name), 'utf8')))])
      expect(file).not.toContain(CANARY);
  });
  it('a stopped or failed sign-in is reported, not signed in; no realm means no sign-in at all (typed, before any spawn)', async () => {
    for (const [loginExit, exit] of [[130, 'cancelled'], [1, 'failed']] as const) {
      const c = await connection({ authFromLogin: true, loginExit });
      await expect(runHeadlessLogin({ family: FAMILY, stateDir: join(c.root, 'login-state'), configDir: c.configDir, owned: false, executable: c.executable, sso: false, env: {},
        now: () => 1, isolation: testIsolation })).resolves.toMatchObject({ exit, signedIn: false, authMethod: null, subscriptionType: null, owned: false });
    }
    const c = await connection({ authFromLogin: true });
    await expect(runHeadlessLogin({ family: FAMILY, stateDir: join(c.root, 'login-state'), configDir: c.configDir, owned: true, executable: c.executable, sso: false, env: {},
      now: () => 1, isolation: async () => ({ status: 'unavailable' }) as never })).rejects.toMatchObject({ code: 'HEADLESS_ISOLATION_UNAVAILABLE' });
    expect(await c.log()).toEqual([]);
    expect(existsSync(join(c.root, 'login-state'))).toBe(false);
  });
});
