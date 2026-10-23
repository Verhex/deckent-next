import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorRegistry, loadConfig, prepareProductDirectory, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { selectWorkerLineage, toolchainUpdateApplies, affectedToolchainProfiles, insertHistoryLine, planToolchainUpdate, proposeProfileRevisions, type ProfileRevisionProposal, type ToolchainUpdatePlan } from '#engine/index.js';
import { buildWorkerImageInHome, readBuiltWorkerLineage, readWorkerImageHeldVersion, localPrincipalChannel, readWorkerImageSources, type WorkerImageBuildRunner } from '#adapters/index.js';
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
/** Plan/build. A build floors its counter on the daemon-held revision (installations sharing a daemon share its tags), read before any artifact; config/package bytes and running work stay unchanged. */
export async function updateConfiguredToolchains(projectRoot: string, input: Readonly<{ apply?: boolean | undefined }> = {}, options: ConfigLoadOptions = {},
  dependencies: ToolchainUpdateDependencies = {}): Promise<ToolchainUpdateResult> {
  // Owner 2026-10-09 (MCP read-only by default): the `<host>/mcp` actor may only check. A build/apply is refused before anything is read
  // or written; its check plans in memory without the plan artifact or the toolchains directory. The CLI and terminal are unchanged.
  const mcpCheckOnly = localPrincipalChannel() === 'mcp';
  if (mcpCheckOnly && toolchainUpdateApplies(input.apply)) throw ErrorRegistry.createError('TOOLCHAIN_UPDATE_TERMINAL_ONLY');
  const config = await loadConfig(projectRoot, mcpCheckOnly ? { ...options, heal: false } : options);
  const policy = config.toolchains.update;
  const now = dependencies.now ?? (() => new Date().toISOString());
  if (policy.mode === 'off') return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'disabled', plan: null, planPath: null, build: null, proposal: null, proposalPath: null });
  const report = await inspectConfiguredToolchainCurrency(projectRoot, options, dependencies.fetcher);
  const root = dependencies.packageRoot ?? packageRoot; const sources = await readWorkerImageSources(root);
  const plannedAt = now();
  const home = join(mcpCheckOnly ? productResourcePath(config.productLayout, 'workspaces') : await prepareProductDirectory(config.productLayout, 'workspaces'), 'toolchains');
  const lineage = selectWorkerLineage(sources, await readBuiltWorkerLineage(home));
  const planFor = (heldVersion: string | null) => planToolchainUpdate({ report, recipe: lineage.recipe, plannedAt, affectedProfiles: affectedToolchainProfiles(config), heldVersion });
  const proposed = planFor(null);
  if (proposed.decision === 'no-change') return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'no-change', plan: proposed, planPath: null, build: null, proposal: null, proposalPath: null });
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  if (mcpCheckOnly) return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'planned', plan: proposed, planPath: null, build: null, proposal: null, proposalPath: null });
  const apply = toolchainUpdateApplies(input.apply), signal = dependencies.signal ? { signal: dependencies.signal } : {};
  const plan = apply ? planFor(await readWorkerImageHeldVersion({ packageRoot: root, timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes, env, ...signal }, dependencies.runner)) : proposed;
  const planPath = await writeArtifact(join(home, 'plans'), `${plan.next!.imageVersion}-${plannedAt.replace(/[:.]/g, '-')}.json`, plan);
  if (!apply) return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'planned', plan, planPath, build: null, proposal: null, proposalPath: null });
  await dependencies.onBuild?.(plan);
  // A failed build keeps its context as evidence under another name (bounded retention), so the next attempt may reuse the planned version.
  const built = await buildWorkerImageInHome({ packageRoot: root, home, imageVersion: plan.next!.imageVersion, dockerfile: insertHistoryLine(lineage.dockerfile, plan.next!.historyLine),
    recipe: plan.next!.recipe, timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes, failedContextsKept: policy.failedContextsKept, env, ...signal }, dependencies.runner);
  const proposal = proposeProfileRevisions(plan, built.receipt, now());
  const proposalPath = await writeArtifact(join(home, 'proposals'), `${plan.next!.imageVersion}.json`, proposal);
  return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'built', plan, planPath,
    build: { context: built.context, receiptPath: built.receiptPath, imageId: proposal.imageId, tag: proposal.tag }, proposal, proposalPath });
}
