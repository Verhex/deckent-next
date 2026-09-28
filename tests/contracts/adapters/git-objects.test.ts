import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { isVerifiedGitObject } from '#adapters/core/host-shell/index.js';

// Astra 2158 R2: the verified-object cache is keyed by the inode's ctime and the identity the path promises, so a same-size rewrite
// with its mtime put back, or the same inode under another object name, is never answered from a stale `true`.
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function object(content = 'hello\n') {
  const root = await mkdtemp(join(tmpdir(), 'dn-git-objects-')); roots.push(root);
  const data = Buffer.from(`blob ${Buffer.byteLength(content)}\0${content}`), hash = createHash('sha1').update(data).digest('hex');
  const dir = join(root, '.git', 'objects', hash.slice(0, 2)); await mkdir(dir, { recursive: true });
  const file = join(dir, hash.slice(2)); await writeFile(file, deflateSync(data));
  return { root, dir, file, hash };
}

describe.skipIf(process.platform !== 'linux')('verified git object cache (Astra 2158 R2)', () => {
  it('re-hashes after a same-size in-place rewrite whose mtime was put back (ctime moved on)', async () => {
    const o = await object();
    expect(await isVerifiedGitObject(o.file)).toBe(true);
    const before = await stat(o.file);
    execFileSync('python3', ['-c', 'import os,sys\np=sys.argv[1]\ns=os.stat(p)\nopen(p,"wb").write(b"X"*s.st_size)\nos.utime(p,ns=(s.st_atime_ns,s.st_mtime_ns))', o.file]);
    const after = await stat(o.file);
    expect({ size: after.size === before.size, mtime: after.mtimeMs === before.mtimeMs, ctime: after.ctimeMs !== before.ctimeMs }).toEqual({ size: true, mtime: true, ctime: true });
    expect(await isVerifiedGitObject(o.file)).toBe(false);
  });
  it('does not carry a true across names: the same inode under another object name is not that object', async () => {
    const o = await object();
    expect(await isVerifiedGitObject(o.file)).toBe(true);
    const other = join(o.dir, 'f'.repeat(38)); await link(o.file, other);
    expect(await isVerifiedGitObject(other)).toBe(false);
    expect(await isVerifiedGitObject(o.file)).toBe(true);
  });
  it('verifies nothing outside an object or pack path, and a corrupt object once its ctime changed', async () => {
    const o = await object();
    await writeFile(join(o.root, '.git', 'plain'), 'x'); expect(await isVerifiedGitObject(join(o.root, '.git', 'plain'))).toBe(false);
    expect(await isVerifiedGitObject(o.file)).toBe(true);
    await writeFile(o.file, 'corrupt'); expect(await isVerifiedGitObject(o.file)).toBe(false);
  });
});
