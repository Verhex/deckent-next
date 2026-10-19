// Public, allowlisted runner diagnostics only. Never dump the inherited environment or credentials.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';

const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch (error) { return error.code; } };
const links = {}, unsafe = [], missing = [];
const walk = path => {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') { missing.push(path); return; } throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
  links[stat.nlink] = (links[stat.nlink] ?? 0) + 1;
  if (!stat.isFile() || stat.nlink !== 1) unsafe.push(path);
};
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
for (const path of ['package.json', ...manifest.files]) walk(path);
const temporaryParent = realpathSync(tmpdir()), fs = statfsSync(temporaryParent);
const evidence = { node: process.version, platform: process.platform, arch: process.arch, kernel: release(),
  cpuCores: cpus().length, availableParallelism: availableParallelism(), totalMemMiB: Math.round(totalmem() / 1048576),
  umask: process.umask().toString(8), locale: Intl.DateTimeFormat().resolvedOptions(), temporaryParent,
  temporaryFsType: fs.type, temporaryAvailableMiB: Math.round(fs.bavail * fs.bsize / 1048576),
  fileLinkDistribution: links, unsafeFiles: unsafe, missingDeclarations: missing,
  userns: read('/proc/sys/kernel/unprivileged_userns_clone'),
  apparmorUserns: read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
  userNamespaceLimit: read('/proc/sys/user/max_user_namespaces') };
mkdirSync('.pack/ci-evidence', { recursive: true });
writeFileSync(`.pack/ci-evidence/environment-${process.argv[2] ?? 'setup'}.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(`ci-environment: ${JSON.stringify(evidence)}`);
