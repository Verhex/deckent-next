import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, writeSync, mkdtempSync, rmSync, existsSync, statSync, accessSync, lstatSync, realpathSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateRecipe, validatePlan, parseVersionHistory, assertVersionAdvances, heldVersion, adoptionProvenance } from './history.mjs';
import { retainedWorkerHistory } from './receipts.mjs';
import { baseDockerfile, imageDockerfile, imageTag } from './layers.mjs';

// Explicit build/adopt operation over one private build context (recipe schema 3, U6 §4/§12): the shipped recipe.json, lineage.json and
// history.log, plus the product's plan.json (version, images, resolved install inputs). It builds the shared base, then each planned image
// FROM it, probes every image with no network, tags `<baseRepository>:<version>` and `<repository>:<version>-<providers>`, and writes one
// receipt. Never mutates runtime profiles, running containers or old images; old images, tags and receipts are retained, nothing is deleted.
// F4 (TEMIZ-KURULUM-2026-10-16): a known refusal is one `Error: WORKER_<CODE>: <detail>` line and exit 1, never a stack trace. The
// product maps that line to its localized EN/TR error (WorkerImageBuildError); anything else is a defect and keeps its stack.
process.on('uncaughtException', error => {
  writeSync(2, /^WORKER_[A-Z_]+(?::|$)/.test(error?.message ?? '') ? `Error: ${error.message}\n` : `${error?.stack ?? error}\n`);
  process.exit(1);
});
const root = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const secretIndex = argv.indexOf('--npmrc-secret');
const npmrcSecret = secretIndex < 0 ? null : argv[secretIndex + 1];
if (secretIndex >= 0) argv.splice(secretIndex, 2);
const [receipt, option, existingImage, ...extra] = argv;
if (secretIndex >= 0) {
  const info = npmrcSecret && isAbsolute(npmrcSecret) ? lstatSync(npmrcSecret) : null;
  if (!info?.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || realpathSync(npmrcSecret) !== npmrcSecret
    || npmrcSecret.startsWith(root + '/')) throw new Error('WORKER_IMAGE_SOURCE_CREDENTIALS_REFUSED');
}
const identityCheck = receipt === '--daemon-identity';
const heldCheck = receipt === '--held-version' || identityCheck;
if (heldCheck && ((option !== undefined && (identityCheck || !isAbsolute(option))) || (option === undefined ? existingImage !== undefined || extra.length : extra.length !== 1))) throw new Error('WORKER_RECIPE_VERSION: --held-version takes no arguments.');
if (!heldCheck) {
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
}
const sha256 = name => createHash('sha256').update(readFileSync(join(root, name))).digest('hex');
const readJson = name => { try { return JSON.parse(readFileSync(join(root, name), 'utf8')); } catch { return null; } };
const recipe = validateRecipe(readJson('recipe.json'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].includes(key)));
/** One docker call. A build's output is captured, replayed (the runner's bounded evidence) and searched for an installer's typed refusal. */
const run = (args, timeout, build = false) => {
  const result = spawnSync('docker', args, { env, timeout: Math.max(1, timeout), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (build) { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
  if (result.error || result.status !== 0) {
    const reason = build ? /WORKER_[A-Z_]+(?::[^\n]*)?/.exec(`${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').filter(line => /Error: WORKER_/.test(line)).pop() ?? '') : null;
    throw new Error(reason?.[0] ?? `WORKER_IMAGE_COMMAND_FAILED:${args[0] === '--host' ? args[2] : args[0]}`);
  }
  return result.stdout?.trim();
};
const endpointOf = () => JSON.parse(run(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], 20_000));
const rawReceiptBounds = () => { const bounds = { files: Number(existingImage), bytes: Number(extra[0]) }; if (![bounds.files, bounds.bytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('WORKER_HISTORY_IDS'); return bounds; };
const tagsOf = (command, repository) => command(['image', 'ls', repository, '--format', '{{.Tag}}'], 20_000).split('\n');
// Read-only preflight from the installed assets (no plan, no context): the highest revision the daemon holds over both repositories, so the
// planner floors its one shared counter on it; the eventual build still refuses a counter another installation took meanwhile.
if (heldCheck) {
  const endpoint = endpointOf(), command = (args, timeout) => run(['--host', endpoint, ...args], timeout);
  if (identityCheck) { writeSync(1, JSON.stringify({ endpoint, daemonId: command(['info', '--format', '{{.ID}}'], 20_000) }) + '\n'); process.exit(0); }
  writeSync(1, JSON.stringify({ heldVersion: heldVersion([... [recipe.repository, recipe.baseRepository].flatMap(name => tagsOf(command, name)), ...(option ? retainedWorkerHistory(join(option, 'receipts'), command(['info', '--format', '{{.ID}}'], 20_000), rawReceiptBounds()) : [])]) }) + '\n');
  process.exit(0);
}
const rawPlan = readJson('plan.json');
const adopt = existingImage !== undefined;
if (adopt && (!Number.isSafeInteger(rawPlan?.buildTimeoutMs) || rawPlan.buildTimeoutMs <= 0 || rawPlan?.schemaVersion !== 1 || rawPlan.adopt !== true || !/^r[1-9][0-9]*-\d{8}$/.test(rawPlan.imageVersion ?? ''))) throw new Error('WORKER_PLAN_INVALID: an adoption needs its plan.json');
const plan = adopt ? rawPlan : validatePlan(rawPlan, recipe);
const history = adopt ? null : parseVersionHistory(readFileSync(join(root, 'history.log'), 'utf8'), plan);
const recipeSha256 = sha256('recipe.json');
const lineage = readJson('lineage.json');
if (readJson('lineage.lock.json')?.sha256 !== sha256('lineage.json')) throw new Error('WORKER_LINEAGE_INVALID');
const listed = Array.isArray(lineage?.recipes) && lineage.recipes.some(entry => entry?.sha256 === recipeSha256);
if (!listed) throw new Error('WORKER_LINEAGE_INVALID');
const sourceRevision = (() => {
  try {
    const git = args => spawnSync('git', ['-C', root, ...args], { env, timeout: 5_000, encoding: 'utf8' });
    const head = git(['rev-parse', '--short', 'HEAD']); const dirty = git(['status', '--short', '--', root]);
    if (head.status !== 0 || dirty.status !== 0) return 'unknown';
    return `${head.stdout.trim()}${dirty.stdout.trim() ? '-dirty' : ''}`;
  } catch { return 'unknown'; }
})();
if (!Number.isSafeInteger(plan.totalBudgetMs) || plan.totalBudgetMs < plan.buildTimeoutMs) throw new Error('WORKER_PLAN_INVALID');
const started = Date.now();
const deadline = started + plan.totalBudgetMs;
const left = () => deadline - Date.now();
const temporary = mkdtempSync(join(tmpdir(), 'deckent-image-build-'));
const cidfiles = [];
let cleanup;
try {
  const endpoint = endpointOf();
  const command = (args, timeout, build) => run(['--host', endpoint, ...args], timeout, build);
  const idOf = reference => { try { return command(['image', 'inspect', reference, '--format', '{{.Id}}'], 20_000); } catch { return null; } };
  cleanup = () => {
    for (const cidfile of cidfiles.filter(existsSync)) {
      const id = readFileSync(cidfile, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(id)) spawnSync('docker', ['--host', endpoint, 'rm', '--force', id], { env, timeout: 20_000, stdio: 'ignore' });
    }
  };
  /** A short hardened container on a local image with no network and a read-only root (the probe, and the base's package list). */
  const container = (image, entrypoint, args, mounts = []) => {
    const cidfile = join(root, `probe-${cidfiles.length}.cid`); cidfiles.push(cidfile);
    return command(['run', '--rm', '--label', `dev.deckent.worker.probe=${plan.probeOwner}`, '--cidfile', cidfile, '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=128', '--memory=1g', '--memory-swap=1g', '--cpus=2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456',
      ...mounts.flatMap(([source, target]) => ['--mount', `type=bind,src=${join(root, source)},dst=${target},readonly`]), '--entrypoint', entrypoint, image, ...args], Math.min(90_000, left()));
  };
  const probe = (image, providers) => JSON.parse(container(image, 'node', ['/run/deckent-inspect.mjs', '/run/deckent-recipe.json', providers.join(',')],
    [['inspect.mjs', '/run/deckent-inspect.mjs'], ['recipe.json', '/run/deckent-recipe.json']]));
  const labelsOf = image => JSON.parse(command(['image', 'inspect', image, '--format', '{{json .Config.Labels}}'], 20_000)) ?? {};
  const daemonId = command(['info', '--format', '{{.ID}}'], 20_000);
  let images, base = null; const timings = { images: [] };
  if (!adopt) {
    const baseTag = imageTag(recipe.baseRepository, plan.imageVersion);
    const targets = plan.images.map(providers => imageTag(recipe.repository, plan.imageVersion, providers));
    for (const tag of [baseTag, ...targets]) {
      const taken = idOf(tag);
      if (taken) throw new Error(`WORKER_VERSION_TAKEN: ${tag} already names ${taken}. Plan a new version instead of rebuilding a published one, or re-verify that image with --image-id ${taken}.`);
    }
    // Same-home receipts retain the counter even when an image was removed. S3 supplies the shared daemon receipt location and lock.
    const bounds = plan.receiptLimits;
    if (!Number.isSafeInteger(bounds?.files) || bounds.files <= 0 || !Number.isSafeInteger(bounds?.bytes) || bounds.bytes <= 0) throw new Error('WORKER_PLAN_INVALID');
    const receiptVersions = retainedWorkerHistory(dirname(receipt), daemonId, bounds);
    if (plan.reservation) {
      if (plan.reservation.daemonId !== daemonId || plan.reservation.version !== plan.imageVersion
        || !Number.isSafeInteger(plan.reservation.floor) || Number(/^r([0-9]+)/.exec(plan.imageVersion)[1]) <= plan.reservation.floor) throw new Error('WORKER_HISTORY_COUNTER');
      receiptVersions.push(`r${plan.reservation.floor || 1}-00000000`);
    }
    assertVersionAdvances(plan.imageVersion, [...receiptVersions, ...[recipe.repository, recipe.baseRepository].flatMap(name => tagsOf(command, name))]);
    // The in-build proxy is a predefined build argument: Docker leaves it out of `docker history` and the cache key (Dockerfile reference,
    // "Predefined ARGs"); the plan already refused a proxy URL with credentials. Base pulls use the daemon's own proxy configuration.
    const proxy = plan.proxy ? ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].flatMap(name => ['--build-arg', `${name}=${plan.proxy}`]) : [];
    const progress = step => writeFileSync(join(root, 'progress.json'), JSON.stringify({ step, at: new Date().toISOString() }), { mode: 0o600 });
    const buildOne = (name, text, pull) => {
      progress(name === 'Dockerfile.base' ? 'base' : `layer:${plan.images[Number(/image-(\d+)/.exec(name)[1]) - 1][0]}`);
      writeFileSync(join(root, name), text, { flag: 'wx', mode: 0o600 });
      const iidfile = join(temporary, `${name}.id`), at = Date.now();
      command(['build', ...(pull ? ['--pull'] : []), ...proxy, ...(npmrcSecret ? ['--secret', `id=worker-npmrc,src=${npmrcSecret}`] : []), '--progress=plain', '-f', join(root, name), '--iidfile', iidfile, root], Math.min(plan.buildTimeoutMs, left()), true);
      const id = readFileSync(iidfile, 'utf8').trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(id) || idOf(id) !== id) throw new Error('WORKER_IMAGE_ID_INVALID');
      return { id, ms: Date.now() - at };
    };
    const tagAs = (id, tag) => { command(['tag', id, tag], 20_000); if (idOf(tag) !== id) throw new Error('WORKER_TAG_MISMATCH'); };
    const builtBase = buildOne('Dockerfile.base', baseDockerfile(recipe, plan), plan.base.pull);
    tagAs(builtBase.id, baseTag); timings.base = builtBase.ms;
    base = { imageId: builtBase.id, tag: baseTag, from: plan.base.image, pulled: plan.base.pull,
      refreshKey: plan.refreshKey, repoDigests: JSON.parse(command(['image', 'inspect', plan.base.image, '--format', '{{json .RepoDigests}}'], 20_000)) ?? [],
      packages: container(builtBase.id, 'dpkg-query', ['-W', '-f=${Package}=${Version}\\n']).split('\n').filter(Boolean) };
    images = plan.images.map((providers, index) => {
      const built = buildOne(`Dockerfile.image-${index + 1}`, imageDockerfile(recipe, plan, providers, { recipeSha256, sourceRevision, secret: npmrcSecret !== null }), false);
      progress('probe');
      const manifest = probe(built.id, providers);
      tagAs(built.id, targets[index]); timings.images.push(built.ms);
      const labels = labelsOf(built.id);
      if (labels['org.opencontainers.image.version'] !== plan.imageVersion || labels['dev.deckent.worker.provider'] !== providers.join(',')
        || labels['dev.deckent.worker.recipe.sha256'] !== recipeSha256) throw new Error('WORKER_LABEL_MISMATCH');
      return { providers, imageId: built.id, tag: targets[index], labels, manifest };
    });
  } else {
    if (idOf(existingImage) !== existingImage) throw new Error('WORKER_IMAGE_ID_MISMATCH');
    const labels = labelsOf(existingImage), named = (labels['dev.deckent.worker.provider'] ?? '').split(',').filter(Boolean);
    // A schema 3 image names its providers; an older image carries every recipe provider. Label equality is lineage evidence, not proof of
    // build (a local daemon is root-equivalent, the accepted boundary): the receipt says `adopted-label-matched`, never `built-from-current-sources`.
    const providers = named.length && named.every(id => recipe.providers.some(entry => entry.id === id)) ? named : recipe.providers.map(entry => entry.id);
    const version = /^r[1-9][0-9]*-\d{8}$/.test(labels['org.opencontainers.image.version'] ?? '') ? labels['org.opencontainers.image.version'] : null;
    images = [{ providers, imageId: existingImage, tag: null, labels, manifest: probe(existingImage, providers),
      provenance: adoptionProvenance(labels, lineage, recipe.providers.map(entry => entry.id)), version }];
  }
  if (command(['info', '--format', '{{.ID}}'], 20_000) !== daemonId) throw new Error('WORKER_DAEMON_CHANGED');
  const imageVersion = adopt ? images[0].version ?? plan.imageVersion : plan.imageVersion;
  const files = ['recipe.json', 'plan.json', 'history.log', 'lineage.json', 'lineage.lock.json', 'build.mjs', 'history.mjs', 'receipts.mjs', 'recover.mjs', 'layers.mjs', 'install.mjs', 'inspect.mjs',
    ...(adopt ? [] : ['Dockerfile.base', ...plan.images.map((_, index) => `Dockerfile.image-${index + 1}`)])];
  writeFileSync(resolve(receipt), JSON.stringify({ schemaVersion: 3, measuredAt: new Date().toISOString(), endpoint, daemonId,
    repository: recipe.repository, baseRepository: recipe.baseRepository, imageVersion, previousVersion: adopt ? null : plan.previousVersion,
    // The default image: the first image of the plan. `execution.docker.imageId` falls back to it where no profile pins its own (U6 §13 point 5).
    imageId: images[0].imageId, tag: images[0].tag,
    images: images.map(({ providers, imageId, tag, labels, manifest }) => ({ providers, imageId, tag, tagVersion: tag?.split(':').pop() ?? null, labels, manifest })), base,
    install: adopt ? null : { providers: plan.providers, npmRegistry: plan.npmRegistry ?? null, proxy: plan.proxy, secretMountUsed: npmrcSecret !== null }, buildTimeoutMs: adopt ? null : plan.buildTimeoutMs,
    recipeSha256, lineage: listed ? 'listed' : 'unlisted', sourceRevision: adopt ? null : sourceRevision, history,
    sources: Object.fromEntries(files.filter(name => existsSync(join(root, name))).map(name => [name, sha256(name)])),
    timings: { ...timings, totalMs: Date.now() - started }, activation: 'not-activated',
    provenance: adopt ? images[0].provenance : 'built-from-current-sources',
    retention: 'Previous versions keep their images, tags and receipts; never delete them while any Run or rollback may need them.',
    update: 'A newer recipe or toolchain plans the next version (deckent toolchains update --apply); reference its imageId in a new execution profile revision.' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ imageId: images[0].imageId, tag: images[0].tag, imageVersion, receipt, activation: 'not-activated' }));
} finally { cleanup?.(); rmSync(temporary, { recursive: true, force: true }); }
