import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/index.js';
import { toolchainCurrencyReportSchema, toolchainCatalog, type ToolchainCurrencyReport } from './contract.js';

const imageVersion = z.string().regex(/^r[1-9][0-9]*-\d{8}$/);
/** The installed builder recipe fields this planner reads and rewrites; other fields pass through untouched. */
export const workerImageRecipeSchema = z.object({ schemaVersion: z.literal(2), repository: z.string().min(1), imageVersion,
  previousVersion: imageVersion.nullable(), baseImage: z.string().min(1) }).passthrough();
export type WorkerImageRecipe = z.infer<typeof workerImageRecipeSchema>;
const profileReference = z.object({ id: identitySchema, version: counterSchema.positive() }).strict();
export const affectedProfileSchema = z.object({ profile: profileReference, provider: identitySchema, cliVersion: z.string().min(1),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable() }).strict().readonly();
export type AffectedProfile = z.infer<typeof affectedProfileSchema>;
export const toolchainUpdatePlanSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('toolchain-update-plan'), plannedAt: z.string().datetime(),
  decision: z.enum(['no-change', 'build']), staleProviders: z.array(identitySchema).readonly(), report: toolchainCurrencyReportSchema,
  current: z.object({ imageVersion, repository: z.string() }).strict(),
  next: z.object({ imageVersion, previousVersion: imageVersion, historyLine: z.string().min(1), recipe: workerImageRecipeSchema }).strict().nullable(),
  affectedProfiles: z.array(affectedProfileSchema).readonly(),
  basis: z.string() }).strict().readonly();
export type ToolchainUpdatePlan = z.infer<typeof toolchainUpdatePlanSchema>;
export const profileRevisionProposalSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('profile-revision-proposal'), proposedAt: z.string().datetime(),
  imageVersion, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), tag: z.string().nullable(),
  profiles: z.array(z.object({ profile: profileReference, provider: identitySchema,
    changes: z.object({ cliVersion: z.object({ from: z.string(), to: z.string() }).strict(), imageId: z.object({ from: z.string().nullable(), to: z.string() }).strict() }).strict() }).strict()).readonly(),
  application: z.literal('not-applied'), basis: z.string() }).strict().readonly();
export type ProfileRevisionProposal = z.infer<typeof profileRevisionProposalSchema>;
export class ToolchainUpdateError extends Error {
  constructor(readonly code: 'TOOLCHAIN_RECIPE_INVALID' | 'TOOLCHAIN_HISTORY_INVALID' | 'TOOLCHAIN_RECEIPT_INVALID' | 'TOOLCHAIN_PLAN_INVALID') { super(code); this.name = 'ToolchainUpdateError'; }
}
const HISTORY_LINE = /^# version r[1-9][0-9]*-\d{8} \| /m;
/** Next version id: the numeric counter advances; the date is the planning day. The builder still refuses a taken tag. */
export function nextImageVersion(current: string, plannedAt: string): string {
  const match = /^r([1-9][0-9]*)-\d{8}$/.exec(current);
  if (!match) throw new ToolchainUpdateError('TOOLCHAIN_RECIPE_INVALID');
  return `r${Number(match[1]) + 1}-${plannedAt.slice(0, 10).replaceAll('-', '')}`;
}
/** Inserts the newest history line before the first recorded version line; the builder validates the result against the recipe. */
export function insertHistoryLine(dockerfile: string, line: string): string {
  const index = dockerfile.search(HISTORY_LINE);
  if (index < 0) throw new ToolchainUpdateError('TOOLCHAIN_HISTORY_INVALID');
  return dockerfile.slice(0, index) + line + '\n' + dockerfile.slice(index);
}
/** Pure plan: a build is proposed only when an npm provider is stale; nothing here touches packages, images or config. */
export function planToolchainUpdate(input: Readonly<{ report: ToolchainCurrencyReport; recipe: unknown; plannedAt: string; affectedProfiles: readonly AffectedProfile[] }>): ToolchainUpdatePlan {
  const recipe = workerImageRecipeSchema.safeParse(input.recipe);
  if (!recipe.success) throw new ToolchainUpdateError('TOOLCHAIN_RECIPE_INVALID');
  const stale = input.report.providers.filter(entry => entry.status === 'stale' && entry.mechanism === 'npm').map(entry => entry.provider).sort();
  const affected = input.affectedProfiles.map(item => affectedProfileSchema.parse(item)).filter(item => stale.includes(item.provider));
  const current = { imageVersion: recipe.data.imageVersion, repository: recipe.data.repository };
  const basis = 'stale means an admitted preflight pin is older than the published npm latest tag; the plan proposes one new image version and never edits installed config, package assets or running work';
  if (!stale.length) return toolchainUpdatePlanSchema.parse({ schemaVersion: 1, kind: 'toolchain-update-plan', plannedAt: input.plannedAt, decision: 'no-change', staleProviders: [], report: input.report, current, next: null, affectedProfiles: [], basis });
  const version = nextImageVersion(recipe.data.imageVersion, input.plannedAt);
  const reasons = stale.map(provider => { const entry = input.report.providers.find(item => item.provider === provider)!; return `${provider} ${entry.admitted.map(item => item.version ?? item.cliVersion).join('/')} -> ${entry.latest?.version ?? '?'}`; }).join('; ');
  const historyLine = `# version ${version} | ${input.plannedAt.slice(0, 10)} | base ${recipe.data.baseImage} | supersedes ${recipe.data.imageVersion} | toolchain currency: ${reasons}`;
  const nextRecipe = workerImageRecipeSchema.parse({ ...recipe.data, imageVersion: version, previousVersion: recipe.data.imageVersion });
  return toolchainUpdatePlanSchema.parse({ schemaVersion: 1, kind: 'toolchain-update-plan', plannedAt: input.plannedAt, decision: 'build', staleProviders: stale, report: input.report, current,
    next: { imageVersion: version, previousVersion: recipe.data.imageVersion, historyLine, recipe: nextRecipe }, affectedProfiles: affected, basis });
}
const receiptSchema = z.object({ schemaVersion: z.literal(2), imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), imageVersion, tag: z.string().nullable(),
  manifest: z.object({ providers: z.array(z.object({ id: identitySchema, version: z.string().min(1) }).passthrough()) }).passthrough() }).passthrough();
/** Exact profile changes derived from a build receipt; applying them is a separate installation revision, never done here. */
export function proposeProfileRevisions(plan: ToolchainUpdatePlan, receiptInput: unknown, proposedAt: string): ProfileRevisionProposal {
  const receipt = receiptSchema.safeParse(receiptInput);
  if (!receipt.success || plan.decision !== 'build' || !plan.next || receipt.data.imageVersion !== plan.next.imageVersion) throw new ToolchainUpdateError('TOOLCHAIN_RECEIPT_INVALID');
  const versions = new Map(receipt.data.manifest.providers.map(provider => [provider.id, provider.version]));
  const profiles = plan.affectedProfiles.flatMap(item => {
    if (!(item.provider in toolchainCatalog.providers)) return [];
    const to = versions.get(item.provider);
    if (!to) throw new ToolchainUpdateError('TOOLCHAIN_RECEIPT_INVALID');
    return [{ profile: item.profile, provider: item.provider, changes: { cliVersion: { from: item.cliVersion, to }, imageId: { from: item.imageId, to: receipt.data.imageId } } }];
  });
  return profileRevisionProposalSchema.parse({ schemaVersion: 1, kind: 'profile-revision-proposal', proposedAt, imageVersion: receipt.data.imageVersion, imageId: receipt.data.imageId, tag: receipt.data.tag,
    profiles, application: 'not-applied', basis: 'apply through a new installation profile revision; in-flight Runs keep their imageId; previous image versions remain for rollback' });
}
