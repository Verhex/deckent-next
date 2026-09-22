import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { insertHistoryLine, planToolchainUpdate, proposeProfileRevisions, toolchainCatalog, type AffectedProfile, type ProfileRevisionProposal, type ToolchainUpdatePlan } from '#engine/index.js';
import { prepareWorkerImageBuildContext, readWorkerImageSources, runWorkerImageBuild, type WorkerImageBuildRunner } from '#adapters/index.js';
import { inspectConfiguredToolchainCurrency, type NpmLatestVersionFetcher } from './currency.js';

const packageRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const nativeProfileSchema = z.object({ id: z.string(), version: z.number(), parameters: z.object({ imageId: z.string().optional(),
  nativeSubscription: z.object({ provider: z.string(), preflight: z.object({ cliVersion: z.string() }).passthrough().optional() }).passthrough().optional() }).passthrough() }).passthrough();
export type ToolchainUpdateResult = Readonly<{ schemaVersion: 1; mode: string; decision: 'disabled' | 'no-change' | 'planned' | 'built';
  plan: ToolchainUpdatePlan | null; planPath: string | null; build: Readonly<{ context: string; receiptPath: string; imageId: string; tag: string | null }> | null;
  proposal: ProfileRevisionProposal | null; proposalPath: string | null }>;
export interface ToolchainUpdateDependencies { readonly fetcher?: NpmLatestVersionFetcher; readonly runner?: WorkerImageBuildRunner; readonly packageRoot?: string; readonly now?: () => string }

function affectedProfiles(config: Awaited<ReturnType<typeof loadConfig>>): AffectedProfile[] {
  const registry = z.object({ profiles: z.array(z.unknown()) }).passthrough().safeParse(config.admission?.registry);
  if (!registry.success) return [];
  return registry.data.profiles.flatMap(candidate => {
    const profile = nativeProfileSchema.safeParse(candidate); const subscription = profile.success ? profile.data.parameters.nativeSubscription : undefined;
    if (!subscription?.preflight || !(subscription.provider in toolchainCatalog.providers)) return [];
    const imageId = profile.data!.parameters.imageId;
    return [{ profile: { id: profile.data!.id, version: profile.data!.version }, provider: subscription.provider, cliVersion: subscription.preflight.cliVersion, imageId: imageId && /^sha256:[a-f0-9]{64}$/.test(imageId) ? imageId : null }];
  });
}
async function writeArtifact(directory: string, name: string, value: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  return path;
}
/** Policy-driven update: `off` returns disabled; `propose` writes a typed plan only; `auto` (or an explicit apply) also copies the shipped
 * builder into a product-owned context, builds the next image version and writes a receipt plus a profile-revision proposal.
 * Installed config, package bytes and running work are never modified; applying the proposal is a separate installation revision. */
export async function updateConfiguredToolchains(projectRoot: string, input: Readonly<{ apply?: boolean | undefined }> = {}, options: ConfigLoadOptions = {},
  dependencies: ToolchainUpdateDependencies = {}): Promise<ToolchainUpdateResult> {
  const config = await loadConfig(projectRoot, options);
  const policy = config.toolchains.update;
  const now = dependencies.now ?? (() => new Date().toISOString());
  if (policy.mode === 'off') return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'disabled', plan: null, planPath: null, build: null, proposal: null, proposalPath: null });
  const report = await inspectConfiguredToolchainCurrency(projectRoot, options, dependencies.fetcher);
  const root = dependencies.packageRoot ?? packageRoot;
  const sources = await readWorkerImageSources(root);
  const plannedAt = now();
  const plan = planToolchainUpdate({ report, recipe: sources.recipe, plannedAt, affectedProfiles: affectedProfiles(config) });
  const workspaces = await prepareProductDirectory(config.productLayout, 'workspaces');
  const home = join(workspaces, 'toolchains');
  if (plan.decision === 'no-change') return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'no-change', plan, planPath: null, build: null, proposal: null, proposalPath: null });
  const planPath = await writeArtifact(join(home, 'plans'), `${plan.next!.imageVersion}-${plannedAt.replace(/[:.]/g, '-')}.json`, plan);
  if (policy.mode !== 'auto' && !input.apply) return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'planned', plan, planPath, build: null, proposal: null, proposalPath: null });
  const prepared = await prepareWorkerImageBuildContext({ packageRoot: root, parent: join(home, 'builds'), imageVersion: plan.next!.imageVersion,
    dockerfile: insertHistoryLine(sources.dockerfile, plan.next!.historyLine), recipe: plan.next!.recipe });
  await mkdir(join(home, 'receipts'), { recursive: true, mode: 0o700 });
  const receiptPath = join(home, 'receipts', `${plan.next!.imageVersion}.json`);
  const built = await runWorkerImageBuild({ context: prepared.context, receiptPath, timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes,
    env: Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }, dependencies.runner);
  const proposal = proposeProfileRevisions(plan, built.receipt, now());
  const proposalPath = await writeArtifact(join(home, 'proposals'), `${plan.next!.imageVersion}.json`, proposal);
  return Object.freeze({ schemaVersion: 1, mode: policy.mode, decision: 'built', plan, planPath,
    build: { context: prepared.context, receiptPath, imageId: proposal.imageId, tag: proposal.tag }, proposal, proposalPath });
}
