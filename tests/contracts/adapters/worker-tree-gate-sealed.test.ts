import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rmdir, statfs, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectSealedWorkerTree, reopenWorkerTree, reviewSealedWorkerTree, scanWorkerTree, sealWorkerTree, sealedWorkerTreeLocation, verifySealedWorkerTree } from '#adapters/core/worker-tree-gate/index.js';
import { codingPreparedInput, produceCodingPackageList } from '#adapters/core/setup-detect-coding/index.js';
import { EMPTY_KNOWN_SECRETS, ErrorRegistry, snapshotKnownSecrets, withConfigWriteLock } from '#platform/index.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
async function removeFixture(path: string) {
  if (!(await lstat(path)).isDirectory()) { await unlink(path); return; }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await removeFixture(join(path, name));
  await rmdir(path);
}
afterEach(async () => {
  vi.mocked(open).mockReset();
  for (const root of roots.splice(0)) await removeFixture(root);
});

const options = { allowPatternPaths: ['**'], acknowledgedDenyPaths: ['node_modules/.env'], maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 24, timeoutMs: 30_000 };
const label = 'node_modules';
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const noSecrets = EMPTY_KNOWN_SECRETS;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-sealed-packages-')); roots.push(root);
  const source = join(root, 'installed'), bin = join(source, '.bin'), pkg = join(source, 'pkg');
  await mkdir(source); await mkdir(bin); await mkdir(pkg);
  const program = join(pkg, 'program');
  await writeFile(program, 'hello', { mode: 0o755 });
  const object = (digest: string) => sealedWorkerTreeLocation(root, { approval: { scopeId: 'scope' }, project: root, workTarget: root, platform: 'linux-x64', layout: 'node-npm', listDigest: digest, lockfileDigest: 'a'.repeat(64) });
  return { root, source, object, bin, pkg, program };
}

describe.skipIf(process.platform !== 'linux')('sealed worker package inputs', () => {
  it('matches an approved tree, retains exact in-tree .bin link text, and reopens its original bytes after source changes', async () => {
    const f = await fixture(); await symlink('../pkg/program', join(f.bin, 'program'));
    const { digest, manifest } = await inspectSealedWorkerTree(f.source, options);
    expect(manifest.entries.map(entry => [entry.path, entry.kind])).toEqual([['.bin', 'directory'], ['.bin/program', 'link'], ['pkg', 'directory'], ['pkg/program', 'file']]);
    expect(manifest.entries[3]).toMatchObject({ size: 5, mode: 0o755, digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
    await sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets);
    await writeFile(f.program, 'new');
    const found = await reopenWorkerTree(f.object(digest), label, digest, options, noSecrets);
    expect(await readlink(join(found.source, '.bin/program'))).toBe('../pkg/program');
    expect((await lstat(join(found.source, 'pkg/program'))).mode & 0o777).toBe(0o511);
  });

  it.each(['missing', 'extra', 'bytes', 'mode'] as const)('refuses %s in a previously approved list and publishes no object', async mutation => {
    const f = await fixture(), { digest } = await inspectSealedWorkerTree(f.source, options);
    if (mutation === 'missing') await unlink(f.program);
    if (mutation === 'extra') await writeFile(join(f.pkg, 'extra'), 'extra');
    if (mutation === 'bytes') await writeFile(f.program, 'bye');
    if (mutation === 'mode') await chmod(f.program, 0o644);
    await expect(sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    await expect(lstat(f.object(digest))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['chain', '../pkg/alias'], ['broken', '../pkg/absent'], ['loop', 'program'], ['absolute', '/pkg/program'],
    ['leaving then re-entering', '../../installed/pkg/program'], ['directory target', '../pkg'], ['symbolic ancestor', '../alias/program'],
  ])('refuses a link with %s', async (risk, target) => {
    const f = await fixture();
    if (risk === 'chain') await symlink('program', join(f.pkg, 'alias'));
    if (risk === 'symbolic ancestor') await symlink('pkg', join(f.source, 'alias'));
    await symlink(target, join(f.bin, 'program'));
    await expect(inspectSealedWorkerTree(f.source, options)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
  });

  it('refuses a hard name outside the approved root even when .bin targets the listed name', async () => {
    const f = await fixture(); await link(f.program, join(f.root, 'unlisted')); await symlink('../pkg/program', join(f.bin, 'program'));
    await expect(inspectSealedWorkerTree(f.source, options)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
  });

  it('copies every listed hard name independently and binds the .bin link to its listed target', async () => {
    const f = await fixture(), alias = join(f.pkg, 'alias');
    await link(f.program, alias); await symlink('../pkg/program', join(f.bin, 'program'));
    const { digest } = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    await sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets);
    const { source } = await reopenWorkerTree(f.object(digest), label, digest, options, noSecrets);
    const a = await lstat(join(source, 'pkg/program')), b = await lstat(join(source, 'pkg/alias'));
    expect([a.nlink, b.nlink]).toEqual([1, 1]); expect(a.ino).not.toBe(b.ino);
    expect(await readlink(join(source, '.bin/program'))).toBe('../pkg/program');
  });

  it('serializes writers at the installation bound, counts a partial stage and every hard name, and reuses without allocation', async () => {
    const f = await fixture(), parent = dirname(f.object('x')), partial = join(parent, '.sealing-abandoned');
    await mkdir(partial, { recursive: true, mode: 0o700 });
    await writeFile(join(partial, 'partial'), 'left');
    await link(f.program, join(f.pkg, 'second'));
    const { digest, manifest } = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    const { bsize } = await statfs(parent);
    const charge = (size: number) => Math.ceil(size / bsize) * bsize + bsize;
    const needed = charge(Buffer.byteLength(JSON.stringify(manifest))) + 4 * charge(0) + 2 * charge(5);
    const used = charge(4) + charge(0);
    const limit = (maxBytes: number) => ({
      run: <T>(store: string, work: () => Promise<T>) => withConfigWriteLock(store, work, options.timeoutMs),
      maxBytes: async () => maxBytes,
    });
    const seal = (object: string, bound: number) => sealWorkerTree(f.source, object, label, digest, options, noSecrets, undefined, limit(bound));
    const a = f.object(digest), b = f.object('b'.repeat(64));
    const refused = await seal(a, needed + used - 1).catch(error => error);
    expect(refused).toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED', params: { bound: needed + used - 1, used, needed } });
    for (const locale of ['en', 'tr'] as const) {
      const message = ErrorRegistry.get(refused.code, locale, refused.params)?.message;
      expect(message).toContain('installation.sealedPackageStoreMaxBytes');
      for (const value of [needed + used - 1, used, needed]) expect(message).toContain(String(value));
    }
    expect(await readdir(parent)).toEqual(['.sealing-abandoned']);
    const results = await Promise.allSettled([seal(a, needed + used), seal(b, needed + used)]);
    expect(results.map(row => row.status).sort()).toEqual(['fulfilled', 'rejected']);
    const published = (await readdir(parent)).filter(name => name !== '.sealing-abandoned');
    expect(published).toHaveLength(1);
    await expect(seal(join(parent, published[0]!), 1)).resolves.toMatchObject({ bytes: 0 });
    expect(await readFile(join(partial, 'partial'), 'utf8')).toBe('left');
  });

  it('recovers a storage lock after the writer dies and keeps its abandoned bytes charged', async () => {
    const f = await fixture(), { digest } = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    const object = f.object(digest), parent = dirname(object), stage = join(parent, '.sealing-crashed');
    await mkdir(parent, { mode: 0o700 });
    const script = `
      import { mkdir, writeFile } from 'node:fs/promises';
      import { withConfigWriteLock } from ${JSON.stringify(new URL('../../../dist/platform/index.js', import.meta.url).href)};
      const [store, stage, file] = process.argv.slice(1);
      await withConfigWriteLock(store, async () => {
        await mkdir(stage);
        await writeFile(file, 'crashed');
        process.stdout.write('ready');
        await new Promise(resolve => setInterval(resolve, 60000));
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, parent, stage, join(stage, 'partial')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
      expect(await Promise.race([once(child.stdout, 'data').then(([data]: [Buffer]) => data.toString()), closed.then(() => 'exited')])).toBe('ready');
    } finally { child.kill('SIGKILL'); await closed; }
    const lock = { run: <T>(store: string, work: () => Promise<T>) => withConfigWriteLock(store, work, options.timeoutMs, { onWarning() {} }),
      maxBytes: async () => 1 };
    await expect(sealWorkerTree(f.source, object, label, digest, options, noSecrets, undefined, lock))
      .rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED', params: { used: expect.any(Number) } });
    expect(await readFile(join(stage, 'partial'), 'utf8')).toBe('crashed');
    await expect(sealWorkerTree(f.source, object, label, digest, options, noSecrets, undefined, { ...lock, maxBytes: async () => 100000000 }))
      .resolves.toMatchObject({ bytes: 5 });
  });

  it('refuses a write through another hard name during copying', async () => {
    const f = await fixture(), alias = join(f.pkg, 'alias');
    await link(f.program, alias);
    const { digest } = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let rewritten = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (!rewritten && typeof args[0] === 'string' && args[0].includes('/.sealing-') && args[0].endsWith('/alias')) {
        rewritten = true; await actual.writeFile(f.program, 'other');
      }
      return actual.open(...args);
    });
    await expect(sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    expect(rewritten).toBe(true);
    await expect(lstat(f.object(digest))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a file only after its complete rule set and digest have been reviewed', async () => {
    const f = await fixture(), synthetic = 'https://fixture-user:fixture-pass@example.invalid\n-----BEGIN PRIVATE KEY-----';
    await writeFile(f.program, synthetic);
    const { digest, manifest } = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    expect(manifest.entries.find(row => row.path === 'pkg/program')).toMatchObject({ rules: ['pattern:private-key-block', 'pattern:url-userinfo'] });
    expect(JSON.stringify(manifest)).not.toContain('fixture-user:fixture-pass');
    await sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets);
    await expect(reopenWorkerTree(f.object(digest), label, digest, options, snapshotKnownSecrets([{ name: 'DEMO', value: 'fixture-pass' }]))).rejects.toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED' });
  });

  it('refuses the same bytes when an approval omitted the second matching rule', async () => {
    const f = await fixture();
    await writeFile(f.program, 'https://fixture-user:fixture-pass@example.invalid\n-----BEGIN PRIVATE KEY-----');
    const { manifest } = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    const partial = { ...manifest, entries: manifest.entries.map(row => row.path === 'pkg/program' ? { ...row, rules: row.rules.slice(0, 1) } : row) };
    const digest = hash(JSON.stringify(partial));
    await expect(sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    await expect(lstat(f.object(digest))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses different bytes at an approved path while the same rule still matches', async () => {
    const f = await fixture();
    await writeFile(f.program, 'https://fixture-user:fixture-first@example.invalid');
    const { digest } = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    await writeFile(f.program, 'https://fixture-user:fixture-other@example.invalid');
    await expect(sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    await expect(lstat(f.object(digest))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds a pattern in exact link text and the verified target without exposing the raw text', async () => {
    const f = await fixture(), linkPath = join(f.bin, 'settings.json'), target = '../pkg/token:/././ok';
    await mkdir(join(f.pkg, 'token:')); await writeFile(join(f.pkg, 'token:/ok'), 'hello');
    await symlink(target, linkPath);
    const unapproved = await inspectSealedWorkerTree(f.source, options);
    await expect(sealWorkerTree(f.source, f.object(unapproved.digest), label, unapproved.digest, options, noSecrets)).rejects.toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED' });
    const approved = await reviewSealedWorkerTree(f.source, label, options, noSecrets);
    expect(approved.manifest.entries.filter(row => row.rules.length)).toEqual([expect.objectContaining({
      path: '.bin/settings.json', digest: hash(target), target: 'pkg/token:/ok', rules: ['pattern:config-secret'],
    })]);
    expect(JSON.stringify(approved.manifest)).not.toContain(target);
    await sealWorkerTree(f.source, f.object(approved.digest), label, approved.digest, options, noSecrets);
    await unlink(linkPath); await symlink('../pkg/token:/./././ok', linkPath);
    await expect(sealWorkerTree(f.source, f.object('f'.repeat(64)), label, approved.digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
  });

  it('refuses an archive even when the existing S6 path glob would allow it', async () => {
    const f = await fixture(); await writeFile(f.program, Buffer.from('1f8b080000000000', 'hex'));
    await expect(reviewSealedWorkerTree(f.source, label, options, noSecrets)).rejects.toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED',
      params: { paths: 'node_modules/pkg/program (unscannable:archive-gzip)' } });
  });

  it('does not scan an oversized entry under the current single-file bound', async () => {
    const f = await fixture(), low = { ...options, maxFileBytes: 4 };
    await expect(reviewSealedWorkerTree(f.source, label, low, noSecrets)).rejects.toMatchObject({
      code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED', params: { size: 5, bound: 4 },
    });
    await expect(reviewSealedWorkerTree(f.source, label, options, noSecrets)).resolves.toMatchObject({ digest: expect.any(String) });
  });

  it('excludes npm bookkeeping and refuses an exact digest for a file absent from the locked package archive', async () => {
    const f = await fixture(), pkg = join(f.root, 'package'), archiveDir = join(f.root, 'archives'), temporary = join(f.root, 'pkg.tgz');
    const metadata = '{"name":"pkg","version":"1.0.0","bin":{"program":"program"}}';
    await mkdir(pkg); await mkdir(archiveDir);
    await writeFile(join(pkg, 'package.json'), metadata); await writeFile(join(pkg, 'program'), 'hello');
    execFileSync('tar', ['--format=ustar', '-czf', temporary, '-C', f.root, 'package']);
    const raw = await readFile(temporary), sha = createHash('sha512').update(raw);
    const integrity = 'sha512-' + sha.copy().digest('base64');
    const hex = sha.digest('hex'), cacheEntry = join(archiveDir, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    await mkdir(dirname(cacheEntry), { recursive: true });
    await writeFile(cacheEntry, raw, { mode: 0o644 });
    await writeFile(join(f.pkg, 'package.json'), metadata); await writeFile(join(f.pkg, 'injected'), 'unrelated');
    await writeFile(join(f.source, '.package-lock.json'), 'local bookkeeping');
    const lock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { 'installed/pkg': { version: '1.0.0', integrity, bin: { program: 'program' } } } }));
    const rows = [{ path: 'pkg/package.json', digest: hash(metadata) }, { path: 'pkg/program', digest: hash('hello') }];
    const prepare = (entries: typeof rows) => codingPreparedInput(f.root, 'installed', label, options, noSecrets, lock,
      Buffer.from(JSON.stringify({ schemaVersion: 1, entries })), archiveDir, f.root);
    const valid = await (await prepare(rows)).review();
    expect(valid.manifest.entries.map(row => row.path)).toEqual(['pkg', 'pkg/package.json', 'pkg/program']);
    await expect(prepare([...rows, { path: 'pkg/injected', digest: hash('unrelated') }])).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    await expect(prepare([...rows, { path: '.package-lock.json', digest: hash('local bookkeeping') }])).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    await symlink('../pkg/program', join(f.bin, 'program'));
    const produce = () => produceCodingPackageList(f.root, 'installed', label, options, noSecrets, lock, archiveDir, f.root);
    const produced = await produce();
    await produced.write('deckent-package-files.json');
    expect(await readFile(join(f.root, 'deckent-package-files.json'))).toEqual(produced.bytes);
    const list = JSON.parse(produced.bytes.toString('utf8'));
    expect(list.entries.map((row: { path: string }) => row.path)).toEqual(['.bin/program', 'pkg/package.json', 'pkg/program']);
    const approved = await (await prepare(list.entries)).review();
    expect(approved.digest).toBe(produced.review.digest);
    await (await prepare(list.entries)).seal(f.root, { approval: { scopeId: 'scope' }, project: f.root, workTarget: f.root,
      platform: 'linux-x64', layout: 'node-npm', listDigest: approved.digest, lockfileDigest: hash(lock) });
    await writeFile(cacheEntry, 'wrong archive');
    const cacheFailure = { code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED', params: { package: 'installed/pkg' } };
    await expect(produce()).rejects.toMatchObject(cacheFailure);
    await unlink(cacheEntry);
    await expect(produce()).rejects.toMatchObject(cacheFailure);
    await symlink(temporary, cacheEntry);
    await expect(produce()).rejects.toMatchObject(cacheFailure);
  });

  it('refuses a nonblocking special file without opening it as package bytes', async () => {
    const f = await fixture(); execFileSync('mkfifo', [join(f.pkg, 'pipe')]);
    await expect(inspectSealedWorkerTree(f.source, options)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
  });

  it('refuses an inode swap between the path check and opening the file', async () => {
    const f = await fixture(), { digest } = await inspectSealedWorkerTree(f.source, options);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let swapped = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (!swapped && typeof args[0] === 'string' && args[0].startsWith('/proc/self/fd/') && args[0].endsWith('/program')) {
        swapped = true; await rename(f.program, join(f.pkg, 'earlier')); await writeFile(f.program, 'hello', { mode: 0o755 });
      }
      return actual.open(...args);
    });
    await expect(sealWorkerTree(f.source, f.object(digest), label, digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
    expect(swapped).toBe(true);
    await expect(lstat(f.object(digest))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a lost object without reopening the installed source', async () => {
    const f = await fixture(), { digest } = await inspectSealedWorkerTree(f.source, options);
    await expect(reopenWorkerTree(f.object(digest), label, digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
  });

  it('refuses a damaged retained object after reading its approved list', async () => {
    const f = await fixture(), { digest } = await inspectSealedWorkerTree(f.source, options), object = f.object(digest);
    await sealWorkerTree(f.source, object, label, digest, options, noSecrets);
    const held = join(object, 'tree/pkg/program'); await chmod(held, 0o755); await writeFile(held, 'new'); await chmod(held, 0o511);
    await expect(reopenWorkerTree(object, label, digest, options, noSecrets)).rejects.toMatchObject({ code: 'NATIVE_WORKER_DEPENDENCIES_REFUSED' });
  });

  it('gives the dispatch scan an exact verified view and a value-free finding for a newly known secret', async () => {
    const f = await fixture(), value = 'newly-known-fixture-value';
    await writeFile(f.program, value);
    const { digest } = await inspectSealedWorkerTree(f.source, options), object = f.object(digest);
    await sealWorkerTree(f.source, object, label, digest, options, noSecrets);
    const known = snapshotKnownSecrets([{ name: 'DEMO', value }]);
    const { source, entries } = await verifySealedWorkerTree(object, digest, options);
    const result = await scanWorkerTree([{ source, label, sealedPaths: entries.map(entry => entry.path) }], options, known);
    expect(result).toEqual({ status: 'refused', count: 1, findings: [{ path: `${label}/pkg/program`, rule: 'known-secret' }] });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it.each(['pattern', 'known-value', 'deny-path', 'path-pattern'] as const)('refuses %s without recording the matched value', async risk => {
    const f = await fixture(), synthetic = ['h', 'ttps://person:fixture@example.invalid'].join('');
    if (risk === 'deny-path') await writeFile(join(f.source, '.env'), 'fixture');
    else if (risk === 'path-pattern') {
      const secret = ['sk', 'ant', 'api03', 'Zx9'.repeat(12)].join('-');
      await writeFile(join(f.pkg, secret), 'fixture');
    } else await writeFile(f.program, risk === 'pattern' ? synthetic : 'synthetic-local-value');
    const known = risk === 'known-value' ? snapshotKnownSecrets([{ name: 'DEMO', value: 'synthetic-local-value' }]) : noSecrets;
    const { digest } = await inspectSealedWorkerTree(f.source, options);
    const error = await sealWorkerTree(f.source, f.object(digest), label, digest, options, known).catch(cause => cause);
    expect(error).toMatchObject({ code: 'WORKER_TREE_SECRET_REFUSED' });
    expect(JSON.stringify(error)).not.toMatch(/person:fixture|synthetic-local-value|Zx9Zx9/u);
    await expect(lstat(f.object(digest))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
