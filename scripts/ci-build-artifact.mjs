import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function filesUnder(root, directory, source = false) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (source && ['build', 'node_modules', 'bundled'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build artifact contains symlink');
    return entry.isDirectory() ? filesUnder(root, path, source) : [path.replaceAll('\\', '/')];
  });
}
export function artifactPaths(root) {
  const paths = ['dist'];
  const visit = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory() || ['build', 'node_modules', 'bundled'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.name !== 'native') { visit(path); continue; }
      const manifest = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')).deckentNative;
      if (manifest.platforms.includes(process.platform)) paths.push(...manifest.artifacts.map(file => join(path, file)));
    }
  };
  visit('src/adapters');
  const bundled = 'src/adapters/core/shell-sandbox-bwrap/bundled';
  if (existsSync(join(root, bundled))) paths.push(bundled);
  return paths;
}
export function sealBuild(root) {
  const paths = artifactPaths(root);
  const files = paths.flatMap(path => statSync(join(root, path)).isDirectory() ? filesUnder(root, path) : [path.replaceAll('\\', '/')]).sort();
  const inputs = ['package-lock.json', 'tsconfig.json', 'arch.json', 'packaging/bwrap/bwrap.lock.json'];
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const manifest = { schemaVersion: 1, sha, node: process.versions.node.split('.')[0], platform: process.platform,
    inputs: Object.fromEntries(inputs.map(file => [file, digest(join(root, file))])),
    files: Object.fromEntries(files.map(file => [file, digest(join(root, file))])) };
  mkdirSync(join(root, '.pack'), { recursive: true });
  writeFileSync(join(root, '.pack/ci-build.json'), JSON.stringify(manifest) + '\n');
  return paths;
}
export function validateBuild(root) {
  const manifest = JSON.parse(readFileSync(join(root, '.pack/ci-build.json'), 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (manifest.schemaVersion !== 1 || manifest.sha !== sha || manifest.node !== process.versions.node.split('.')[0]
    || manifest.platform !== process.platform || !Object.keys(manifest.files).length) throw new Error('Build identity mismatch');
  for (const [file, hash] of Object.entries({ ...manifest.inputs, ...manifest.files })) {
    if (file.startsWith('/') || file.split('/').includes('..') || digest(join(root, file)) !== hash) throw new Error(`Build bytes mismatch: ${file}`);
  }
  // Product source edits after a build are refused, including added or removed files.
  const sourceFiles = filesUnder(root, 'src', true).sort();
  const hash = createHash('sha256');
  for (const file of sourceFiles) { hash.update(relative(join(root, 'src'), join(root, file))); hash.update(readFileSync(join(root, file))); }
  const identity = JSON.parse(readFileSync(join(root, 'dist/build-identity.json'), 'utf8'));
  if (sourceFiles.length !== identity.sourceFileCount || hash.digest('hex') !== identity.sourceTreeSha256) throw new Error('Stale build source');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  if (process.argv[2] === 'pack') {
    const paths = sealBuild(root);
    execFileSync('tar', ['-czf', '.pack/ci-build.tar.gz', ...paths, '.pack/ci-build.json', '.pack/ci-inventory.json'], { cwd: root, stdio: 'inherit' });
  } else if (process.argv[2] === 'seal') sealBuild(root);
  else if (process.argv[2] === 'validate') validateBuild(root);
  else throw new Error('Expected pack, seal or validate');
}
