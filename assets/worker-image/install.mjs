import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
// One provider layer of a worker image (recipe schema 3): the descriptor is this RUN line's own argument (layers.mjs), so the layer's cache
// key is exactly its install input. A known refusal is one `Error: WORKER_<CODE>: <detail>` line (the builder promotes it), never a stack.
process.on('uncaughtException', error => {
  process.stderr.write(/^WORKER_[A-Z_]+(?::|$)/.test(error?.message ?? '') ? `Error: ${error.message}\n` : `${error?.stack ?? error}\n`);
  process.exit(1);
});
const root = '/opt/deckent-worker';
let d;
try { d = JSON.parse(process.argv[2] ?? ''); } catch { throw new Error('WORKER_PLAN_INVALID: the install descriptor is not JSON'); }
if (!/^[a-z0-9]{1,32}$/.test(d?.id ?? '')) throw new Error('WORKER_PLAN_INVALID: the install descriptor names no provider');
const run = (file, args, env = process.env) => {
  try { return execFileSync(file, args, { env, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw new Error(`WORKER_IMAGE_COMMAND_FAILED: ${d.id}`); }
};
let record;
if (d.kind === 'npm') {
  // The npm tarball cache stays out of the layer (it was ~0.3 GB of dead weight in r31): a private cache inside this RUN, removed in the same RUN.
  const cache = `/tmp/deckent-npm-cache-${d.id}`;
  try { run('npm', ['install', '--global', '--no-audit', '--no-fund', '--cache', cache, '--registry', d.registry, ...(existsSync('/run/secrets/worker-npmrc') ? ['--userconfig', '/run/secrets/worker-npmrc'] : []), `${d.package}@${d.version}`]); }
  finally { rmSync(cache, { recursive: true, force: true }); }
  record = { kind: 'npm', package: d.package, version: d.version, registry: d.registry };
} else if (d.kind === 'vendor-script') {
  // The installer runs only inside this build container, and only when its bytes are the ones the plan hashed (U6 §4: the sha is the cache key).
  const installer = `/tmp/deckent-${d.id}-install.sh`;
  run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '60', d.url, '--output', installer]);
  const installerSha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
  if (installerSha256 !== d.sha256) throw new Error(`WORKER_IMAGE_INSTALLER_CHANGED: ${d.id} installer is ${installerSha256}, the plan hashed ${d.sha256}; plan again to review the change`);
  mkdirSync(d.home, { recursive: true });
  run('bash', [installer], { ...process.env, HOME: d.home });
  run('chmod', ['-R', 'a+rX', d.home]);
  for (const name of d.bin) symlinkSync(`${d.home}/.local/bin/${name}`, `/usr/local/bin/${name}`);
  rmSync(installer);
  // The vendor script fetches whatever it serves: the installed version is read from the binary, so the receipt records what the image holds.
  const version = run(d.command, ['--version']).trim();
  if (!/^[\w.+-]{1,64}$/.test(version)) throw new Error('WORKER_VERSION_INVALID');
  record = { kind: 'vendor-script', url: d.url, installerSha256, version };
} else throw new Error('WORKER_PLAN_INVALID: unknown installer kind');
mkdirSync(`${root}/installed`, { recursive: true });
writeFileSync(`${root}/installed/${d.id}.json`, JSON.stringify({ schemaVersion: 2, id: d.id, ...record }, null, 2) + '\n');
