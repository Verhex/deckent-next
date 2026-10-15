// Build cache is an optimization, never an authority for executable identity.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE_INPUTS = Object.freeze(['packaging/bwrap/bwrap.lock.json', 'packaging/bwrap/build.sh',
  'scripts/build-bwrap.mjs', 'scripts/bwrap-cache.mjs']);
/** A linked part's committed license text; pinned by the lock's hash, so it is a driver input but not part of the cache key. */
export const licenseInput = name => `packaging/bwrap/licenses/${name}-${name === 'musl' ? 'COPYRIGHT' : 'License'}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function cacheIdentity(root, arches) {
  return { schemaVersion: 1, arches, inputs: Object.fromEntries(CACHE_INPUTS.map(path => [path, sha(readFileSync(join(root, path)))])) };
}
function inventory(dir, prefix = '') {
  const files = {};
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === 'cache-manifest.json') continue;
    const stat = lstatSync(join(dir, path));
    if (stat.isDirectory()) Object.assign(files, inventory(dir, path));
    else if (stat.isFile() && stat.nlink === 1) files[path] = sha(readFileSync(join(dir, path)));
    else throw new Error(`BWRAP_CACHE_INVALID: not a regular single-link file: ${path}`);
  }
  return files;
}
export function verifyBuild(dir, lock, arches) {
  const lines = path => readFileSync(join(dir, 'out', path), 'utf8').trim().split('\n').filter(Boolean);
  const check = (path, expected) => {
    if (sha(readFileSync(join(dir, 'out', path))) !== expected) throw new Error(`BWRAP_CACHE_INVALID: locked sha256 mismatch: ${path}`);
  };
  check(`source/bubblewrap-${lock.version}.tar.xz`, lock.source.sha256);
  if (JSON.stringify(JSON.parse(readFileSync(join(dir, 'out/source/bwrap.lock.json'), 'utf8'))) !== JSON.stringify(lock)) {
    throw new Error('BWRAP_CACHE_INVALID: corresponding source lock differs');
  }
  for (const arch of arches) check(`${arch}/bwrap`, lock.outputs[arch].sha256);
  for (const [key, path] of [['host', 'host-packages.txt'], ...arches.map(arch => [`sysroot-${arch}`, `${arch}/sysroot-packages.txt`])]) {
    if (JSON.stringify(lines(path)) !== JSON.stringify(lock.resolvedPackages[key])) throw new Error(`BWRAP_CACHE_INVALID: package closure differs: ${key}`);
    const apkDir = join(dir, 'out', 'apk', key);
    if (!readdirSync(apkDir).some(name => name.endsWith('.apk'))) throw new Error(`BWRAP_CACHE_INVALID: missing fetched APKs: ${key}`);
  }
  for (const part of lock.linked.filter(part => part.licenseText)) {
    check(`licenses/${part.name}-${part.name === 'musl' ? 'COPYRIGHT' : 'License'}`, part.licenseText.sha256);
  }
}
export function writeCacheManifest(dir, root, lock, arches) {
  verifyBuild(dir, lock, arches);
  writeFileSync(join(dir, 'cache-manifest.json'), JSON.stringify({ ...cacheIdentity(root, arches), files: inventory(dir) }, null, 2) + '\n');
}
export function verifyCache(dir, root, lock, arches) {
  const manifestPath = join(dir, 'cache-manifest.json');
  if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).nlink !== 1) throw new Error('BWRAP_CACHE_INVALID: manifest is not a regular single-link file');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { files, ...identity } = manifest;
  if (JSON.stringify(identity) !== JSON.stringify(cacheIdentity(root, arches))) throw new Error('BWRAP_CACHE_INVALID: input identity differs');
  if (JSON.stringify(files) !== JSON.stringify(inventory(dir))) throw new Error('BWRAP_CACHE_INVALID: file/APK checksums or inventory differ');
  verifyBuild(dir, lock, arches);
  if (readFileSync(join(dir, 'out/source/build.sh'), 'utf8') !== readFileSync(join(root, 'packaging/bwrap/build.sh'), 'utf8')) {
    throw new Error('BWRAP_CACHE_INVALID: corresponding recipe differs');
  }
}
/** Invalid hits stop; only absence is a miss. Verify all bytes before copying anything to the consumer. */
export function restoreBuild(from, to, root, lock, arches) {
  if (!existsSync(from)) return false;
  verifyCache(from, root, lock, arches);
  cpSync(from, to, { recursive: true });
  return true;
}
export function saveBuild(from, to, root, lock, arches) {
  writeCacheManifest(from, root, lock, arches);
  mkdirSync(to, { recursive: true });
  if (readdirSync(to).length) throw new Error(`BWRAP_CACHE_INVALID: refusing to overwrite ${to}`);
  cpSync(from, to, { recursive: true });
}
