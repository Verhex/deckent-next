import { z } from 'zod';
import type { SetupDecision, SetupFamilyPackage, SetupStageContext } from '#engine/index.js';

const state = z.enum(['present', 'none', 'unknown', 'not-run']), count = z.number().int().nonnegative().max(64), cli = z.enum(['found', 'absent', 'unknown']);
/** The coding/git family's facts (I-S2); locale-free and secret-free: sign-ins are present or absent, never read. */
export const codingFactsSchema = z.object({ schemaVersion: z.literal(1), git: cli, gitVersion: z.string().regex(/^[0-9A-Za-z.+~_-]{1,64}$/u).nullable(),
  repository: state, commits: state, productSource: z.boolean(), workTargets: z.object({ configured: count, present: count }).strict(),
  hosts: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), cli, login: cli }).strict()).max(16) }).strict();
export type CodingFacts = z.infer<typeof codingFactsSchema>;
export const CODING_REPOSITORY_STAGE_ID = 'coding:repository', CODING_HOSTS_STAGE_ID = 'coding:hosts';

const reason = (code: string, params: Record<string, string | number> = {}) => ({ code: `setup.coding.${code}`, params });
/** No Git or not a repository: coding work is not set up here (settled; chat, MCP and governed tools do not need it). */
function repository({ facts }: SetupStageContext): SetupDecision {
  const observed = facts as CodingFacts | undefined;
  if (!observed) return { state: 'blocked', reason: reason('unavailable') };
  if (observed.git === 'absent' || observed.repository === 'none') return { state: 'skipped', reason: reason(observed.git === 'absent' ? 'gitMissing' : 'notRepository') };
  if (observed.repository !== 'present' || observed.commits === 'unknown') return { state: 'blocked', reason: reason('repositoryUnknown') };
  if (observed.commits === 'none') return { state: 'blocked', reason: reason('noCommits') };
  // This build's own source checkout: deliveries go to a separate clone (work target), never into the checkout itself.
  return { state: 'done', reason: reason(observed.productSource ? 'productSource' : 'repository', { targets: observed.workTargets.present, version: observed.gitVersion ?? '-' }) };
}
function hosts({ facts }: SetupStageContext): SetupDecision {
  const observed = facts as CodingFacts | undefined;
  if (!observed) return { state: 'blocked', reason: reason('unavailable') };
  const signedIn = observed.hosts.filter(row => row.login === 'found').map(row => row.id), installed = observed.hosts.filter(row => row.cli === 'found').map(row => row.id);
  if (signedIn.length) return { state: 'done', reason: reason('hostsFound', { hosts: signedIn.join(', '), count: signedIn.length }) };
  return { state: 'skipped', reason: installed.length ? reason('hostsInstalled', { hosts: installed.join(', ') }) : reason('hostsNone') };
}
/** The coding/git setup family (INIT ANALYSIS §11(b)): repository facts after the folder stage, coding-CLI sign-ins after the model stage. */
export const codingSetupFamily = (): SetupFamilyPackage => Object.freeze({ namespace: 'coding', source: 'deckent-core', facts: codingFactsSchema.optional(),
  stages: [{ id: CODING_REPOSITORY_STAGE_ID, after: 'core:folder' as const, title: 'setup.coding.repositoryTitle', evaluate: repository },
    { id: CODING_HOSTS_STAGE_ID, after: 'core:model' as const, title: 'setup.coding.hostsTitle', evaluate: hosts }] });
