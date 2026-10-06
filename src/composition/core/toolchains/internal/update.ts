import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { selectWorkerLineage, workerImageRecipeSchema, failedContextsToPrune, toolchainUpdateApplies, affectedToolchainProfiles, insertHistoryLine, planToolchainUpdate, proposeProfileRevisions, type ProfileRevisionProposal, type ToolchainUpdatePlan } from '#engine/index.js';
import { assertWorkerImageVersionAvailable, prepareWorkerImageBuildContext, readWorkerImageSources, runWorkerImageBuild, type WorkerImageBuildRunner } from '#adapters/index.js';
import { inspectConfiguredToolchainCurrency, type NpmLatestVersionFetcher } from './currency.js';
const packageRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
export type ToolchainUpdateResult = Readonly<{ schemaVersion: 1; mode: string; decision: 'disabled' | 'no-change' | 'planned' | 'built';
  plan: ToolchainUpdatePlan | null; planPath: string | null; build: Readonly<{ context: string; receiptPath: string; imageId: string; tag: string | null }> | null;
  proposal: ProfileRevisionProposal | null; proposalPath: string | null }>;
export interface ToolchainUpdateDependencies { readonly fetcher?: NpmLatestVersionFetcher; readonly runner?: WorkerImageBuildRunner; readonly packageRoot?: string; readonly now?: () => string;
  /** Ends a running build (the service stopping): the builder process is terminated and the build context is kept as `failed-`. */
  readonly signal?: AbortSignal;
  /** Called once a build is certain (plan written, daemon preflight passed), before its context is created: the refresh's durable `updating` marker. */
  readonly onBuild?: (plan: ToolchainUpdatePlan) => void | Promise<void> }
export async function writeArtifact(directory: string, name: string, value: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  return path;
}
/** The newest build this installation completed and verified: the receipt names the version, and the retained build context holds the exact
 * recipe and Dockerfile that produced it. Anything missing or inconsistent reads as none (the packaged lineage then decides). */
async function readBuiltLineage(home: string): Promise<{ recipe: unknown; dockerfile: string } | null> {
  try {
    const names = (await readdir(join(home, 'receipts'))).filter(name => /^r[1-9][0-9]*-\d{8}\.json$/.test(name))
      .sort((a, b) => Number(/^r(\d+)-/.exec(b)![1]) - Number(/^r(\d+)-/.exec(a)![1]));
    for (const name of names) {
      const version = name.slice(0, -5);
      try {
        const receipt = JSON.parse(await readFile(join(home, 'receipts', name), 'utf8')) as { imageVersion?: unknown; imageId?: unknown };
        const recipe = JSON.parse(await readFile(join(home, 'builds', version, 'recipe.json'), 'utf8')) as unknown;
        const parsed = workerImageRecipeSchema.safeParse(recipe);
        if (receipt.imageVersion !== version || typeof receipt.imageId !== 'string' || !parsed.success || parsed.data.imageVersion !== version) continue;
        return { recipe: parsed.data, dockerfile: await readFile(join(home, 'builds', version, 'Dockerfile'), 'utf8') };
      } catch { continue; }
    }
  } catch { /* no receipts yet */ }
  return null;
}
/** Plan/build with a daemon preflight before artifacts; config/package bytes and running work stay unchanged. */
export async function updateConfiguredToolchains(projectRoot: string, input: Readonly<{ apply?: boolean | undefined }> = {}, options: ConfigLoadOptions = {},
  dependencies: ToolchainUpdateDependencies = {}): Promise<ToolchainUpdateResult> {
  const config = await loadConfig(projectRoot, options);
  const policy = config.toolchains.update;
  const now = dependencies.now ?? (() => new Date().toISOString());
  if (policy.mode === 'off') return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'disabled', plan: null, planPath: null, build: null, proposal: null, proposalPath: null });
  const report = await inspectConfiguredToolchainCurrency(projectRoot, options, dependencies.fetcher);
  const root = dependencies.packageRoot ?? packageRoot; const sources = await readWorkerImageSources(root);
  const plannedAt = now();
  const home = join(await prepareProductDirectory(config.productLayout, 'workspaces'), 'toolchains');
  const lineage = selectWorkerLineage(sources, await readBuiltLineage(home));
  const plan = planToolchainUpdate({ report, recipe: lineage.recipe, plannedAt, affectedProfiles: affectedToolchainProfiles(config) });
  if (plan.decision === 'no-change') return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'no-change', plan, planPath: null, build: null, proposal: null, proposalPath: null });
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const apply = toolchainUpdateApplies(input.apply);
  if (apply) await assertWorkerImageVersionAvailable({ packageRoot: root, imageVersion: plan.next!.imageVersion,
    timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes, env, ...(dependencies.signal ? { signal: dependencies.signal } : {}) }, dependencies.runner);
  const planPath = await writeArtifact(join(home, 'plans'), `${plan.next!.imageVersion}-${plannedAt.replace(/[:.]/g, '-')}.json`, plan);
  if (!apply) return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'planned', plan, planPath, build: null, proposal: null, proposalPath: null });
  await dependencies.onBuild?.(plan);
  const prepared = await prepareWorkerImageBuildContext({ packageRoot: root, parent: join(home, 'builds'), imageVersion: plan.next!.imageVersion,
    dockerfile: insertHistoryLine(lineage.dockerfile, plan.next!.historyLine), recipe: plan.next!.recipe });
  await mkdir(join(home, 'receipts'), { recursive: true, mode: 0o700 });
  const receiptPath = join(home, 'receipts', `${plan.next!.imageVersion}.json`);
  // A failed build keeps its context as evidence under another name, so the next attempt may reuse the planned version.
  const built = await runWorkerImageBuild({ context: prepared.context, receiptPath, timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes,
    env, ...(dependencies.signal ? { signal: dependencies.signal } : {}) }, dependencies.runner).catch(async (error: unknown) => {
      await rename(prepared.context, `${prepared.context}.failed-${Date.now()}`).catch(() => undefined);
      const builds = join(home, 'builds'); // bounded retention: the newest failed contexts stay as evidence
      for (const name of failedContextsToPrune(await readdir(builds).catch(() => []), policy.failedContextsKept)) await rm(join(builds, name), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    });
  const proposal = proposeProfileRevisions(plan, built.receipt, now());
  const proposalPath = await writeArtifact(join(home, 'proposals'), `${plan.next!.imageVersion}.json`, proposal);
  return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'built', plan, planPath,
    build: { context: prepared.context, receiptPath, imageId: proposal.imageId, tag: proposal.tag }, proposal, proposalPath });
}
