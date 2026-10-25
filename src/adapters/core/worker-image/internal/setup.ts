import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { failedContextsToPrune, workerImageRecipeSchema, layeredWorkerRecipeSchema, type WorkerImageBuildInput, type WorkerImagePorts } from '#engine/index.js';
import { DockerImageProbeError, probeDockerImageAvailability, runNodeDockerCommand } from '#adapters/core/docker-supervisor/index.js';
import { prepareWorkerImageBuildContext, readWorkerImageHeldVersion, readWorkerImageSources, runWorkerImageBuild, type WorkerImageBuildRunner } from './build.js';
import { resolveWorkerBuildPlan, type WorkerResolution } from './resolve.js';
import limits from './limits.json' with { type: 'json' };

const PACKAGE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u), RECEIPT = /^(?:r[1-9][0-9]*-\d{8}|adopted-\d{1,16})\.json$/u;
const imagePin = z.object({ imageId: digest, providers: z.array(z.string().regex(/^[a-z0-9]{1,32}$/u)).nonempty() }).passthrough();
const receiptSchema = z.object({ schemaVersion: z.union([z.literal(2), z.literal(3)]), imageId: digest, imageVersion: z.string().regex(/^r[1-9][0-9]*-\d{8}$/u),
  images: z.array(imagePin).nonempty().optional(), measuredAt: z.string().datetime() }).passthrough()
  .refine(value => value.schemaVersion === 2 || value.images?.[0]?.imageId === value.imageId);
export type WorkerImagePresence = 'present' | 'missing' | 'unknown';
export type WorkerImageReceiptView = Readonly<{ imageId: string; imageVersion: string; images?: readonly Readonly<{ imageId: string; providers: readonly string[] }>[] }>;

/** Read-only (BR1 1c): whether the daemon behind this Docker CLI holds exactly this image (`image inspect`, the pinned-endpoint probe; never
 * a pull or a container). A non-zero exit is `missing` only when the daemon then answers `info`; any other failure is `unknown`, never a guess. */
export async function workerImagePresence(input: Readonly<{ executable: string; imageId: string; timeoutMs?: number; outputBytes?: number }>): Promise<WorkerImagePresence> {
  const probe = { timeoutMs: limits.probeTimeoutMs, outputBytes: limits.probeOutputBytes, ...input };
  return probeDockerImageAvailability(probe).then(() => 'present' as const, async (error: unknown) => !(error instanceof DockerImageProbeError) || error.probeCause !== 'exit' ? 'unknown'
    : runNodeDockerCommand({ executable: probe.executable, args: ['info', '--format', '{{.ID}}'], timeoutMs: probe.timeoutMs, outputBytes: probe.outputBytes }).then(() => 'missing' as const, () => 'unknown' as const));
}
/** This installation's newest valid build or adoption receipt (`<home>/receipts`, by modification time, then by its own `measuredAt`): regular
 * files only, at most `receiptBytes` each, the newest `receipts` of at most `receiptScan` names. None (or none readable) is null. */
export async function readNewestWorkerReceipt(home: string): Promise<WorkerImageReceiptView | null> {
  const directory = join(home, 'receipts'), names = (await readdir(directory).catch(() => [] as string[])).filter(name => RECEIPT.test(name)).slice(0, limits.receiptScan);
  const files = (await Promise.all(names.map(async name => ({ name, info: await lstat(join(directory, name)).catch(() => null) }))))
    .filter(entry => entry.info?.isFile() && entry.info.size <= limits.receiptBytes).sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs).slice(0, limits.receipts);
  let newest: z.infer<typeof receiptSchema> | null = null;
  for (const { name } of files) {
    const parsed = receiptSchema.safeParse(await readFile(join(directory, name), 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null));
    if (parsed.success && (!newest || parsed.data.measuredAt > newest.measuredAt)) newest = parsed.data;
  }
  return newest && { imageId: newest.imageId, imageVersion: newest.imageVersion, ...(newest.schemaVersion === 3 ? { images: newest.images! } : {}) };
}
/** The setup family's worker facts: the configured image, else the newest receipt's, checked read-only against the daemon behind `executable`. */
export async function observeWorkerImage(input: Readonly<{ home: string; executable: string | null; configured: string | null; git: string | null }>) {
  const receipt = await readNewestWorkerReceipt(input.home), target = input.configured ?? receipt?.imageId ?? null;
  const image = input.executable && target ? await workerImagePresence({ executable: input.executable, imageId: target }) : 'not-run' as const;
  return { configured: input.configured, receipt, image, git: input.git };
}

/** The newest build this installation completed and verified: the receipt names the version, and the retained build context holds the exact
 * recipe and Dockerfile that produced it. Anything missing or inconsistent reads as none (the packaged lineage then decides). */
export async function readBuiltWorkerLineage(home: string): Promise<{ recipe: unknown; dockerfile: string } | null> {
  try {
    const names = (await readdir(join(home, 'receipts'))).filter(name => /^r[1-9][0-9]*-\d{8}\.json$/.test(name))
      .sort((a, b) => Number(/^r(\d+)-/.exec(b)![1]) - Number(/^r(\d+)-/.exec(a)![1]));
    for (const name of names) {
      const version = name.slice(0, -5);
      try {
        const receipt = JSON.parse(await readFile(join(home, 'receipts', name), 'utf8')) as { imageVersion?: unknown; imageId?: unknown };
        const recipe = JSON.parse(await readFile(join(home, 'builds', version, 'recipe.json'), 'utf8')) as unknown;
        const parsed = workerImageRecipeSchema.safeParse(recipe);
        if (receipt.imageVersion !== version || typeof receipt.imageId !== 'string' || !parsed.success || parsed.data.schemaVersion === 2 && parsed.data.imageVersion !== version) continue;
        // Preserve the packaged key ordering too: the existing lineage equality compares the serialized source recipe.
        return { recipe: { ...recipe as object, imageVersion: version }, dockerfile: await readFile(join(home, 'builds', version, 'history.log'), 'utf8') };
      } catch { continue; }
    }
  } catch { /* no receipts yet */ }
  return null;
}
type HomeBuild = WorkerImageBuildInput & Readonly<{ packageRoot: string; home: string; timeoutMs: number; outputBytes: number; failedContextsKept: number;
  npmrcSecret?: string; resolution?: WorkerResolution; env?: Readonly<Record<string, string>>; signal?: AbortSignal; replace?: boolean }>;
/**
 * One build (or, with `imageId`, one adoption re-probe) in an installation's toolchains home: an exclusive private context under `builds/`
 * (`adopted/`), the receipt under `receipts/`. A failed build keeps its context as `.failed-<ms>` (the newest `failedContextsKept` stay).
 * `replace` (first image, BR1): a context or receipt an earlier half-done attempt left for this version is kept the same way first.
 */
export async function buildWorkerImageInHome(input: HomeBuild, runner?: WorkerImageBuildRunner) {
  const recipe = layeredWorkerRecipeSchema.parse(input.recipe);
  const previous = await readNewestWorkerReceipt(input.home);
  const priorBase = previous && await readFile(join(input.home, 'receipts', `${previous.imageVersion}.json`), 'utf8')
    .then(text => (JSON.parse(text) as { base?: { refreshKey?: string } }).base?.refreshKey).catch(() => undefined);
  const plan = input.imageId ? { schemaVersion: 1, adopt: true, imageVersion: input.imageVersion, buildTimeoutMs: input.timeoutMs }
    : await resolveWorkerBuildPlan(recipe, input.imageVersion, input.timeoutMs, { ...input.resolution, ...(priorBase ? { previousRefreshKey: priorBase } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  const builds = join(input.home, input.imageId ? 'adopted' : 'builds'), receipts = join(input.home, 'receipts'), keep = (path: string) => rename(path, `${path}.failed-${Date.now()}`).catch(() => undefined);
  const receiptPath = join(receipts, input.imageId ? `adopted-${Date.now()}.json` : `${input.imageVersion}.json`);
  if (input.replace) { await keep(join(builds, input.imageVersion)); await keep(receiptPath); }
  const history = !input.imageId && 'base' in plan ? input.dockerfile.replace(new RegExp(`^(# version ${input.imageVersion} \\| [^|]+ \\| base )\\S+`, 'mu'), `$1${plan.base.image}`) : input.dockerfile;
  const prepared = await prepareWorkerImageBuildContext({ packageRoot: input.packageRoot, parent: builds, imageVersion: input.imageVersion, dockerfile: history, recipe: input.recipe, plan });
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const built = await runWorkerImageBuild({ context: prepared.context, receiptPath, timeoutMs: input.timeoutMs * ('images' in plan ? plan.images.length + 1 : 1), outputBytes: input.outputBytes, ...(input.env ? { env: input.env } : {}),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.imageId ? { imageId: input.imageId } : {}), ...(input.npmrcSecret ? { npmrcSecret: input.npmrcSecret } : {}) }, runner).catch(async (error: unknown) => {
    await keep(prepared.context);
    for (const name of failedContextsToPrune(await readdir(builds).catch(() => []), input.failedContextsKept)) await rm(join(builds, name), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  });
  return Object.freeze({ context: prepared.context, receiptPath, ...built });
}
/** The engine owner's ports over the installed package (`packageRoot`, default: this build's own) and one Docker CLI (`executable`); the card is the surface's. */
export function workerImageSetupPorts(input: Readonly<{ home: string; executable: string; env: Readonly<Record<string, string>>; timeoutMs: number; outputBytes: number;
  failedContextsKept: number; packageRoot?: string; resolution?: WorkerResolution }>, runner?: WorkerImageBuildRunner): Omit<WorkerImagePorts, 'confirm'> {
  const packageRoot = input.packageRoot ?? PACKAGE_ROOT, bounds = { timeoutMs: input.timeoutMs, outputBytes: input.outputBytes };
  return { sources: () => readWorkerImageSources(packageRoot), held: async () => {
    const daemon = await readWorkerImageHeldVersion({ packageRoot, ...bounds, env: input.env }, runner);
    const counter = (value: string | null | undefined) => Number(/^r([0-9]+)-/u.exec(value ?? '')?.[1] ?? 0);
    let held = daemon;
    const directory = join(input.home, 'receipts'), names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names.filter(name => RECEIPT.test(name)).slice(0, limits.receiptScan)) {
      const file = join(directory, name), info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.size > limits.receiptBytes) continue;
      const receipt = receiptSchema.safeParse(await readFile(file, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => null));
      if (receipt.success && counter(receipt.data.imageVersion) > counter(held)) held = receipt.data.imageVersion;
    }
    return held;
  },
    receipt: async () => { const found = await readNewestWorkerReceipt(input.home); return found && await workerImagePresence({ executable: input.executable, imageId: found.imageId }) === 'present' ? found : null; },
    build: plan => buildWorkerImageInHome({ ...plan, ...bounds, ...(input.resolution ? { resolution: input.resolution } : {}), packageRoot, home: input.home, failedContextsKept: input.failedContextsKept, env: input.env, replace: true }, runner) };
}
