import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { toolchainUpdateApplies, affectedToolchainProfiles, insertHistoryLine, planToolchainUpdate, proposeProfileRevisions, type ProfileRevisionProposal, type ToolchainUpdatePlan } from '#engine/index.js';
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
  const plan = planToolchainUpdate({ report, recipe: sources.recipe, plannedAt, affectedProfiles: affectedToolchainProfiles(config) });
  if (plan.decision === 'no-change') return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'no-change', plan, planPath: null, build: null, proposal: null, proposalPath: null });
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const apply = toolchainUpdateApplies(input.apply);
  if (apply) await assertWorkerImageVersionAvailable({ packageRoot: root, imageVersion: plan.next!.imageVersion,
    timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes, env }, dependencies.runner);
  const home = join(await prepareProductDirectory(config.productLayout, 'workspaces'), 'toolchains');
  const planPath = await writeArtifact(join(home, 'plans'), `${plan.next!.imageVersion}-${plannedAt.replace(/[:.]/g, '-')}.json`, plan);
  if (!apply) return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'planned', plan, planPath, build: null, proposal: null, proposalPath: null });
  await dependencies.onBuild?.(plan);
  const prepared = await prepareWorkerImageBuildContext({ packageRoot: root, parent: join(home, 'builds'), imageVersion: plan.next!.imageVersion,
    dockerfile: insertHistoryLine(sources.dockerfile, plan.next!.historyLine), recipe: plan.next!.recipe });
  await mkdir(join(home, 'receipts'), { recursive: true, mode: 0o700 });
  const receiptPath = join(home, 'receipts', `${plan.next!.imageVersion}.json`);
  // A failed build keeps its context as evidence under another name, so the next attempt may reuse the planned version.
  const built = await runWorkerImageBuild({ context: prepared.context, receiptPath, timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes,
    env, ...(dependencies.signal ? { signal: dependencies.signal } : {}) }, dependencies.runner).catch(async (error: unknown) => { await rename(prepared.context, `${prepared.context}.failed-${Date.now()}`).catch(() => undefined); throw error; });
  const proposal = proposeProfileRevisions(plan, built.receipt, now());
  const proposalPath = await writeArtifact(join(home, 'proposals'), `${plan.next!.imageVersion}.json`, proposal);
  return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'built', plan, planPath,
    build: { context: prepared.context, receiptPath, imageId: proposal.imageId, tag: proposal.tag }, proposal, proposalPath });
}
