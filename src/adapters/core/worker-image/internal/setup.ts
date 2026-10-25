import { lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { failedContextsToPrune, workerImageRecipeSchema, layeredWorkerRecipeSchema, workerImageBudget, type WorkerImageBuildInput, type WorkerImagePorts } from '#engine/index.js';
import { DockerImageProbeError, probeDockerImageAvailability, runNodeDockerCommand } from '#adapters/core/docker-supervisor/index.js';
import { prepareWorkerImageBuildContext, readWorkerImageHeldVersion, readWorkerImageSources, runWorkerImageBuild, type WorkerImageBuildRunner } from './build.js';
import { resolveWorkerBuildPlan, type WorkerResolution } from './resolve.js';
import type { WorkerReservation } from './custody.js';
import limits from './limits.json' with { type: 'json' };

const PACKAGE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u), RECEIPT = /^(?:r[1-9][0-9]*-\d{8}|adopted-\d{1,16})\.json$/u;
const imagePin = z.object({ imageId: digest, providers: z.array(z.string().regex(/^[a-z0-9]{1,32}$/u)).nonempty() }).passthrough();
const receiptSchema = z.object({ schemaVersion: z.union([z.literal(2), z.literal(3)]), imageId: digest, imageVersion: z.string().regex(/^r[1-9][0-9]*-\d{8}$/u),
  images: z.array(imagePin).nonempty().optional(), measuredAt: z.string().datetime() }).passthrough()
  .refine(value => value.schemaVersion === 2 || value.images?.[0]?.imageId === value.imageId);
export type WorkerImagePresence = 'present' | 'missing' | 'unknown';
export type WorkerImageReceiptView = Readonly<{ imageId: string; imageVersion: string; images?: readonly Readonly<{ imageId: string; providers: readonly string[] }>[] }>;

/** Exact image presence; daemon uncertainty never means missing. */
export async function workerImagePresence(input: Readonly<{ executable: string; imageId: string; timeoutMs?: number; outputBytes?: number }>): Promise<WorkerImagePresence> {
  const probe = { timeoutMs: limits.probeTimeoutMs, outputBytes: limits.probeOutputBytes, ...input };
  return probeDockerImageAvailability(probe).then(() => 'present' as const, async (error: unknown) => !(error instanceof DockerImageProbeError) || error.probeCause !== 'exit' ? 'unknown'
    : runNodeDockerCommand({ executable: probe.executable, args: ['info', '--format', '{{.ID}}'], timeoutMs: probe.timeoutMs, outputBytes: probe.outputBytes }).then(() => 'missing' as const, () => 'unknown' as const));
}
/** Newest bounded regular build/adoption receipt. */
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
/** Observed fallback image and receipt, without effects. */
export async function observeWorkerImage(input: Readonly<{ home: string; executable: string | null; configured: string | null; git: string | null }>) {
  const receipt = await readNewestWorkerReceipt(input.home), target = input.configured ?? receipt?.imageId ?? null;
  const image = input.executable && target ? await workerImagePresence({ executable: input.executable, imageId: target }) : 'not-run' as const;
  return { configured: input.configured, receipt, image, git: input.git };
}

/** Newest consistent retained build lineage; missing evidence is not lineage. */
export async function readBuiltWorkerLineage(home: string): Promise<{ recipe: unknown; dockerfile: string } | null> {
  const names = (await readdir(join(home, 'receipts')).catch(() => [] as string[])).filter(name => /^r[1-9][0-9]*-\d{8}\.json$/u.test(name))
    .sort((a, b) => Number(/^r(\d+)-/u.exec(b)![1]) - Number(/^r(\d+)-/u.exec(a)![1]));
  for (const name of names) {
    try {
      const version = name.slice(0, -5), receipt = JSON.parse(await readFile(join(home, 'receipts', name), 'utf8')) as { imageVersion?: unknown; imageId?: unknown };
      const recipe = JSON.parse(await readFile(join(home, 'builds', version, 'recipe.json'), 'utf8')) as unknown, parsed = workerImageRecipeSchema.safeParse(recipe);
      if (receipt.imageVersion !== version || typeof receipt.imageId !== 'string' || !parsed.success || parsed.data.schemaVersion === 2 && parsed.data.imageVersion !== version) continue;
      return { recipe: { ...recipe as object, imageVersion: version }, dockerfile: await readFile(join(home, 'builds', version, 'history.log'), 'utf8') };
    } catch { /* A missing/inconsistent build cannot provide lineage. */ }
  }
  return null;
}

type HomeBuild = WorkerImageBuildInput & Readonly<{ packageRoot: string; home: string; timeoutMs: number; outputBytes: number; failedContextsKept: number;
  npmrcSecret?: string; reservation?: WorkerReservation; onContext?: (context: string) => Promise<void>; resolution?: WorkerResolution; env?: Readonly<Record<string, string>>; signal?: AbortSignal; replace?: boolean }>;
/** Private build context and receipt; failed contexts are retained within policy bounds. */
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
  const prepared = await prepareWorkerImageBuildContext({ packageRoot: input.packageRoot, parent: builds, imageVersion: input.imageVersion, dockerfile: history, recipe: input.recipe, plan: { ...plan, ...(input.reservation ? { reservation: input.reservation } : {}), totalBudgetMs: input.imageId ? input.timeoutMs : workerImageBudget(input.timeoutMs, 'images' in plan ? plan.images.length : 1) } });
  await input.onContext?.(prepared.context);
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const built = await runWorkerImageBuild({ context: prepared.context, receiptPath, timeoutMs: input.imageId ? input.timeoutMs : workerImageBudget(input.timeoutMs, 'images' in plan ? plan.images.length : 1), outputBytes: input.outputBytes, ...(input.env ? { env: input.env } : {}),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.imageId ? { imageId: input.imageId } : {}), ...(input.npmrcSecret ? { npmrcSecret: input.npmrcSecret } : {}) }, runner).catch(async (error: unknown) => {
    await keep(prepared.context);
    for (const name of failedContextsToPrune(await readdir(builds).catch(() => []), input.failedContextsKept)) await rm(join(builds, name), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  });
  return Object.freeze({ context: prepared.context, receiptPath, ...built });
}
/** Foreground setup ports over the installed builder. */
export function workerImageSetupPorts(input: Readonly<{ home: string; executable: string; env: Readonly<Record<string, string>>; timeoutMs: number; outputBytes: number;
  failedContextsKept: number; packageRoot?: string; resolution?: WorkerResolution }>, runner?: WorkerImageBuildRunner): Omit<WorkerImagePorts, 'confirm'> {
  const packageRoot = input.packageRoot ?? PACKAGE_ROOT, bounds = { timeoutMs: input.timeoutMs, outputBytes: input.outputBytes };
  return { sources: () => readWorkerImageSources(packageRoot), held: () => readWorkerImageHeldVersion({ packageRoot, home: input.home, ...bounds, env: input.env }, runner),
    receipt: async () => { const found = await readNewestWorkerReceipt(input.home); return found && await workerImagePresence({ executable: input.executable, imageId: found.imageId }) === 'present' ? found : null; },
    build: plan => buildWorkerImageInHome({ ...plan, ...bounds, ...(input.resolution ? { resolution: input.resolution } : {}), packageRoot, home: input.home, failedContextsKept: input.failedContextsKept, env: input.env, replace: true }, runner) };
}
