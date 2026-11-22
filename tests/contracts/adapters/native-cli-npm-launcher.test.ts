import { fstatSync } from 'node:fs';
import { chmod, link, lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeCliHeadlessPort, headlessPreflight, nativeCliHeadless, prepareHeadlessConnection, readHeadlessLogins, readHeadlessSealedVersion, resolveHeadlessExecutable, runHeadlessIsolated, runHeadlessLogin,
  type HeadlessIsolation } from '#adapters/core/native-cli-headless/index.js';
import * as processRunner from '#adapters/core/process-runner/index.js';
import { ErrorRegistry, reportFatal, type DeckentError } from '#platform/index.js';
import { parseModelBindingDefinition, parseModelInvocationProfile } from '#domain/index.js';
import { CODEX_FAMILY, codexAnswer, codexHelp, fakeCodexNpm, writeFakeCodexCli, type FakeCodexScenario } from '../../fixtures/native-headless/codex.js';
import { binding, cleanupConnections, connection, request, testIsolation } from '../../fixtures/native-headless/connection.js';
import { FAMILY } from '../../fixtures/native-headless/stream.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof files>() }));

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

async function fixtureIsolation(beforeSeal?: (seal: number) => Promise<void>): Promise<HeadlessIsolation> {
  const launcher = await lstat(process.execPath, { bigint: true });
  let seals = 0;
  return async () => {
    await beforeSeal?.(++seals);
    return { status: 'available', rejected: [], restriction: null, detail: null,
      launcher: { source: 'system', path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
        identity: [launcher.dev, launcher.ino, launcher.size, launcher.mtimeNs, launcher.ctimeNs].join(':') } };
  };
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

  it('connects explicitly selected standalone executables named tool.js with and without a launcher registry row', async () => {
    const c = await connection(), configDir = c.configDir, stateDir = join(c.root, 'state');
    const codex = join(c.root, 'tool.js'), claude = join(dirname(c.executable), 'tool.js');
    await rename(await writeFakeCodexCli(dirname(codex), { logPath: join(configDir, 'config.toml') }), codex);
    await rename(c.executable, claude);
    expect(nativeCliHeadless(FAMILY)?.command.npmLauncher).toBeUndefined();
    for (const [protocolFamily, executable] of [[family, codex], [FAMILY, claude]] as const) {
      await expect(prepareHeadlessConnection({ protocol: { family: protocolFamily, version: 'v1' }, minCliVersion: '9.0.0',
        executable, ownedConfigDir: configDir, stateDir, env: {}, now: Date.now, isolation: testIsolation }))
        .resolves.toMatchObject({ executable });
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
    const f = await fixture(), dir = join(f.root, 'node_modules', 'other-layout'), executable = join(dir, 'tool');
    await unlink(f.payload);
    await expect(headlessPreflight(entry, f.definition, Date.now, testIsolation)).rejects.toMatchObject({
      code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-payload-missing' },
    });
    await mkdir(dir); await rename(f.launcher, executable);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'other-layout', version: '1.0.0', bin: { tool: 'tool' } }));
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

it.skipIf(process.platform === 'win32')('guides an unknown launcher to a verified file when its valid manifest exceeds the read limit', async () => {
  const { root } = await connection(), dir = join(root, 'node_modules', 'other-layout'), executable = join(dir, 'tool');
  await mkdir(dir, { recursive: true });
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'other-layout', version: '1.0.0', bin: { tool: 'tool' },
    description: 'a'.repeat(entry.headless.limits.preflightOutputBytes) }));
  await expect(resolveHeadlessExecutable(entry, executable, process.getuid!())).rejects.toMatchObject({
    code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-layout-unknown' }, message: expect.stringContaining('--executable'),
  });
});

function elfHeader(kind = 2, machine = 62) {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  header.writeUInt16LE(kind, 16);
  header.writeUInt16LE(machine, 18);
  header.writeUInt32LE(1, 20);
  header.writeBigUInt64LE(0x401000n, 24);
  header.writeUInt16LE(64, 52);
  return header;
}

function dynamicElf(flags: bigint) {
  const header = elfHeader(3);
  header.writeBigUInt64LE(64n, 32);
  header.writeUInt16LE(56, 54);
  header.writeUInt16LE(1, 56);
  const program = Buffer.alloc(56), dynamic = Buffer.alloc(32);
  program.writeUInt32LE(2, 0); // PT_DYNAMIC
  program.writeBigUInt64LE(120n, 8);
  program.writeBigUInt64LE(32n, 32);
  dynamic.writeBigInt64LE(0x6ffffffbn, 0); // DT_FLAGS_1
  dynamic.writeBigUInt64LE(flags, 8);
  return Buffer.concat([header, program, dynamic]);
}

function elfProgram({ dynamicFlags, machine }: { dynamicFlags?: bigint; machine?: number } = {}) {
  const dynamicImage = dynamicFlags !== undefined;
  const header = elfHeader(dynamicImage ? 3 : 2, machine), load = Buffer.alloc(56);
  const dynamic = dynamicFlags === undefined ? Buffer.alloc(0) : dynamicElf(dynamicFlags).subarray(64);
  const code = Buffer.from([0xb8, 60, 0, 0, 0, 0x31, 0xff, 0x0f, 0x05]); // Linux x86-64 exit(0).
  const entryOffset = header.length + load.length + dynamic.length, size = BigInt(entryOffset + code.length);
  const base = dynamicImage ? 0n : 0x400000n;
  header.writeBigUInt64LE(base + BigInt(entryOffset), 24);
  header.writeBigUInt64LE(BigInt(header.length), 32);
  header.writeUInt16LE(load.length, 54);
  header.writeUInt16LE(dynamicImage ? 2 : 1, 56);
  load.writeUInt32LE(1, 0); // PT_LOAD, starting from the ELF header.
  load.writeUInt32LE(5, 4); // PF_R | PF_X
  load.writeBigUInt64LE(base, 16);
  load.writeBigUInt64LE(base, 24);
  load.writeBigUInt64LE(size, 32);
  load.writeBigUInt64LE(size, 40);
  load.writeBigUInt64LE(4096n, 48);
  if (dynamicImage) {
    const offset = BigInt(header.length + 2 * load.length);
    dynamic.writeBigUInt64LE(offset, 8);
    dynamic.writeBigUInt64LE(offset, 16);
    dynamic.writeBigUInt64LE(offset, 24);
    dynamic.writeBigUInt64LE(32n, 40);
    dynamic.writeBigUInt64LE(8n, 48);
  }
  return Buffer.concat([header, load, dynamic, code]);
}

describe.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('G3 package classification', () => {
  const manifest = { name: 'other-layout', version: '1.0.0' };
  const unknownLayout = {
    code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-layout-unknown' }, message: expect.stringContaining('--executable'),
  };
  const classify = (executable: string) => resolveHeadlessExecutable(entry, executable, process.getuid!());

  it('keeps the manifest reason and local entry when either recheck cannot verify the npm program', async () => {
    for (const stage of ['before-bind', 'after-auth-status'] as const) {
      const f = await fixture(), manifestPath = join(f.platformRoot, 'package.json');
      const isolation = await fixtureIsolation(async seal => {
        if (stage === 'before-bind' && seal === 2) await chmod(manifestPath, 0o664);
      });
      const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async command => {
        if (stage === 'before-bind') throw new Error('Unexpected spawn after a refused bind');
        const auth = command.args.at(-1) === 'status';
        if (auth) await chmod(manifestPath, 0o664);
        const stdout = command.args.at(-1) === '--version' ? 'codex-cli 9.1.0' : codexHelp();
        return { schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 0, signal: null,
          stdoutBase64: Buffer.from(stdout).toString('base64'), stderrBase64: auth ? Buffer.from('Logged in using ChatGPT').toString('base64') : '',
          stdoutTruncated: false, stderrTruncated: false, durationMs: 0 };
      });
      try {
        const error = await headlessPreflight(entry, f.definition, Date.now, isolation).catch((failure: unknown) => failure) as DeckentError;
        const params = { check: 'npm-payload-unverified', reason: 'group-or-other-writable', recheck: 1 };
        expect.soft(error, stage).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params });
        expect.soft(error.localize?.('en').message).toContain('The program could not be checked again. The entry is writable by the group or by other users.');
        expect.soft(error.localize?.('tr').message).toContain('Program yeniden denetlenemedi. Bu dosya veya dizine grup veya diğer kullanıcılar yazabilir.');
        expect.soft(error.localize?.('en').message).not.toContain('changed');
        expect.soft(error.localize?.('tr').message).not.toContain('değişti');
        for (const locale of ['en', 'tr'] as const) {
          expect.soft(ErrorRegistry.localHeadlessPathDetail(error, locale, f.root)).toContain(`~/${relative(f.root, manifestPath)}`);
        }
        let shared = '';
        await expect(reportFatal(error, { json: true, locale: 'en', stderr: { write: text => { shared += text; } } })).resolves.toBe(1);
        expect.soft(JSON.parse(shared)).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params });
        expect.soft(shared + JSON.stringify(error)).not.toContain(f.root);
        expect(runner).toHaveBeenCalledTimes(stage === 'before-bind' ? 0 : 3);
      } finally { runner.mockRestore(); }
    }
  });

  it('reports an empty PATH search for a new connection in both languages without a local path', async () => {
    const f = await fixture(), bin = join(f.root, 'empty-bin');
    await mkdir(bin);
    const error = await prepareHeadlessConnection({ protocol: { family, version: 'v1' }, minCliVersion: f.definition.minCliVersion,
      ownedConfigDir: f.definition.configDir, stateDir: f.stateDir, env: { PATH: bin }, now: Date.now, isolation: await fixtureIsolation() })
      .catch((failure: unknown) => failure) as DeckentError;
    expect.soft(error).toMatchObject({ code: 'HEADLESS_CLI_UNAVAILABLE', params: { check: 'path-search-empty' } });
    for (const [locale, message] of [
      ['en', "The provider's program was not found on PATH. Install it or use --executable to choose a program file you have verified."],
      ['tr', 'Sağlayıcının programı PATH üzerinde bulunamadı. Programı kurun veya doğruladığınız bir program dosyasını --executable ile seçin.'],
    ] as const) {
      expect.soft(error.localize?.(locale).message).toBe(message);
      expect(ErrorRegistry.localHeadlessPathDetail(error, locale)).toBeUndefined();
    }
    let shared = '';
    await expect(reportFatal(error, { json: true, locale: 'en', stderr: { write: text => { shared += text; } } })).resolves.toBe(1);
    expect(shared + JSON.stringify(error)).not.toContain(bin);
    expect(await f.read()).toEqual([]);
  });

  it('reports a PATH search cut between directories without claiming the program was absent', async () => {
    const f = await fixture(), bin = join(f.root, 'empty-bin'), controller = new AbortController();
    const first = join(bin, entry.command.executable), second = join(dirname(f.chosen), entry.command.executable);
    await mkdir(bin);
    const stat = files.stat;
    const lookup = vi.spyOn(files, 'stat').mockImplementation(async (...args: Parameters<typeof stat>) => {
      if (args[0] === first) controller.abort();
      return stat(...args);
    });
    try {
      const error = await prepareHeadlessConnection({ protocol: { family, version: 'v1' }, minCliVersion: f.definition.minCliVersion,
        ownedConfigDir: f.definition.configDir, stateDir: f.stateDir, env: { PATH: [bin, dirname(f.chosen)].join(delimiter) },
        now: Date.now, isolation: await fixtureIsolation(), signal: controller.signal }).catch((failure: unknown) => failure) as DeckentError;
      expect.soft(error.params).toEqual({ check: 'path-search-incomplete' });
      expect.soft(error.localize?.('en').message).toBe("The PATH search for the provider's program could not be completed.");
      expect.soft(error.localize?.('tr').message).toBe('Sağlayıcının programı için PATH araması tamamlanamadı.');
      expect.soft(ErrorRegistry.localHeadlessPathDetail(error, 'en')).toBeUndefined();
      expect.soft(JSON.stringify(error)).not.toContain(bin);
      expect(lookup.mock.calls.some(([path]) => path === first)).toBe(true);
      expect(lookup.mock.calls.some(([path]) => path === second)).toBe(false);
    } finally { lookup.mockRestore(); }
  });

  it.each([
    ["bwrap: Can't find source path /proc/self/fd/3: No such file or directory", 'executable-bind-unverified',
      'The verified CLI could not be bound into the isolated process.', 'Doğrulanan CLI yalıtılmış sürece bağlanamadı.'],
    ['bwrap: Race condition binding dirfd', 'executable-changed',
      'The verified CLI changed before it could start.', 'Doğrulanan CLI başlatılmadan önce değişti.'],
  ])('reports the bind result %s using its own evidence', async (stderr, check, en, tr) => {
    const f = await fixture();
    const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async command => ({
      schemaVersion: 1, requestId: command.requestId, started: true, reason: 'exit', exitCode: 1, signal: null,
      stdoutBase64: '', stderrBase64: Buffer.from(stderr).toString('base64'), stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
    }));
    try {
      const error = await headlessPreflight(entry, f.definition, Date.now, await fixtureIsolation()).catch((failure: unknown) => failure) as DeckentError;
      expect.soft(error).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check } });
      expect.soft(error.localize?.('en').message).toContain(en);
      expect.soft(error.localize?.('tr').message).toContain(tr);
      expect.soft(ErrorRegistry.localHeadlessPathDetail(error, 'en', f.root)).toContain(relative(f.root, f.payload));
      expect(JSON.stringify(error)).not.toContain(f.root);
    } finally { runner.mockRestore(); }
  });

  it.each([
    [true, { check: 'executable-changed' }],
    [false, { check: 'executable-recheck', reason: 'verification-unavailable' }],
  ])('uses the available identity comparison on fd stat failure (difference: %s)', async (differs, params) => {
    const f = await fixture(), open = files.open, lstatFixture = files.lstat;
    let pinned = false;
    const pin = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (args[0] === f.payload) {
        pinned = true;
        vi.spyOn(file, 'stat').mockRejectedValueOnce(Object.assign(new Error('fixture fd stat failure'), { code: 'EIO' }));
      }
      return file;
    });
    const identity = vi.spyOn(files, 'lstat').mockImplementation(async (...args: Parameters<typeof lstatFixture>) => {
      const info = await lstatFixture(...args);
      if (args[0] === f.payload && pinned && differs) Object.assign(info, { ino: BigInt(info.ino) + 1n });
      return info;
    });
    const runner = vi.spyOn(processRunner, 'runNodeProcess');
    try {
      await expect(headlessPreflight(entry, f.definition, Date.now, await fixtureIsolation())).rejects.toMatchObject({
        code: 'HEADLESS_PREFLIGHT_FAILED', params,
      });
      expect(pinned).toBe(true);
      expect(runner).not.toHaveBeenCalled();
    } finally { pin.mockRestore(); identity.mockRestore(); runner.mockRestore(); }
  });

  it('distinguishes an unsuccessful read of the recorded launcher from its removal', async () => {
    const f = await fixture(), realpath = files.realpath;
    const lookup = vi.spyOn(files, 'realpath').mockImplementation(async (...args: Parameters<typeof realpath>) => {
      if (args[0] === f.chosen) throw Object.assign(new Error('fixture lookup failure'), { code: 'EIO' });
      return realpath(...args);
    });
    try {
      const error = await classify(f.chosen).catch((failure: unknown) => failure) as DeckentError;
      expect.soft(error.params).toEqual({ check: 'recorded-path-unverified' });
      expect.soft(error.localize?.('en').message).toBe('The subscription CLI could not be verified at its recorded path.');
      expect.soft(error.localize?.('tr').message).toBe('Abonelik CLI’ı kayıtlı yolunda doğrulanamadı.');
      expect(JSON.stringify(error)).not.toContain(f.root);
    } finally { lookup.mockRestore(); }
  });

  it('uses the selection diagnosis for an empty explicit path', async () => {
    const f = await fixture();
    await expect(prepareHeadlessConnection({ protocol: { family, version: 'v1' }, minCliVersion: f.definition.minCliVersion,
      executable: '', ownedConfigDir: f.definition.configDir, stateDir: f.stateDir, env: {}, now: Date.now, isolation: await fixtureIsolation() }))
      .rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'selected-file', reason: 'unavailable' } });
  });

  it('distinguishes a PATH candidate that could not be resolved from a user selection', async () => {
    const f = await fixture(), realpath = files.realpath;
    const lookup = vi.spyOn(files, 'realpath').mockImplementation(async (...args: Parameters<typeof realpath>) => {
      if (args[0] === f.chosen) throw Object.assign(new Error('fixture lookup failure'), { code: 'EIO' });
      return realpath(...args);
    });
    try {
      const error = await prepareHeadlessConnection({ protocol: { family, version: 'v1' }, minCliVersion: f.definition.minCliVersion,
        ownedConfigDir: f.definition.configDir, stateDir: f.stateDir, env: { PATH: dirname(f.chosen) }, now: Date.now, isolation: await fixtureIsolation() })
        .catch((failure: unknown) => failure) as DeckentError;
      expect.soft(error.params).toEqual({ check: 'path-candidate-unverified' });
      expect.soft(ErrorRegistry.localHeadlessPathDetail(error, 'en', dirname(f.chosen))).toContain('~/codex');
      expect(JSON.stringify(error)).not.toContain(f.root);
    } finally { lookup.mockRestore(); }
  });

  it('describes an observed zero link count without claiming a comparison', async () => {
    const f = await fixture(), lstatFixture = files.lstat;
    const links = vi.spyOn(files, 'lstat').mockImplementation(async (...args: Parameters<typeof lstatFixture>) => {
      const info = await lstatFixture(...args);
      if (args[0] === f.payload) Object.assign(info, { nlink: 0n });
      return info;
    });
    try {
      await expect(classify(f.chosen)).rejects.toMatchObject({ params: { check: 'npm-payload-unverified', reason: 'no-hard-links' } });
    } finally { links.mockRestore(); }
  });

  it('reports a manifest parse failure separately from a registered-field mismatch', async () => {
    const f = await fixture(), path = join(f.platformRoot, 'package.json');
    await writeFile(path, '{');
    await expect(classify(f.chosen)).rejects.toMatchObject({ params: { check: 'npm-payload-unverified', reason: 'manifest-invalid' } });
  });

  it('reports an incomplete manifest content read after a successful open', async () => {
    const f = await fixture(), path = join(f.platformRoot, 'package.json'), open = files.open;
    const opened = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (args[0] === path) vi.spyOn(file, 'read').mockRejectedValueOnce(Object.assign(new Error('fixture read failure'), { code: 'EIO' }));
      return file;
    });
    try {
      await expect(classify(f.chosen)).rejects.toMatchObject({ params: { check: 'npm-payload-unverified', reason: 'manifest-unreadable' } });
    } finally { opened.mockRestore(); }
  });

  it('reports when manifest and native checks gave no proof for a package selection', async () => {
    const f = await fixture(), executable = join(f.root, 'other-tool');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await unlink(join(f.root, 'package.json'));
    const error = await classify(executable).catch((failure: unknown) => failure) as DeckentError;
    expect.soft(error.params).toEqual({ check: 'npm-layout-unknown', reason: 'manifest-exclusion-unverified', native: 'native-read-incomplete' });
    expect.soft(error.localize?.('en').message).toContain('The package launcher declarations could not be fully checked.');
    expect.soft(error.localize?.('tr').message).toContain('Paketin başlatıcı bildirimleri tam olarak denetlenemedi.');
    expect(JSON.stringify(error)).not.toContain(f.root);
  });

  it('preserves a manifest identity difference when native proof also fails', async () => {
    const f = await fixture(), executable = join(f.root, 'other-tool'), manifestPath = join(f.root, 'package.json'), lstatFixture = files.lstat;
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const lookup = vi.spyOn(files, 'lstat').mockImplementation(async (...args: Parameters<typeof lstatFixture>) => {
      const info = await lstatFixture(...args);
      if (String(args[0]).startsWith('/proc/self/fd/') && String(args[0]).endsWith('/package.json')) Object.assign(info, { ino: BigInt(info.ino) + 1n });
      return info;
    });
    try {
      const error = await classify(executable).catch((failure: unknown) => failure) as DeckentError;
      expect.soft(error.params).toEqual({ check: 'npm-layout-unknown', reason: 'manifest-exclusion-changed', native: 'native-read-incomplete' });
      expect.soft(JSON.stringify(error)).not.toContain(manifestPath);
    } finally { lookup.mockRestore(); }
  });

  it('preserves a native file identity difference observed after manifest exclusion failed', async () => {
    const f = await fixture(), executable = join(f.root, 'other-tool'), open = files.open;
    await writeFile(executable, elfProgram(), { mode: 0o700 });
    await unlink(join(f.root, 'package.json'));
    const opened = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (args[0] === executable) {
        const stat = file.stat.bind(file);
        vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
          const info = await stat({ bigint: true });
          return Object.assign(info, { ino: info.ino + 1n });
        });
      }
      return file;
    });
    try {
      await expect(classify(executable)).rejects.toMatchObject({
        params: { check: 'npm-layout-unknown', reason: 'manifest-exclusion-unverified', native: 'native-file-changed' },
      });
    } finally { opened.mockRestore(); }
  });

  it('identifies a bind target mismatch as a difference between paths', async () => {
    const f = await fixture(), program = await classify(f.chosen);
    await expect(runHeadlessIsolated(entry, await fixtureIsolation(), { executable: f.chosen, program, args: [], env: {}, stateDir: f.stateDir,
      runDir: join(f.stateDir, 'run'), configDir: f.definition.configDir, now: Date.now }, { timeoutMs: 100, outputBytes: 512 }))
      .rejects.toMatchObject({ params: { check: 'executable-bind-target-mismatch' } });
  });

  it('describes a realm directory that overlaps the selected npm package', async () => {
    const f = await fixture(), program = await classify(f.chosen);
    await expect(runHeadlessIsolated(entry, await fixtureIsolation(), { executable: f.payload, program, args: [], env: {}, stateDir: f.stateDir,
      runDir: f.root, configDir: f.definition.configDir, now: Date.now }, { timeoutMs: 100, outputBytes: 512 }))
      .rejects.toMatchObject({ params: { check: 'npm-package-directory-overlap' } });
  });

  it('describes an isolation support executable that overlaps the selected npm package', async () => {
    const f = await fixture(), isolation = entry.headless.isolation;
    const localEntry = { ...entry, headless: { ...entry.headless, isolation: { ...isolation, limits: { ...isolation.limits, limiter: f.payload } } } };
    await expect(headlessPreflight(localEntry, f.definition, Date.now, await fixtureIsolation()))
      .rejects.toMatchObject({ params: { check: 'npm-package-runtime-overlap' } });
  });

  it('describes launch arguments that could not be prepared', async () => {
    const f = await fixture(), isolation = entry.headless.isolation;
    const localEntry = { ...entry, headless: { ...entry.headless, isolation: { ...isolation, limits: { ...isolation.limits, openFiles: 0 } } } };
    await expect(headlessPreflight(localEntry, f.definition, Date.now, await fixtureIsolation()))
      .rejects.toMatchObject({ params: { check: 'realm-command-unverified' } });
  });

  it('distinguishes a missing config directory from one reported by the CLI', async () => {
    const f = await fixture();
    const error = await headlessPreflight(entry, { ...f.definition, configDir: join(f.root, 'absent') }, Date.now, await fixtureIsolation())
      .catch((failure: unknown) => failure) as DeckentError;
    expect.soft(error.params).toEqual({ check: 'config-dir', reason: 'missing' });
    expect.soft(error.localize?.('en').message).toContain('The login directory was not found.');
    expect(JSON.stringify(error)).not.toContain(f.root);
  });

  it('reports a probe output limit without implying a timeout or launch failure', async () => {
    const f = await fixture();
    const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async command => ({
      schemaVersion: 1, requestId: command.requestId, started: true, reason: 'output-limit', exitCode: null, signal: null,
      stdoutBase64: '', stderrBase64: '', stdoutTruncated: true, stderrTruncated: false, durationMs: 0,
    }));
    try {
      const error = await headlessPreflight(entry, f.definition, Date.now, await fixtureIsolation()).catch((failure: unknown) => failure) as DeckentError;
      expect.soft(error.params).toEqual({ check: 'spawn', reason: 'output-limit' });
      expect.soft(error.localize?.('en').message).toBe('The subscription CLI exceeded the check output limit. The channel stays closed.');
      expect(error.localize?.('tr').message).toBe('Abonelik CLI’ı denetim çıktı sınırını aştı. Kanal kapalı kalıyor.');
    } finally { runner.mockRestore(); }
  });

  it('reports the first npm check locally and carries only its reason in the shared refusal', async () => {
    const { root: home } = await connection(), prefix = join(home, 'npm');
    const f = await fakeCodexNpm(prefix, { logPath: join(home, 'unused.log') });
    const manifestPath = join(f.platformRoot, 'package.json'), manifestBytes = await readFile(manifestPath);
    const expectedPath = `~/${relative(home, f.payload)}`;
    const refused = async (path: string, reason: string, expected = true) => {
      const error = await classify(f.chosen).catch((failure: unknown) => failure) as DeckentError;
      const params = { check: reason === 'missing' ? 'npm-payload-missing' : 'npm-payload-unverified', reason };
      expect.soft(error).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params });
      expect.soft(error.params).toEqual(params);
      expect.soft(JSON.stringify(error)).not.toContain(home);
      let shared = '';
      await expect(reportFatal(error, { json: true, locale: 'en', stderr: { write: text => { shared += text; } } })).resolves.toBe(1);
      expect.soft(JSON.parse(shared)).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params });
      expect.soft(shared).not.toContain(home);
      const local = ErrorRegistry.localHeadlessPathDetail(error, 'en', home);
      expect.soft(local).toContain(`Failed check at: ${path === home ? '~' : `~/${relative(home, path)}`}`);
      if (expected) expect.soft(local).toContain(`Expected native program location (unverified): ${expectedPath}`);
      else expect.soft(local).not.toContain('Expected native program location');
      return error;
    };

    await chmod(manifestPath, 0o664);
    await chmod(home, 0o775);
    await refused(home, 'group-or-other-writable', false);
    await chmod(home, 0o700);
    const writable = await refused(manifestPath, 'group-or-other-writable');
    expect.soft(writable.localize?.('en').message).toContain('writable by the group or by other users');
    expect.soft(writable.localize?.('tr').message).toContain('grup veya diğer kullanıcılar yazabilir');
    await chmod(manifestPath, 0o644);

    await writeFile(manifestPath, JSON.stringify({ name: 'different', version: '0.169.0-linux-x64' }));
    await link(f.payload, `${f.payload}.alias`);
    await refused(manifestPath, 'manifest-mismatch');
    await writeFile(manifestPath, manifestBytes);
    await refused(f.payload, 'multiple-hard-links');
    await unlink(`${f.payload}.alias`);
    await unlink(f.payload);
    await refused(f.payload, 'missing');
    const otherLink = join(prefix, 'bin', 'different');
    await symlink(f.launcher, otherLink);
    const unknown = await classify(otherLink).catch((error: unknown) => error);
    expect(unknown).toMatchObject(unknownLayout);
    expect(ErrorRegistry.localHeadlessPathDetail(unknown, 'en', home)).not.toContain(expectedPath);
  });

  it.skipIf(process.getuid?.() === 0)('reports the first directory whose owner is outside the trusted set', async () => {
    const f = await fixture(), prefix = dirname(dirname(f.chosen));
    const wrongOwnerUid = process.getuid!() + 1;
    const error = await resolveHeadlessExecutable(entry, f.chosen, wrongOwnerUid).catch((failure: unknown) => failure);
    expect.soft(error).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-payload-unverified', reason: 'untrusted-owner' } });
    expect.soft(ErrorRegistry.localHeadlessPathDetail(error, 'en', prefix)).toContain('Failed check at: ~/lib/node_modules/@openai/codex');
    expect.soft(ErrorRegistry.localHeadlessPathDetail(error, 'en', prefix)).not.toContain('Expected native program location');
  });

  async function packageProgram(content: unknown, bytes: string | Buffer = '#!/bin/sh\nexit 0\n', mode = 0o700) {
    const connectionFixture = await fixture();
    const packageRoot = join(dirname(connectionFixture.stateDir), 'node_modules', '@example', 'other-layout'), executable = join(packageRoot, 'tool');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(executable, bytes, { mode });
    if (content !== undefined) await writeFile(join(packageRoot, 'package.json'), JSON.stringify(content));
    return { ...connectionFixture, packageRoot, executable };
  }

  const nestedTarget = 'node_modules/inner/tool';
  async function nestedProgram(outerManifest: unknown, bytes?: Buffer) {
    const f = await packageProgram(outerManifest, bytes), executable = join(f.packageRoot, nestedTarget);
    await mkdir(dirname(executable), { recursive: true });
    await rename(f.executable, executable);
    await writeFile(join(dirname(executable), 'package.json'), JSON.stringify({ name: 'inner', version: '1.0.0' }));
    return { ...f, executable };
  }

  async function expectPreflightBind(f: Awaited<ReturnType<typeof fixture>>, executable: string, packageRoot?: string, replace?: () => Promise<void>) {
    const expected = await lstat(executable, { bigint: true });
    const isolation = await fixtureIsolation(async seal => { if (seal === 2) await replace?.(); });
    const stopped = new Error('version probe captured before spawn');
    const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async (command, _signal, _onLine, fd) => {
      expect(fd).toBeDefined();
      expect(fstatSync(fd!, { bigint: true })).toMatchObject({ dev: expected.dev, ino: expected.ino, ctimeNs: expected.ctimeNs });
      const args = command.args;
      expect(args.at(-2)).toBe(executable);
      const binds = args.flatMap((arg, i) => arg === '--ro-bind-fd' ? [args.slice(i, i + 3)] : []);
      expect(binds).toEqual([['--ro-bind-fd', '3', executable]]);
      if (packageRoot) {
        const mask = args.indexOf(packageRoot), bind = args.indexOf('--ro-bind-fd'), remount = args.lastIndexOf(packageRoot);
        expect(args.slice(mask - 5, mask + 1)).toEqual(['--perms', '0755', '--size', String(entry.headless.isolation.limits.tmpfsBytes), '--tmpfs', packageRoot]);
        expect(mask).toBeLessThan(bind);
        expect(remount).toBeGreaterThan(bind);
        expect(args[remount - 1]).toBe('--remount-ro');
        const hostBinds = args.flatMap((arg, i) => ['--bind', '--ro-bind', '--ro-bind-try'].includes(arg) ? args.slice(i + 1, i + 3) : []);
        expect(hostBinds.filter(path => path === packageRoot || path.startsWith(packageRoot + sep))).toEqual([]);
      }
      throw stopped;
    });
    try {
      const preflight = headlessPreflight(entry, { ...f.definition, executable }, Date.now, isolation);
      if (replace) {
        const error = await preflight.catch((failure: unknown) => failure) as DeckentError;
        expect(error).toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'executable-changed' } });
        expect(error.localize?.('en').message).toContain('The verified CLI changed before it could start.');
        expect(error.localize?.('tr').message).toContain('Doğrulanan CLI başlatılmadan önce değişti.');
        expect(runner).not.toHaveBeenCalled();
      } else {
        await expect(preflight).rejects.toBe(stopped);
        expect(runner).toHaveBeenCalledOnce();
      }
    } finally { runner.mockRestore(); }
  }

  it.each([
    [1, 'registry match takes priority and keeps the payload-specific refusal', async () => {
      const f = await fixture();
      await expect(classify(f.chosen)).resolves.toMatchObject({ executable: f.payload, packageRoot: f.root });
      await writeFile(f.launcher, elfHeader());
      await unlink(f.payload);
      await expect(classify(f.chosen)).rejects.toMatchObject({ code: 'HEADLESS_PREFLIGHT_FAILED', params: { check: 'npm-payload-missing' } });
    }],
    [2, 'explicit native vendor program uses its own loadable ELF even without a manifest', async () => {
      const f = await fixture();
      await writeFile(f.payload, elfProgram());
      await unlink(join(f.platformRoot, 'package.json'));
      await expect(classify(f.payload)).resolves.toMatchObject({ executable: f.payload });
      await expectPreflightBind(f, f.payload, f.root);
      const replacement = `${f.payload}.replacement`;
      await writeFile(replacement, elfProgram(), { mode: 0o700 });
      await expectPreflightBind(f, f.payload, f.root, () => rename(replacement, f.payload));
    }],
    [3, 'unsupported package script is recognized by identity', async () => {
      const { executable, packageRoot } = await packageProgram({ ...manifest, bin: { tool: './tool' } });
      await expect(classify(executable)).rejects.toMatchObject(unknownLayout);
      await link(executable, join(packageRoot, 'alias'));
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ ...manifest, bin: 'alias' }));
      await expect(classify(executable)).rejects.toMatchObject(unknownLayout);
      const nested = await nestedProgram({ ...manifest, bin: nestedTarget });
      await expect(classify(nested.executable)).rejects.toMatchObject(unknownLayout);
    }],
    [4, 'package command without a supported loadable ELF keeps the guidance', async () => {
      for (const bytes of [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), elfHeader().subarray(0, 60),
        elfProgram({ machine: 183 }), elfProgram({ dynamicFlags: 1n })]) {
        const { executable } = await packageProgram({ ...manifest, bin: 'tool' }, bytes);
        await expect(classify(executable)).rejects.toMatchObject(unknownLayout);
      }
      if (process.getuid!() !== 0) {
        const { executable } = await packageProgram({ ...manifest, bin: 'tool' }, elfProgram(), 0o100);
        await expect(readFile(executable)).rejects.toMatchObject({ code: 'EACCES' });
        await expect(classify(executable)).rejects.toMatchObject(unknownLayout);
      }
      const truncatedSegment = elfProgram().subarray(0, -1);
      for (const bytes of [elfHeader(), dynamicElf(0x08000000n), truncatedSegment, elfProgram().subarray(0, 119)]) {
        const { executable } = await packageProgram({ ...manifest, bin: 'tool' }, bytes);
        await expect.soft(classify(executable)).rejects.toMatchObject(unknownLayout);
      }
    }],
    [5, 'execute-only program outside a package still reaches isolated preflight', async () => {
      const f = await fixture(), { executable } = await connection();
      await writeFile(executable, elfHeader());
      await chmod(executable, 0o100);
      if (process.getuid!() !== 0) await expect(readFile(executable)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(classify(executable)).resolves.toMatchObject({ executable });
      await expectPreflightBind(f, executable);
    }],
    [6, 'an offered package command can also be the explicit native PIE', async () => {
      const pie = elfProgram({ dynamicFlags: 0x08000000n });
      const f = await packageProgram({ ...manifest, bin: { tool: 'tool' } }, pie);
      await expect(classify(f.executable)).resolves.toMatchObject({ executable: f.executable });
      await expectPreflightBind(f, f.executable, f.packageRoot);
      const nested = await nestedProgram(undefined, pie);
      await expect(classify(nested.executable)).resolves.toMatchObject({ executable: nested.executable, packageRoot: nested.packageRoot });
    }],
    [7, 'standalone script outside a package keeps its isolated preflight', async () => {
      const f = await fixture(), { root, executable } = await connection();
      await expectPreflightBind(f, executable);
      const cache = join(root, 'node_modules', '.cache'), cached = join(cache, 'tool');
      await mkdir(cache, { recursive: true });
      await rename(executable, cached);
      await expectPreflightBind(f, cached);
    }],
    [8, 'a different existing command inode proves a package file is standalone', async () => {
      const f = await packageProgram({ ...manifest, bin: { other: './nested/other' } });
      await mkdir(join(f.packageRoot, 'nested'));
      await writeFile(join(f.packageRoot, 'nested', 'other'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      if (process.getuid!() !== 0) {
        await chmod(f.executable, 0o100);
        await expect(readFile(f.executable)).rejects.toMatchObject({ code: 'EACCES' });
      }
      await expect(classify(f.executable)).resolves.toMatchObject({ executable: f.executable });
      await expectPreflightBind(f, f.executable, f.packageRoot);
      const nested = await nestedProgram(manifest);
      await expect(classify(nested.executable)).resolves.toMatchObject({ executable: nested.executable, packageRoot: nested.packageRoot });
      await expectPreflightBind(nested, nested.executable, nested.packageRoot);
    }],
    [9, 'missing or unsupported package declarations leave the outcome undetermined', async () => {
      for (const content of [undefined, null, [], { ...manifest, bin: true }, { ...manifest, bin: { tool: 42 } },
        { ...manifest, directories: { bin: 'bin' } }, { ...manifest, bin: 'missing' }]) {
        const { executable } = await packageProgram(content);
        await expect(classify(executable)).rejects.toMatchObject(unknownLayout);
      }
      const { executable, packageRoot } = await packageProgram(undefined);
      const manifestPath = join(packageRoot, 'package.json'), outside = join(dirname(packageRoot), 'outside');
      await writeFile(outside, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      await link(outside, join(packageRoot, 'other'));
      await symlink(executable, join(packageRoot, 'alias'));
      await symlink(dirname(packageRoot), join(packageRoot, 'redirected'));
      const deepTarget = Array.from({ length: 32 }, () => 'd').join('/') + '/other';
      await mkdir(dirname(join(packageRoot, deepTarget)), { recursive: true });
      await link(outside, join(packageRoot, deepTarget));
      const overBudget = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`command-${index}`, 'other']));
      for (const bin of [executable, '../outside', 'alias', 'redirected/outside', ['other'], deepTarget, overBudget]) {
        await writeFile(manifestPath, JSON.stringify({ ...manifest, bin }));
        await expect(classify(executable)).rejects.toMatchObject(unknownLayout);
      }
      const nested = await nestedProgram(undefined);
      await expect.soft(classify(nested.executable)).rejects.toMatchObject(unknownLayout);
      const inner = dirname(nested.executable);
      await writeFile(join(inner, 'other'), '#!/bin/sh\nexit 0\n');
      await writeFile(join(inner, 'package.json'), JSON.stringify({ name: 'inner', version: '1.0.0', bin: 'other' }));
      for (const count of [63, 64]) {
        const bin = Object.fromEntries(Array.from({ length: count }, (_, index) => [`command-${index}`, 'node_modules/inner/other']));
        await writeFile(join(nested.packageRoot, 'package.json'), JSON.stringify({ ...manifest, bin }));
        if (count === 63) await expect(classify(nested.executable)).resolves.toMatchObject({ executable: nested.executable });
        else await expect.soft(classify(nested.executable)).rejects.toMatchObject(unknownLayout);
      }
      await writeFile(join(nested.packageRoot, 'package.json'), JSON.stringify(manifest));
      let dir = inner, selected = nested.executable;
      for (let depth = 3; depth <= 33; depth++) {
        dir = join(dir, 'node_modules', 'deep');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'deep', version: '1.0.0' }));
        if (depth < 32) continue;
        const next = join(dir, 'tool');
        await rename(selected, next);
        selected = next;
        if (depth === 32) await expect(classify(selected)).resolves.toMatchObject({ executable: selected });
        else await expect.soft(classify(selected)).rejects.toMatchObject(unknownLayout);
      }
    }],
  ] as const)('row %i — %s', async (_row, _risk, verify) => { await verify(); });
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
