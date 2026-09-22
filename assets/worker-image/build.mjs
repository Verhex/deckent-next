import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateRecipe, parseVersionHistory } from './history.mjs';

// Explicit build/update operation. Never mutates runtime profiles, running containers or old images.
// Each recipe.imageVersion maps to exactly one immutable imageId, tagged <repository>:<imageVersion>.
// Old images, tags and receipts are retained for active Runs and rollback; nothing here deletes them.
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
const sha256 = name => createHash('sha256').update(readFileSync(join(root, name))).digest('hex');
const recipe = validateRecipe(JSON.parse(readFileSync(join(root, 'recipe.json'), 'utf8')));
const history = parseVersionHistory(readFileSync(join(root, 'Dockerfile'), 'utf8'), recipe);
const tag = `${recipe.repository}:${recipe.imageVersion}`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key)));
const run = (args, timeout, inherit = false) => {
  const result = spawnSync('docker', args, { env, timeout, encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`WORKER_IMAGE_COMMAND_FAILED:${args[0]}`);
  return result.stdout?.trim();
};
const sourceRevision = (() => {
  try {
    const git = args => spawnSync('git', ['-C', root, ...args], { env, timeout: 5_000, encoding: 'utf8' });
    const head = git(['rev-parse', '--short', 'HEAD']); const dirty = git(['status', '--short', '--', root]);
    if (head.status !== 0 || dirty.status !== 0) return 'unknown';
    return `${head.stdout.trim()}${dirty.stdout.trim() ? '-dirty' : ''}`;
  } catch { return 'unknown'; }
})();
const temporary = mkdtempSync(join(tmpdir(), 'deckent-image-build-'));
let cleanup;
try {
  const endpoint = JSON.parse(run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], 20_000));
  const command = (args, timeout, inherit) => run(['--host', endpoint, ...args], timeout, inherit);
  const tagged = () => { try { return command(['image', 'inspect', tag, '--format', '{{.Id}}'], 20_000); } catch { return null; } };
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
  const alreadyTagged = tagged();
  if (alreadyTagged && alreadyTagged !== existingImage) {
    throw new Error(`WORKER_VERSION_TAKEN: ${tag} already names ${alreadyTagged}. Add a new "# version" line and recipe.imageVersion instead of rebuilding a published version.`);
  }
  if (!existingImage) {
    command(['build', '--pull', '--no-cache', '--build-arg', `BASE_IMAGE=${recipe.baseImage}`,
      '--build-arg', `IMAGE_VERSION=${recipe.imageVersion}`, '--build-arg', `RECIPE_SHA256=${sha256('recipe.json')}`,
      '--build-arg', `SOURCE_REVISION=${sourceRevision}`, '--iidfile', join(temporary, 'image-id'), root], 1_200_000, true);
  }
  const imageId = existingImage ?? readFileSync(join(temporary, 'image-id'), 'utf8').trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('WORKER_IMAGE_ID_INVALID');
  if (command(['image', 'inspect', imageId, '--format', '{{.Id}}'], 20_000) !== imageId) {
    throw new Error('WORKER_IMAGE_ID_MISMATCH');
  }
  const manifest = JSON.parse(command(['run', '--rm', '--cidfile', cidfile, '--pull=never', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--memory-swap=1g',
    '--cpus=2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
    '--mount', `type=bind,src=${join(root, 'inspect.mjs')},dst=/run/deckent-inspect.mjs,readonly`,
    '--mount', `type=bind,src=${join(root, 'recipe.json')},dst=/run/deckent-recipe.json,readonly`,
    '--entrypoint', 'node', imageId, '/run/deckent-inspect.mjs', '/run/deckent-recipe.json'], 90_000));
  if (!existingImage) command(['tag', imageId, tag], 20_000);
  const tagResolvesTo = tagged();
  if (!existingImage && tagResolvesTo !== imageId) throw new Error('WORKER_TAG_MISMATCH');
  const labels = JSON.parse(command(['image', 'inspect', imageId, '--format', '{{json .Config.Labels}}'], 20_000)) ?? {};
  if (!existingImage && labels['org.opencontainers.image.version'] !== recipe.imageVersion) throw new Error('WORKER_LABEL_MISMATCH');
  if (command(['info', '--format', '{{.ID}}'], 20_000) !== daemonId) throw new Error('WORKER_DAEMON_CHANGED');
  const sources = existingImage ? null : Object.fromEntries(['Dockerfile', 'recipe.json', 'install.mjs', 'inspect.mjs', 'history.mjs'].map(name => [name, sha256(name)]));
  writeFileSync(resolve(receipt), JSON.stringify({ schemaVersion: 2, measuredAt: new Date().toISOString(),
    endpoint, daemonId, imageId, repository: recipe.repository, imageVersion: recipe.imageVersion, previousVersion: recipe.previousVersion,
    tag: tagResolvesTo === imageId ? tag : null, labels, sourceRevision: existingImage ? null : sourceRevision, history, sources, manifest,
    inspectionSources: Object.fromEntries(['inspect.mjs', 'recipe.json'].map(name => [name, sha256(name)])), activation: 'not-activated',
    provenance: existingImage ? 'existing-image-reprobed-build-sources-unverified' : 'built-from-current-sources',
    retention: 'Previous versions keep their images, tags and archived receipts (worker-images/archive/); never delete them while any Run or rollback may need them.',
    update: 'Add a new "# version" history line and recipe.imageVersion/previousVersion, re-run the builder, then reference the verified imageId in a new execution profile revision.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ imageId, tag: tagResolvesTo === imageId ? tag : null, imageVersion: recipe.imageVersion, receipt, activation: 'not-activated' }));
} finally { cleanup?.(); rmSync(temporary, { recursive: true, force: true }); }
