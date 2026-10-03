import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { access, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';

const exec = promisify(execFile);
const addon = createRequire(import.meta.url)('../build/Release/peer_credentials.node');
const testAddon = createRequire(import.meta.url)('../build/Test/peer_credentials.node');
const createListener = (path, native = addon, lifecycle = () => {}) => native.createListener(path, 8, () => {}, lifecycle, 25, 3);
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-pub-'));
  try { await fn(join(root, 'runtime.sock')); }
  finally { await wait(10); await rm(root, { recursive: true, force: true }); }
}
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.ctimeMs];
for (const mask of ['022', '077']) {
  test(`atomic publication: concurrent watcher sees only 0600 under ambient umask ${mask}`, async () => {
    const { stdout } = await exec(process.execPath, [fileURLToPath(new URL('./fixtures/publication-probe.mjs', import.meta.url)),
      fileURLToPath(new URL('../build/Release/peer_credentials.node', import.meta.url)), mask], { timeout: 20_000 });
    const result = JSON.parse(stdout);
    assert.equal(result.repetitions, 128); assert.ok(result.observations >= 128); assert.equal(result.unsafe, 0);
    console.log(result);
  });
}

for (const kind of ['file', 'symlink', 'socket']) {
  test(`NOREPLACE refuses a final-path ${kind} without changing its identity, mode or contents`, () => fixture(async path => {
    let sentinel;
    if (kind === 'file') await writeFile(path, 'sentinel');
    if (kind === 'symlink') { await writeFile(`${path}-target`, 'sentinel'); await symlink(`${path}-target`, path); }
    if (kind === 'socket') {
      sentinel = createServer();
      await new Promise((resolve, reject) => { sentinel.once('error', reject); sentinel.listen(path, resolve); });
    }
    try {
      const before = identity(await lstat(path));
      assert.throws(() => createListener(path), { code: 'LOCAL_PEER_LISTEN' });
      assert.deepEqual(identity(await lstat(path)), before);
      if (kind !== 'socket') assert.equal(await readFile(path, 'utf8'), 'sentinel');
      if (kind === 'symlink') assert.equal(await readlink(path), `${path}-target`);
      assert.equal((await readdir(dirname(path))).some(name => name.startsWith('.s')), false);
    } finally { if (sentinel) await new Promise(resolve => sentinel.close(resolve)); }
  }));
}

for (const [fault, code] of [[1, 'LOCAL_PEER_POLL'], [2, 'LOCAL_PEER_POLL'], [4, 'LOCAL_PEER_POLL'],
  [5, 'LOCAL_PEER_CUSTODY'], [6, 'LOCAL_PEER_PUBLICATION_UNSUPPORTED'], [7, 'LOCAL_PEER_LISTEN'],
  [12, 'LOCAL_PEER_PUBLICATION_UNSUPPORTED'], [13, 'LOCAL_PEER_PUBLICATION_UNSUPPORTED']]) {
  test(`startup fault ${fault}: exact socket/staging cleanup and descriptor release (${code})`, () => fixture(async path => {
    const before = (await readdir('/proc/self/fd')).length;
    testAddon.__testFailNextStart(fault);
    assert.throws(() => createListener(path, testAddon), { code });
    await assert.rejects(access(path), { code: 'ENOENT' });
    assert.deepEqual(await readdir(dirname(path)), []);
    for (let attempt = 0; attempt < 100 && (await readdir('/proc/self/fd')).length !== before; attempt++) await wait(2);
    assert.equal((await readdir('/proc/self/fd')).length, before);
    let settle; const settled = new Promise(resolve => { settle = resolve; });
    const retry = createListener(path, testAddon, settle); retry.close(); await settled; retry.removeEndpoint();
    assert.deepEqual(await readdir(dirname(path)), []);
  }));
}

for (const [fault, kind] of [[8, 'file'], [11, 'socket']]) {
  test(`staging cleanup preserves a foreign ${kind} replacement; chmod stays bound to the original inode`, () => fixture(async path => {
    testAddon.__testFailNextStart(fault);
    assert.throws(() => createListener(path, testAddon), { code: 'LOCAL_PEER_CUSTODY' });
    await assert.rejects(access(path), { code: 'ENOENT' });
    const [directory] = await readdir(dirname(path)); assert.match(directory, /^\.s.{6}$/);
    const replacement = join(dirname(path), directory, 's'); const stat = await lstat(replacement);
    if (kind === 'file') { assert.equal(await readFile(replacement, 'utf8'), 'replacement'); assert.equal(stat.mode & 0o777, 0o640 & ~process.umask()); }
    else { assert.equal(stat.isSocket(), true); assert.equal(stat.mode & 0o777, 0o777 & ~process.umask()); }
    assert.equal((await lstat(dirname(replacement))).mode & 0o777, 0o700);
  }));
}

test('staging cleanup preserves a replaced directory and only removes the socket in the pinned original', () => fixture(async path => {
  testAddon.__testFailNextStart(9);
  assert.throws(() => createListener(path, testAddon), { code: 'LOCAL_PEER_CUSTODY' });
  const names = (await readdir(dirname(path))).sort(); assert.equal(names.length, 2);
  const original = names.find(name => name.endsWith('.held')); const replacement = names.find(name => !name.endsWith('.held'));
  assert.equal(original, `${replacement}.held`);
  const first = await lstat(join(dirname(path), original)), second = await lstat(join(dirname(path), replacement));
  assert.notEqual(first.ino, second.ino);
  for (const name of names) assert.deepEqual(await readdir(join(dirname(path), name)), []);
}));

test('a file arriving just before publication wins without overwrite; owned staging is cleaned', () => fixture(async path => {
  testAddon.__testFailNextStart(10);
  assert.throws(() => createListener(path, testAddon), { code: 'LOCAL_PEER_LISTEN' });
  assert.equal(await readFile(path, 'utf8'), 'sentinel');
  assert.deepEqual(await readdir(dirname(path)), ['runtime.sock']);
}));

test('sun_path staging byte budget: 107 bytes succeeds, 108 refuses before creating anything (including UTF-8)', () => fixture(async path => {
  const root = dirname(path);
  for (const unicode of [false, true]) {
    for (const bytes of [96, 97]) {
      const prefix = unicode ? 'é' : '';
      const parent = join(root, prefix + 'a'.repeat(bytes - Buffer.byteLength(root) - 1 - Buffer.byteLength(prefix)));
      await mkdir(parent, { mode: 0o700 }); const endpoint = join(parent, 'x');
      assert.ok(Buffer.byteLength(endpoint) < 108);
      if (bytes === 97) assert.throws(() => createListener(endpoint), { code: 'LOCAL_PEER_OPTIONS' });
      else {
        let settle; const settled = new Promise(resolve => { settle = resolve; });
        const listener = createListener(endpoint, addon, settle);
        assert.equal((await lstat(endpoint)).mode & 0o777, 0o600);
        assert.deepEqual(await readdir(parent), ['x']);
        listener.close(); await settled; listener.removeEndpoint();
      }
      assert.deepEqual(await readdir(parent), []);
    }
  }
}));
