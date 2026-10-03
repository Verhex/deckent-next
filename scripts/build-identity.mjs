import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Source provenance only: importing never compiles, stages or deletes a build.
 * DECKENT_BUILD_SOURCE_COMMON_DIR declares an absolute, existing, readable origin directory (realpath); invalid declarations fail,
 * never fall back to checkout provenance. Without it, Git provenance is best-effort, including archive builds. Both fields are optional in v1. */
function declaredCommonDir(value) {
  try {
    if (!isAbsolute(value)) throw new Error('Origin common directory must be absolute');
    const path = realpathSync(value);
    if (!statSync(path).isDirectory()) throw new Error('Origin common directory must be a directory');
    accessSync(path, constants.R_OK | constants.X_OK);
    return path;
  } catch (cause) {
    throw Object.assign(new Error('BUILD_SOURCE_COMMON_DIR_INVALID', { cause }), { code: 'BUILD_SOURCE_COMMON_DIR_INVALID', sourceCommonDir: value });
  }
}

export function writeBuildIdentity(root, sourceFiles, dist) {
  const src = join(root, 'src');
  const files = [...sourceFiles].sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(relative(src, file)); hash.update(readFileSync(file)); }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // Provenance is best-effort in archive trees. Resolve relative common dirs against the source checkout, not the caller's cwd.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = args => { try { return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const sourceCommit = git(['rev-parse', 'HEAD']) || null;
  const status = sourceCommit === null ? null : git(['--no-optional-locks', 'status', '--porcelain', '--', 'src']);
  const declared = process.env.DECKENT_BUILD_SOURCE_COMMON_DIR;
  let sourceCommonDir;
  if (declared !== undefined) sourceCommonDir = declaredCommonDir(declared);
  else {
    const commonDir = git(['rev-parse', '--git-common-dir']);
    try { if (commonDir) sourceCommonDir = realpathSync(resolve(root, commonDir)); } catch { /* Missing/unreadable provenance stays absent. */ }
  }
  const identity = { schemaVersion: 1, packageName: pkg.name, packageVersion: pkg.version, sourceTreeSha256: hash.digest('hex'), sourceFileCount: files.length,
    sourceCommit, ...(sourceCommonDir ? { sourceCommonDir } : {}), sourceCommonDirOrigin: declared === undefined ? 'derived' : 'declared',
    sourceDirty: status === null ? null : status.length > 0, builtAt: new Date().toISOString() };
  writeFileSync(join(dist, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
