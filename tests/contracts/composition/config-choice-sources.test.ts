import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredConfigChoiceSources } from '#composition/core/config/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { CONFIG_DISCOVERY_BOUNDS, discoverConfigExecutables, discoverConfigBranches, discoverConfigImages, discoverConfigFiles, discoverConfigPools } from '#adapters/index.js';
import { clearConfigCache, getConfigFieldDefault, prepareProductDirectory, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { DatabaseSync } from 'node:sqlite';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('CS-1 production choice discovery', () => {
  it.skipIf(process.platform === 'win32')('[unsupported on Windows: installation policy template needs POSIX layout and OS-user identity] observes principal scopes, the policy company, identity profiles, layout key files and environment names without reading values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cs1-sources-')); roots.push(root);
    await applyPolicyTemplateInstallation(root, 'installation');
    const options = { env: { ...process.env, DECKENT_GLOBAL_HOME: join(root, 'global'), CS1_TEST_ENV: 'never-show-this-value' } };
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ schema_version: 4, terminal: { scopeId: 'installation' } })); clearConfigCache();
    const layout = resolveProductLayout({ projectRoot: root });
    const approvals = await prepareProductDirectory(layout, 'approvals');
    await writeFile(join(approvals, 'authority.key'), 'secret key content', { mode: 0o600 });
    await writeFile(join(approvals, 'prefix-cache-salt.key'), 'not an approval key', { mode: 0o600 });
    const source = configuredConfigChoiceSources(root, options);
    expect((await source.list('scopes', 'terminal.scopeId')).map(choice => choice.value)).toContain('installation');
    const company = await source.list('companies', 'company.id'); expect(company).toHaveLength(1);
    const profiles = await source.list('identity-profiles', 'identity.profile'); expect(profiles.length).toBeGreaterThan(0); expect(profiles[0]?.value).toHaveProperty('version');
    expect((await source.list('key-files', 'approvals.keyFile')).map(choice => choice.value)).toEqual(['authority.key']);
    const names = await source.list('environment', 'terminal.shell.environment'); expect(names.map(choice => choice.value)).toContain('CS1_TEST_ENV');
    expect(JSON.stringify(names)).not.toContain('never-show-this-value'); expect(JSON.stringify(await source.list('key-files', 'approvals.keyFile'))).not.toContain('secret key content');
    expect((await source.list('paths', 'layout.root')).some(choice => choice.value === root)).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('[unsupported on Windows: policy file guards need POSIX ownership] J2c/J2d: a folder with no installation refuses the scope list with the typed setup answer (`deckent init`, no raw file error) and writes nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cs1-empty-')), home = await mkdtemp(join(tmpdir(), 'cs1-empty-home-')); roots.push(root, home);
    const source = configuredConfigChoiceSources(root, { env: { ...process.env, DECKENT_GLOBAL_HOME: join(home, 'global') } });
    const refusal = await source.list('scopes', 'terminal.scopeId').then(() => null, (error: unknown) => error as { code?: string; message?: string });
    expect(refusal).toMatchObject({ code: 'CLI_INSTALLATION_MISSING' });
    expect(refusal?.message).toContain('`deckent init`');
    expect(refusal?.message).not.toMatch(/init policy|ENOENT/u);
    expect(await readdir(root)).toEqual([]);
  });
  it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] discovers executables and local branches and reads bounded pool records without a ledger writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cs1-git-')); roots.push(root);
    const limits = { timeoutMs: 5000, outputBytes: 65536, maxEntries: 16 }, git = (await discoverConfigExecutables('git', process.env, limits)).values[0]!;
    expect(git).toBeTruthy();
    await exec(git, ['init', '-b', 'main', root]);
    await exec(git, ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'fixture']);
    await exec(git, ['-C', root, 'branch', 'feature']);
    expect(await discoverConfigBranches(git, root, process.env, limits)).toEqual(['refs/heads/feature', 'refs/heads/main']);
    const layout = resolveProductLayout({ projectRoot: root }), path = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
    openSqliteLedger(path, getConfigFieldDefault('storage').sqlite).close();
    const db = new DatabaseSync(path); db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('known-pool', '{}'); db.close();
    expect(discoverConfigPools(path, 100, 1)).toEqual(['known-pool']);
    const files = join(root, 'files'); await mkdir(files); await writeFile(join(files, 'file.key'), 'secret');
    expect(await discoverConfigFiles(files, limits)).toEqual({ values: [join(files, 'file.key')], partial: false });
    await expect(discoverConfigBranches(git, root, process.env, { ...limits, outputBytes: 1 })).rejects.toThrow();
  });
});


it('local image choices reuse the existing endpoint/daemon/image probe and reject changed or unavailable images', async () => {
  const imageId = `sha256:${'a'.repeat(64)}`, rejected = `sha256:${'b'.repeat(64)}`, commands: readonly string[][] = [];
  const seen = commands as string[][];
  const images = await discoverConfigImages('/docker', { timeoutMs: 5000, outputBytes: 65536, maxEntries: 16 }, async command => {
    seen.push([...command.args]);
    const args = command.args.join(' ');
    const stdout = args.startsWith('image ls') ? `${imageId}\n${rejected}\n` : args.startsWith('context inspect') ? JSON.stringify({ Host: 'unix:///var/run/docker.sock' })
      : args.includes(' info ') ? 'daemon-one' : args.includes(rejected) ? imageId : imageId;
    return { stdout, stderr: '' };
  });
  expect(images).toEqual({ values: [imageId], partial: false });
  expect(seen.some(args => args.includes('--host') && args.includes('info'))).toBe(true);
  expect(seen.some(args => args.includes('inspect') && args.includes(rejected))).toBe(true);
});

// Astra 2456 N3: the PATH probe and the directory listing are bounded as a whole, not only by matches.
it('probes at most the bounded number of PATH directories and reads a bounded number of directory entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cs1-bounds-')); roots.push(root);
    const real = (await discoverConfigExecutables('git', process.env, { timeoutMs: 5000 })).values[0]!;
    const filler = Array.from({ length: CONFIG_DISCOVERY_BOUNDS.pathDirectories }, (_, index) => join(root, `empty-${index}`));
    const beyond = { ...process.env, PATH: [...filler, dirname(real)].join(delimiter) };
    expect(await discoverConfigExecutables('git', beyond, { timeoutMs: 5000 })).toEqual({ values: [], partial: 'size' }); // CONFIG-PARTIAL-CLI: a bound, said as one
    const within = { ...process.env, PATH: [...filler.slice(1), dirname(real)].join(delimiter) };
    expect(await discoverConfigExecutables('git', within, { timeoutMs: 5000 })).toEqual({ values: [real], partial: false });
    const many = join(root, 'many'); await mkdir(many);
    for (let index = 0; index < 40; index++) await mkdir(join(many, `dir-${index}`));
    expect(await discoverConfigFiles(many, { timeoutMs: 5000, outputBytes: 1, maxEntries: 1 })).toEqual({ values: [], partial: 'size' }); // scan bound: entries left unread
});

// CONFIG-PARTIAL-NOTICE: a discovery its time limit cut short says so; the values it offers do not change; a complete one is not partial.
it('flags the executable and file discoveries the time limit cut short, and the port carries the flag to the window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cs1-partial-')); roots.push(root);
  const files = join(root, 'files'); await mkdir(files);
  for (const name of ['a.key', 'b.key']) await writeFile(join(files, name), 'secret');
  vi.useFakeTimers({ toFake: ['Date'] }); // The listing's deadline is Date.now() + timeoutMs: a zero limit is spent after the first entry.
  const cut = await discoverConfigFiles(files, { timeoutMs: 0, outputBytes: 1, maxEntries: 16 });
  expect(cut.partial).toBe('time'); expect(cut.values).toHaveLength(1);
  vi.useRealTimers();
  expect((await discoverConfigFiles(files, { timeoutMs: 5000, outputBytes: 1, maxEntries: 16 })).partial).toBe(false);
  const source = configuredConfigChoiceSources(root, { env: { ...process.env, DECKENT_GLOBAL_HOME: join(root, 'global') } });
  const complete = await source.list('git-executables', 'execution.git.gitExecutable');
  expect(complete.length).toBeGreaterThan(0); expect(complete.partial).toBe(false);
  // An already spent deadline: the PATH probe answers nothing before it (as before), now flagged as cut short, here and for the sources that need it.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('timeout', 'TimeoutError')));
  expect(await discoverConfigExecutables('git', process.env, { timeoutMs: 5000 })).toEqual({ values: [], partial: 'time' });
  for (const [kind, key] of [['git-executables', 'execution.git.gitExecutable'], ['images', 'execution.docker.imageId'], ['branches', 'execution.adoption.targets']] as const) {
    const listed = await source.list(kind, key); expect([kind, listed.length, listed.partial]).toEqual([kind, 0, 'time']);
  }
});

// CONFIG-PARTIAL-CLI: a listing its size bound cut short says so ('size'); one that fits exactly is complete; a filtered source whose only
// possible match was found (the one `machine-id` in /etc) is complete whatever the listing's bound.
it('flags the file listing its size bound cut short, not one that fits, and keeps the machine-id list complete once it is found', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cs1-size-')); roots.push(root);
  const files = join(root, 'files'); await mkdir(files);
  for (let index = 0; index < 4; index++) await writeFile(join(files, `k${index}.key`), 'secret');
  const fits = await discoverConfigFiles(files, { timeoutMs: 5000, outputBytes: 1, maxEntries: 4 });
  expect([fits.values.length, fits.partial]).toEqual([4, false]);
  const cut = await discoverConfigFiles(files, { timeoutMs: 5000, outputBytes: 1, maxEntries: 3 });
  expect([cut.values.length, cut.partial]).toEqual([3, 'size']);
  await mkdir(join(root, '.deckent')); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ inspection: { maxPageSize: 1 } })); clearConfigCache();
  const source = configuredConfigChoiceSources(root, { env: { ...process.env, DECKENT_GLOBAL_HOME: join(root, 'global') } });
  const machine = await source.list('machine-files', 'installation.machineIdentity.source');
  // /etc holds more than one entry: with a one-entry bound the listing is cut; the answer is complete only when machine-id was among the read.
  expect(machine.partial).toBe(machine.length ? false : 'size');
});
