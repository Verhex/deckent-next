import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { FileInstallationIdentityStore, FileProjectIdentityStore, withInstallationJournal } from '#adapters/index.js';
import { immutableJsonObjectSchema } from '#domain/index.js';
import { InstallationPublicationApplication, InstallationPublicationError, validateInstallationRecovery, type InstallationConsent, type InstallationRecovery, type PreparedInstallation } from '#engine/index.js';
import { bootstrapPublishesConfig, getConfigFieldDefault, observeBootstrapState, SystemTrustedClock, validateConfig, versionedConfig, resolveProductLayout, type BootstrapObservation } from '#platform/index.js';
import { prepareSuppliedInstallation } from './preview.js';
import { inspectPreparedInstallation } from './evidence.js';
import { installationPublicationPorts } from './publication.js';
import { loadConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
const choicesSchema = z.object({ allowShutdown: z.boolean(), dockerExecutable: z.string().min(1).refine(isAbsolute),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), acceptCustom: z.literal(true) }).strict().readonly();
export type InstallationApplyChoices = z.infer<typeof choicesSchema>;
function choices(input: unknown): InstallationApplyChoices {
  const safe = immutableJsonObjectSchema.safeParse(input), parsed = safe.success ? choicesSchema.safeParse(safe.data) : null;
  if (!parsed?.success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return parsed.data;
}
function retained(observed: BootstrapObservation): InstallationRecovery | null {
  if (!observed.record) return null;
  // Structural read only: the engine cross-validates recovery against preparation and current identity before publication.
  const schema = z.object({ material: z.object({ authoredProfile: immutableJsonObjectSchema,
    configuration: immutableJsonObjectSchema, allowShutdown: z.boolean() }).passthrough(),
    consent: z.object({ id: z.string().min(1), atMs: z.number().int().nonnegative().safe() }).passthrough() }).passthrough();
  if (!schema.safeParse(observed.record.recovery).success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return observed.record.recovery as unknown as InstallationRecovery;
}
/** ID-1C before any effect of an owned init mutation: the configured identity, by the CLI preflight's own observe-only read (also under a pending policy-template journal,
 * which leaves config settled). A pending config-publishing transaction reads its target layout under the journal; `publicationGuarded` (apply/resume): invalid config is never published over. */
export async function assertConfiguredInstallationIdentity(projectRoot: string, publicationGuarded = false) {
  if (bootstrapPublishesConfig(await observeBootstrapState(projectRoot), projectRoot)) return;
  await loadConfiguredInstallationIdentity(projectRoot, { pendingBootstrap: 'config-settled' }).catch(error => { if (!publicationGuarded || (error as { code?: unknown }).code !== 'CONFIG_VALIDATION') throw error; });
}
/** Explicit local operator action. No model, worker, or supplied profile can grant consent. */
export async function applySuppliedInstallation(projectRoot: string, supplied: unknown, input: InstallationApplyChoices) {
  const operator = choices(input); await assertConfiguredInstallationIdentity(projectRoot, true); // Snapshot and validate before the lock or bootstrap directory.
  const initial = await prepareSuppliedInstallation(projectRoot, supplied, operator); await preflightEvidence(initial, operator);
  return executeInstallation(projectRoot, operator, lockTimeout(initial), initial.material.authoredProfile);
}
/** Recovery requires the local operator, exact proposal, custom-mode consent and host executable; no profile file. */
export async function resumeInstallation(projectRoot: string, input: InstallationApplyChoices) {
  const operator = choices(input); await assertConfiguredInstallationIdentity(projectRoot, true); const recovery = retained(await observeBootstrapState(projectRoot));
  if (!recovery) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  const initial = await prepareSuppliedInstallation(projectRoot, recovery.material.authoredProfile, { allowShutdown: operator.allowShutdown }, recovery.material.configuration);
  validateInstallationRecovery(recovery, initial); await preflightEvidence(initial, operator);
  return executeInstallation(projectRoot, operator, lockTimeout(initial));
}
async function preflightEvidence(prepared: PreparedInstallation, operator: InstallationApplyChoices) {
  if ((await inspectPreparedInstallation(prepared, operator.dockerExecutable)).proposalDigest !== operator.proposalDigest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
}
function lockTimeout(prepared: PreparedInstallation) {
  return Math.min(getConfigFieldDefault('installation').writeLockTimeoutMs, validateConfig(versionedConfig(prepared.material.configuration)).config.installation.writeLockTimeoutMs);
}
async function executeInstallation(projectRoot: string, operator: InstallationApplyChoices, timeoutMs: number, supplied?: unknown) {
  return withInstallationJournal(projectRoot, { timeoutMs }, async journal => {
    const observed = await journal.observe(), recovery = retained(observed), clock = new SystemTrustedClock(); // I40: journal times are compared (TIME_ORDER)
    if (!supplied && !recovery) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    const prepared = await prepareSuppliedInstallation(projectRoot, supplied ?? recovery!.material.authoredProfile,
      { allowShutdown: operator.allowShutdown }, recovery?.material.configuration);
    if (recovery) validateInstallationRecovery(recovery, prepared);
    const evidence = await inspectPreparedInstallation(prepared, operator.dockerExecutable);
    if (evidence.proposalDigest !== operator.proposalDigest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    const config = validateConfig(versionedConfig(prepared.material.configuration)).config;
    const layout = resolveProductLayout({ projectRoot, root: prepared.material.layout.root, resources: config.layout.resources });
    const installationIdentity = new FileInstallationIdentityStore(layout, timeoutMs, undefined, config.installation), projectIdentity = new FileProjectIdentityStore(projectRoot, timeoutMs);
    await installationIdentity.read(); await projectIdentity.read();
    const consent: InstallationConsent = recovery?.consent ?? Object.freeze({ schemaVersion: 1, mode: 'operator-custom',
      id: randomUUID(), atMs: Date.now(), proposalDigest: operator.proposalDigest, principal: prepared.preview.principal });
    const result = await new InstallationPublicationApplication({ journal, ...installationPublicationPorts(projectRoot, prepared),
      revalidateEvidence: () => inspectPreparedInstallation(prepared, operator.dockerExecutable), now: () => clock.sample().wallMs }).apply(prepared, evidence, consent);
    await installationIdentity.loadOrCreate(); await projectIdentity.loadOrCreate(); return result;
  });
}
