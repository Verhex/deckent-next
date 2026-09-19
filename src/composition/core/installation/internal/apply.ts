import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { withInstallationJournal } from '#adapters/index.js';
import { immutableJsonObjectSchema } from '#domain/index.js';
import { InstallationPublicationApplication, InstallationPublicationError, validateInstallationRecovery,
  type InstallationConsent, type InstallationRecovery, type PreparedInstallation } from '#engine/index.js';
import { getConfigFieldDefault, observeBootstrapState, validateConfig, versionedConfig, type BootstrapObservation } from '#platform/index.js';
import { prepareSuppliedInstallation } from './preview.js';
import { inspectPreparedInstallation } from './evidence.js';
import { installationPublicationPorts } from './publication.js';

const choicesSchema = z.object({ allowShutdown: z.boolean(), dockerExecutable: z.string().min(1).refine(isAbsolute),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), acceptCustom: z.literal(true),
}).strict().readonly();
export type InstallationApplyChoices = z.infer<typeof choicesSchema>;
function choices(input: unknown): InstallationApplyChoices {
  const safe = immutableJsonObjectSchema.safeParse(input);
  const parsed = safe.success ? choicesSchema.safeParse(safe.data) : null;
  if (!parsed?.success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return parsed.data;
}
function retained(observed: BootstrapObservation): InstallationRecovery | null {
  if (!observed.record) return null;
  // This structural read grants no permission. The engine validates the complete cross-bound
  // recovery against a new preparation and current identity before any target publication.
  const schema = z.object({ material: z.object({ authoredProfile: immutableJsonObjectSchema,
    configuration: immutableJsonObjectSchema, allowShutdown: z.boolean() }).passthrough(),
    consent: z.object({ id: z.string().min(1), atMs: z.number().int().nonnegative().safe() }).passthrough(),
  }).passthrough();
  if (!schema.safeParse(observed.record.recovery).success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return observed.record.recovery as unknown as InstallationRecovery;
}

/** Explicit local operator action. No model, worker, or supplied profile can grant consent. */
export async function applySuppliedInstallation(projectRoot: string, supplied: unknown, input: InstallationApplyChoices) {
  const operator = choices(input);
  // Snapshot and validate before acquiring the lock or creating the bootstrap directory.
  const initial = await prepareSuppliedInstallation(projectRoot, supplied, operator);
  await preflightEvidence(initial, operator);
  return executeInstallation(projectRoot, operator, lockTimeout(initial), initial.material.authoredProfile);
}
/** Recovery needs no external profile file. It still requires the actual local operator,
 * exact proposal, explicit custom-mode choice and separately chosen host executable. */
export async function resumeInstallation(projectRoot: string, input: InstallationApplyChoices) {
  const operator = choices(input), recovery = retained(await observeBootstrapState(projectRoot));
  if (!recovery) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  const initial = await prepareSuppliedInstallation(projectRoot, recovery.material.authoredProfile,
    { allowShutdown: operator.allowShutdown }, recovery.material.configuration);
  validateInstallationRecovery(recovery, initial);
  await preflightEvidence(initial, operator);
  return executeInstallation(projectRoot, operator, lockTimeout(initial));
}
async function preflightEvidence(prepared: PreparedInstallation, operator: InstallationApplyChoices) {
  if ((await inspectPreparedInstallation(prepared, operator.dockerExecutable)).proposalDigest !== operator.proposalDigest) {
    throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
  }
}
function lockTimeout(prepared: PreparedInstallation) {
  const host = getConfigFieldDefault('installation');
  const configured = validateConfig(versionedConfig(prepared.material.configuration)).config.installation.writeLockTimeoutMs;
  return Math.min(host.writeLockTimeoutMs, configured);
}
async function executeInstallation(projectRoot: string, operator: InstallationApplyChoices, timeoutMs: number, supplied?: unknown) {
  return withInstallationJournal(projectRoot, { timeoutMs }, async journal => {
    const observed = await journal.observe(), recovery = retained(observed);
    if (!supplied && !recovery) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    const prepared = await prepareSuppliedInstallation(projectRoot, supplied ?? recovery!.material.authoredProfile,
      { allowShutdown: operator.allowShutdown }, recovery?.material.configuration);
    if (recovery) validateInstallationRecovery(recovery, prepared);
    const evidence = await inspectPreparedInstallation(prepared, operator.dockerExecutable);
    if (evidence.proposalDigest !== operator.proposalDigest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    const consent: InstallationConsent = recovery?.consent ?? Object.freeze({ schemaVersion: 1, mode: 'operator-custom',
      id: randomUUID(), atMs: Date.now(), proposalDigest: operator.proposalDigest, principal: prepared.preview.principal });
    return new InstallationPublicationApplication({ journal, ...installationPublicationPorts(projectRoot, prepared),
      revalidateEvidence: () => inspectPreparedInstallation(prepared, operator.dockerExecutable), now: Date.now,
    }).apply(prepared, evidence, consent);
  });
}
