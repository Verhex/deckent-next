import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Explicit build/update operation. Never mutates runtime profiles, running containers or old images.
const root = dirname(fileURLToPath(import.meta.url));
const [receipt, option, existingImage, ...extra] = process.argv.slice(2);
if (!receipt || extra.length || !isAbsolute(receipt) || existsSync(receipt)
  || (option !== undefined && (option !== '--image-id' || !/^sha256:[a-f0-9]{64}$/.test(existingImage ?? '')))) {
  throw new Error('WORKER_RECEIPT_INVALID: provide an absolute path to a new JSON file inside an existing writable directory.');
}
try {
  if (!statSync(dirname(receipt)).isDirectory()) throw new Error('not-directory');
  accessSync(dirname(receipt), constants.W_OK | constants.X_OK);
} catch {
  throw new Error(`WORKER_RECEIPT_DIRECTORY_UNAVAILABLE: ${dirname(receipt)}. Choose an existing writable directory before building.`);
}
const recipe = JSON.parse(readFileSync(join(root, 'recipe.json'), 'utf8'));
if (recipe.schemaVersion !== 1 || typeof recipe.baseImage !== 'string' || !recipe.baseImage || recipe.baseImage.startsWith('-')) {
  throw new Error('WORKER_RECIPE_INVALID');
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key)));
const run = (args, timeout, inherit = false) => {
  const result = spawnSync('docker', args, { env, timeout, encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`WORKER_IMAGE_COMMAND_FAILED:${args[0]}`);
  return result.stdout?.trim();
};
const temporary = mkdtempSync(join(tmpdir(), 'deckent-image-build-'));
let cleanup;
try {
  const endpoint = JSON.parse(run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], 20_000));
  const command = (args, timeout, inherit) => run(['--host', endpoint, ...args], timeout, inherit);
  const cidfile = join(temporary, 'probe-container');
  cleanup = () => {
    if (existsSync(cidfile)) {
      const id = readFileSync(cidfile, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(id)) {
        spawnSync('docker', ['--host', endpoint, 'rm', '--force', id], { env, timeout: 20_000, stdio: 'ignore' });
      }
    }
  };
  const daemonId = command(['info', '--format', '{{.ID}}'], 20_000);
  if (!existingImage) {
    command(['build', '--pull', '--no-cache', '--build-arg', `BASE_IMAGE=${recipe.baseImage}`,
      '--iidfile', join(temporary, 'image-id'), root], 1_200_000, true);
  }
  const imageId = existingImage ?? readFileSync(join(temporary, 'image-id'), 'utf8').trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('WORKER_IMAGE_ID_INVALID');
  if (command(['image', 'inspect', imageId, '--format', '{{.Id}}'], 20_000) !== imageId) {
    throw new Error('WORKER_IMAGE_ID_MISMATCH');
  }
  const manifest = JSON.parse(command(['run', '--rm', '--cidfile', cidfile, '--pull=never', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--memory-swap=1g',
    '--cpus=2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456', imageId], 90_000));
  if (command(['info', '--format', '{{.ID}}'], 20_000) !== daemonId) throw new Error('WORKER_DAEMON_CHANGED');
  const sources = existingImage ? null : Object.fromEntries(['Dockerfile', 'recipe.json', 'install.mjs', 'inspect.mjs'].map(name =>
    [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]));
  writeFileSync(resolve(receipt), JSON.stringify({ schemaVersion: 1, measuredAt: new Date().toISOString(),
    endpoint, daemonId, imageId, sources, manifest, activation: 'not-activated',
    provenance: existingImage ? 'existing-image-reprobed-build-sources-unverified' : 'built-from-current-sources',
    update: 'Re-run builder for current releases; use verified imageId in a new execution profile revision. Retain old image IDs for active Runs and rollback.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ imageId, receipt, activation: 'not-activated' }));
} finally { cleanup?.(); rmSync(temporary, { recursive: true, force: true }); }
