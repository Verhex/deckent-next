import { chmod, link, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeCliHeadlessPort, headlessPreflight, nativeCliHeadless, prepareHeadlessConnection, readHeadlessLogins, readHeadlessSealedVersion, runHeadlessLogin,
  type HeadlessIsolation } from '#adapters/core/native-cli-headless/index.js';
import { ErrorRegistry, reportFatal, type DeckentError } from '#platform/index.js';
import { parseModelBindingDefinition, parseModelInvocationProfile } from '#domain/index.js';
import { CODEX_FAMILY, codexAnswer, fakeCodexNpm, writeFakeCodexCli, type FakeCodexScenario } from '../../fixtures/native-headless/codex.js';
import { binding, cleanupConnections, connection, request, testIsolation } from '../../fixtures/native-headless/connection.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

afterEach(cleanupConnections);
const realm = await measureTestShellHost();
const family = CODEX_FAMILY, entry = nativeCliHeadless(family)!;
async function fixture(scenario: Partial<FakeCodexScenario> = {}) {
  const c = await connection(), logPath = join(c.configDir, 'config.toml'), paths = await fakeCodexNpm(c.root, { logPath, ...scenario });
  const definition = { schemaVersion: 1 as const, executable: paths.chosen, configDir: c.configDir, stateDir: join(c.root, 'state'),
    ownerUid: process.getuid!(), delegatedUse: null, minCliVersion: '0.159.2' };
  const read = async () => (await readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { mode: string; program: string });
  return { ...paths, definition, profile: c.profile, logPath, read, stateDir: definition.stateDir };
}

describe.skipIf(realm.bubblewrap.status !== 'available' || process.platform !== 'linux' || process.arch !== 'x64')('G3 npm CLI identity in the Linux realm', () => {
  it('checks the launcher and the native file on cache hits and rejects stale stored observations', async () => {
    const f = await fixture(), check = () => headlessPreflight(entry, f.definition, Date.now, testIsolation);
    const sealedVersion = () => readHeadlessSealedVersion(f.definition, family);
    const doctor = () => readHeadlessLogins({ profiles: [{ scopeId: 'scope', protocol: { family }, adapter: { id: 'native-cli-headless', version: 1, definition: f.definition } }] }, 'scope');
    expect((await check()).executable).toBe(f.payload);
    await check();
    expect(await sealedVersion()).toBe('9.1.0');
    expect(await doctor()).toMatchObject([{ state: 'open' }]);
    expect((await f.read()).filter(row => row.mode === 'version')).toHaveLength(1);
    for (const [index, file] of [f.launcher, f.payload].entries()) {
      await writeFile(file, '\n// npm update with the same reported version\n', { flag: 'a' });
      expect(await sealedVersion()).toBeNull();
      expect(await doctor()).toMatchObject([{ state: 'unknown' }]);
      expect((await check()).executable).toBe(f.payload);
      expect(await sealedVersion()).toBe('9.1.0');
      expect((await f.read()).filter(row => row.mode === 'version')).toHaveLength(index + 2);
    }
  });

  it('accepts an explicitly chosen payload and a standalone file with the existing permission rules', async () => {
    const f = await fixture(), standalone = await writeFakeCodexCli(dirname(f.chosen), { logPath: f.logPath });
    await chmod(standalone, 0o775);
    for (const executable of [f.payload, standalone]) {
      const base = await prepareHeadlessConnection({ protocol: { family, version: 'v1' }, minCliVersion: f.definition.minCliVersion,
        executable, ownedConfigDir: f.definition.configDir, stateDir: f.stateDir, env: {}, now: Date.now, isolation: testIsolation });
      expect(base.executable).toBe(executable);
      expect((await f.read()).at(-1)).toMatchObject({ mode: 'auth', program: executable });
    }
  });

  it('runs the tool-less call via the same executable used for every isolated probe', async () => {
    const f = await fixture({ steps: codexAnswer('npm payload').map(line => ({ line })) });
    const protocol = { family, version: 'v1' };
    const profile = parseModelInvocationProfile({ ...f.profile, protocol, adapter: { ...f.profile.adapter, definition: f.definition } });
    const codexBinding = parseModelBindingDefinition({ ...binding, model: { ...binding.model, protocols: [{ ...protocol, capabilities: [] }] } });
    const port = createNativeCliHeadlessPort({ now: Date.now, isolation: testIsolation });
    await port.preflight(profile);
    await expect(port.send(await port.prepare(profile, codexBinding, request()))).resolves.toMatchObject({
      native: { choices: [{ message: { content: 'npm payload' } }] },
    });
    expect((await f.read()).map(row => [row.mode, row.program])).toEqual(['version', 'help', 'auth', 'call'].map(mode => [mode, f.payload]));
  });

  it('stops a replacement between resolution and the read-only bind before it can run', async () => {
    const f = await fixture(), replacement = await writeFakeCodexCli(dirname(f.payload), { logPath: f.logPath, version: 'codex-cli 99.0.0' });
    let calls = 0;
    const isolation: HeadlessIsolation = async () => {
      if (++calls === 2) await rename(replacement, f.payload);
      return testIsolation();
    };
    await expect(headlessPreflight(entry, f.definition, Date.now, isolation)).rejects.toMatchObject({
      code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'executable-changed' },
    });
    expect(await f.read()).toEqual([]);
  });

  it.each([
    ['conflicting platform package identity', async (f: Awaited<ReturnType<typeof fixture>>) =>
      writeFile(join(f.platformRoot, 'package.json'), JSON.stringify({ name: '@unrelated/codex', version: '0.169.0-linux-x64' }))],
    ['multiple names for the payload inode', async f => link(f.payload, `${f.payload}.alias`)],
    ['group-writable installation parent', async f => chmod(dirname(f.platformRoot), 0o775)],
    ['group-writable payload', async f => chmod(f.payload, 0o775)],
    ['redirected vendor directory', async f => {
      const vendor = join(f.platformRoot, 'vendor');
      await rename(vendor, `${vendor}.other`); await symlink(`${vendor}.other`, vendor);
    }],
    ['payload link outside its package', async f => {
      const outside = join(dirname(f.chosen), 'outside');
      await rename(f.payload, outside); await symlink(outside, f.payload);
    }],
  ] as const)('refuses %s before it runs', async (_label, change) => {
    const f = await fixture(); await change(f);
    await expect(headlessPreflight(entry, f.definition, Date.now, testIsolation)).rejects.toMatchObject({
      code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-payload-unverified' },
    });
    expect(await f.read()).toEqual([]);
  });

  it('names a missing payload and guides an unknown layout to an explicitly verified native file', async () => {
    const f = await fixture(), dir = join(dirname(f.chosen), 'other-layout'), executable = join(dir, 'codex.js');
    await unlink(f.payload);
    await expect(headlessPreflight(entry, f.definition, Date.now, testIsolation)).rejects.toMatchObject({
      code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-payload-missing' },
    });
    await mkdir(dir); await rename(f.launcher, executable);
    const refusal = await headlessPreflight(entry, { ...f.definition, executable }, Date.now, testIsolation).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-layout-unknown' }, message: expect.stringContaining('--executable') });
    expect(await f.read()).toEqual([]);
  });

  it.each([
    [{ versionExit: 204 }, { reason: 'exit', exitCode: '204' }, 'version command exited with code 204', 'sürüm komutu 204 koduyla çıktı'],
    [{ version: 'raw-version-canary' }, { reason: 'unreadable' }, 'version line could not be read', 'sürüm satırı okunamadı'],
    [{ version: 'codex-cli 0.100.0' }, { reason: 'too-old', version: '0.100.0', minimum: '0.159.2' }, 'needs 0.159.2 or later. Update', '0.159.2 veya daha yeni bir sürüm gerektiriyor. CLI’ı güncelleyip'],
  ] as const)('diagnoses the version command for %j without a path or raw output in shared data', async (scenario, params, en, tr) => {
    const f = await fixture({ ...scenario, versionStderr: 'raw-stderr-canary account@example.invalid' });
    const error = await headlessPreflight(entry, f.definition, Date.now, testIsolation).catch((error: DeckentError) => error) as DeckentError;
    expect(error).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'version', ...params } });
    expect(error.localize?.('en').message).toContain(en);
    expect(error.localize?.('tr').message).toContain(tr);
    for (const locale of ['en', 'tr'] as const) {
      const local = ErrorRegistry.localHeadlessPathDetail(error, locale, dirname(f.chosen));
      expect(local).toContain('~/codex'); expect(local).toContain(f.payload);
    }
    let shared = '';
    await expect(reportFatal(error, { json: true, locale: 'en', stderr: { write: text => { shared += text; } } })).resolves.toBe(1);
    expect(JSON.parse(shared)).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'version', ...params } });
    const record = await readFile(join(f.stateDir, 'preflight.json'), 'utf8');
    expect(shared + record).not.toMatch(/\/tmp\/|raw-(version|stderr)-canary|account@example\.invalid|CODEX_HOME/u);
    expect(record).toContain('"check":"version"');
    if (params.reason !== 'too-old') { expect(shared).not.toContain('Update'); expect(shared).not.toContain('güncelleyip'); }
    expect(await f.read()).toMatchObject([{ mode: 'version', program: f.payload }]);
  });

  it('keeps a signal separate from a normal nonzero version exit', async () => {
    const f = await fixture({ versionSignal: 'SIGTERM' });
    await expect(headlessPreflight(entry, f.definition, Date.now, testIsolation)).rejects.toMatchObject({
      code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'signal' },
    });
  });

  it('keeps interactive sign-in on the selected launcher and checks status with the isolated native file', async () => {
    const f = await fixture(), marker = join(dirname(f.chosen), 'interactive-launcher');
    await writeFile(f.launcher, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`);
    await expect(runHeadlessLogin({ family, stateDir: f.stateDir, configDir: f.definition.configDir, owned: true, executable: f.chosen,
      sso: false, env: {}, now: Date.now, isolation: testIsolation })).resolves.toMatchObject({ signedIn: true, exit: 'completed' });
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual(entry.headless.login.args);
    expect(await f.read()).toMatchObject([{ mode: 'auth', program: f.payload }]);
  });
});

it('gives an old generic version refusal no specific reason or update advice', () => {
  for (const locale of ['en', 'tr'] as const) {
    const message = ErrorRegistry.get('HEADLESS_PREFLIGHT_FAILED', locale, { check: 'version' })!.message;
    expect(message).not.toMatch(/update|güncelle|exit|çıktı|okunamadı|unreadable/iu);
  }
});

it('bounds the local path, shortens home and masks control characters and secret-shaped values', () => {
  const error = ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED');
  const secret = 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  ErrorRegistry.retainHeadlessPaths(error, `/home/person/a\n\u202E/${secret}/${'z'.repeat(300)}`, '/home/person/checked');
  const detail = ErrorRegistry.localHeadlessPathDetail(error, 'en', '/home/person')!;
  expect(detail).toContain('~/a');
  expect(detail).toContain('…');
  expect(detail).toContain('Checked file: ~/checked');
  expect(detail).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  expect(detail).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain('/home/person');
});
