import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredConfigChoiceSources } from '#composition/core/config/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { CONFIG_DISCOVERY_BOUNDS, discoverConfigExecutables, discoverConfigBranches, discoverConfigImages, discoverConfigFiles, discoverConfigPools } from '#adapters/index.js';
import { clearConfigCache, getConfigFieldDefault, prepareProductDirectory, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { DatabaseSync } from 'node:sqlite';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('CS-1 production choice discovery', () => {
  it('observes principal scopes, the policy company, identity profiles, layout key files and environment names without reading values', async () => {
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
  it('discovers executables and local branches and reads bounded pool records without a ledger writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cs1-git-')); roots.push(root);
    const limits = { timeoutMs: 5000, outputBytes: 65536, maxEntries: 16 }, git = (await discoverConfigExecutables('git', process.env, limits))[0]!;
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
    expect((await discoverConfigFiles(files, limits)).map(path => basename(path))).toEqual(['file.key']);
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
  expect(images).toEqual([imageId]);
  expect(seen.some(args => args.includes('--host') && args.includes('info'))).toBe(true);
  expect(seen.some(args => args.includes('inspect') && args.includes(rejected))).toBe(true);
});

// Astra 2456 N3: the PATH probe and the directory listing are bounded as a whole, not only by matches.
it('probes at most the bounded number of PATH directories and reads a bounded number of directory entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cs1-bounds-')); roots.push(root);
    const real = (await discoverConfigExecutables('git', process.env, { timeoutMs: 5000 }))[0]!;
    const filler = Array.from({ length: CONFIG_DISCOVERY_BOUNDS.pathDirectories }, (_, index) => join(root, `empty-${index}`));
    const beyond = { ...process.env, PATH: [...filler, real.slice(0, real.lastIndexOf('/'))].join(':') };
    expect(await discoverConfigExecutables('git', beyond, { timeoutMs: 5000 })).toEqual([]);
    const within = { ...process.env, PATH: [...filler.slice(1), real.slice(0, real.lastIndexOf('/'))].join(':') };
    expect(await discoverConfigExecutables('git', within, { timeoutMs: 5000 })).toEqual([real]);
    const many = join(root, 'many'); await mkdir(many);
    for (let index = 0; index < 40; index++) await mkdir(join(many, `dir-${index}`));
    expect(await discoverConfigFiles(many, { timeoutMs: 5000, outputBytes: 1, maxEntries: 1 })).toEqual([]);
});
