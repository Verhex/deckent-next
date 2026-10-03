import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Source provenance only: importing this producer never compiles, stages or deletes a build. */
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
  const commonDir = git(['rev-parse', '--git-common-dir']);
  let sourceCommonDir;
  try { if (commonDir) sourceCommonDir = realpathSync(resolve(root, commonDir)); } catch { /* Missing/unreadable provenance stays absent. */ }
  const identity = { schemaVersion: 1, packageName: pkg.name, packageVersion: pkg.version, sourceTreeSha256: hash.digest('hex'), sourceFileCount: files.length,
    sourceCommit, ...(sourceCommonDir ? { sourceCommonDir } : {}), sourceDirty: status === null ? null : status.length > 0, builtAt: new Date().toISOString() };
  writeFileSync(join(dist, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
