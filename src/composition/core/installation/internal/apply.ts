import { loadComposedConfig } from '#composition/core/root/index.js';
import { automationMarker, ErrorRegistry, persistedString, bootstrapPublishesConfig, getConfigFieldDefault, observeBootstrapState, SystemTrustedClock, productResourcePath, validateConfig, versionedConfig, resolveProductLayout, resolveGlobalConfigReadPath, isCodedError, type BootstrapObservation, type ConfigLoadOptions } from '#platform/index.js';
import { lstat, realpath } from 'node:fs/promises';
import { defaultSecretStore } from './secret-default.js';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { attestLocalInteractiveTerminal, ensureLocalPrefixCacheSaltKey, FileInstallationIdentityStore, FileProjectIdentityStore, localPrincipalChannel, withInstallationJournal } from '#adapters/index.js';
import { counterSchema, immutableJsonObjectSchema } from '#domain/index.js';
import { assertAuthorityWitness, InstallationPublicationApplication, InstallationPublicationError, suppliedPolicyWithinTemplate, validateInstallationRecovery, type InstallationConsent, type InstallationRecovery, type PreparedInstallation } from '#engine/index.js';
import { prepareSuppliedInstallation } from './preview.js';
import { inspectPreparedInstallation } from './evidence.js';
import { installationPublicationPorts } from './publication.js';
import { loadConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
const choicesSchema = z.strictObject({ allowShutdown: z.boolean(), dockerExecutable: persistedString(z.string().min(1)).refine(isAbsolute),
  proposalDigest: z.string().regex(/^[a-f0-9]{64}$/), acceptCustom: z.literal(true) }).readonly();
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type InstallationApplyChoices = z.infer<typeof choicesSchema>;
function choices(input: unknown): InstallationApplyChoices {
  const safe = immutableJsonObjectSchema.safeParse(input), parsed = safe.success ? choicesSchema.safeParse(safe.data) : null;
  if (!parsed?.success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return parsed.data;
}
function retained(observed: BootstrapObservation): InstallationRecovery | null {
  if (!observed.record) return null;
  // Structural read only: the engine cross-validates recovery against preparation and current identity before publication.
  const schema = z.looseObject({ material: z.looseObject({ authoredProfile: immutableJsonObjectSchema,
    configuration: immutableJsonObjectSchema, allowShutdown: z.boolean() }),
    consent: z.looseObject({ id: persistedString(z.string().min(1)), atMs: counterSchema }) });
  if (!schema.safeParse(observed.record.recovery).success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return observed.record.recovery as unknown as InstallationRecovery;
}
/** ID-1C: observe the composed identity before effects; config-publishing recovery owns its target layout and publication refuses existing invalid config. */
export async function assertConfiguredInstallationIdentity(projectRoot: string, publicationGuarded = false, options: ConfigLoadOptions = {}) {
  if (bootstrapPublishesConfig(await observeBootstrapState(projectRoot), projectRoot)) return;
  try {
    if (publicationGuarded && (await loadComposedConfig(projectRoot, { ...options, pendingBootstrap: 'config-settled', heal: false })).installation.sharedRegistrationId) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
    await loadConfiguredInstallationIdentity(projectRoot, { ...options, pendingBootstrap: 'config-settled' });
  } catch (error) { if (!publicationGuarded || !isCodedError(error, 'CONFIG_VALIDATION')) throw error; }
}
/** Settled binding settings, or defaults while config publication is pending. */
export async function configuredInstallationBinding(projectRoot: string, options: ConfigLoadOptions = {}) {
  if (bootstrapPublishesConfig(await observeBootstrapState(projectRoot), projectRoot)) return getConfigFieldDefault('installation');
  return (await loadComposedConfig(projectRoot, { ...options, pendingBootstrap: 'config-settled', heal: false })).installation;
}
export async function applySuppliedInstallation(projectRoot: string, supplied: unknown, input: InstallationApplyChoices) {
  const operator = choices(input); await assertConfiguredInstallationIdentity(projectRoot, true); // Snapshot and validate before the lock or bootstrap directory.
  const initial = await prepareSuppliedInstallation(projectRoot, supplied, operator);
  const authority = await assertSuppliedAuthority(projectRoot, initial); await approvedEvidence(initial, operator);
  await identityStores(projectRoot, initial, lockTimeout(initial)).installation.admitWrite(); // before the journal or any bootstrap directory
  return executeInstallation(projectRoot, operator, lockTimeout(initial), authority, initial.material.authoredProfile);
}
export async function resumeInstallation(projectRoot: string, input: InstallationApplyChoices) {
  const operator = choices(input); await assertConfiguredInstallationIdentity(projectRoot, true); const recovery = retained(await observeBootstrapState(projectRoot));
  if (!recovery) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  const initial = await prepareSuppliedInstallation(projectRoot, recovery.material.authoredProfile, { allowShutdown: operator.allowShutdown }, recovery.material.configuration);
  validateInstallationRecovery(recovery, initial);
  const authority = await assertSuppliedAuthority(projectRoot, initial); await approvedEvidence(initial, operator);
  await identityStores(projectRoot, initial, lockTimeout(initial)).installation.admitWrite();
  return executeInstallation(projectRoot, operator, lockTimeout(initial), authority);
}
/** The approved proposal binds the prepared profile. The settled marker setting is independent of that proposal. */
async function assertSuppliedAuthority(projectRoot: string, prepared: PreparedInstallation, observed?: BootstrapObservation) {
  if (suppliedPolicyWithinTemplate(prepared.preview)) return null;
  const pending = bootstrapPublishesConfig(observed ?? await observeBootstrapState(projectRoot), projectRoot);
  // A global root can point at the pending project bootstrap directory too.
  const globalIsTarget = pending && await realpath(dirname(await resolveGlobalConfigReadPath())).catch(() => undefined)
    === await realpath(dirname(prepared.material.layout.bootstrapConfigPath));
  const markers = globalIsTarget ? getConfigFieldDefault('cli').agentEnvironment
    : (await loadComposedConfig(projectRoot, {
      // Both authority checks need the current trusted marker basis.
      force: true, globalOnly: pending, pendingBootstrap: 'config-settled', heal: false, secretResolver: async () => undefined,
      onWarning: warning => {
        if (warning.code === 'CONFIG_GLOBAL_CORRUPT') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', {
          params: { reason: 'installation-authority-global-config', path: warning.path },
        });
      },
    })).cli.agentEnvironment;
  await assertAuthorityWitness('installationProfilePolicy', localPrincipalChannel(), { attest: async () =>
    !automationMarker(process.env, markers) && await attestLocalInteractiveTerminal() });
  return JSON.stringify([pending, [...new Set(markers)].sort()]);
}
async function approvedEvidence(prepared: PreparedInstallation, operator: InstallationApplyChoices) {
  const evidence = await inspectPreparedInstallation(prepared, operator.dockerExecutable);
  if (evidence.proposalDigest !== operator.proposalDigest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
  return evidence;
}
/** The identity stores of the prepared configuration: its layout root and resources and its installation binding settings. */
function identityStores(projectRoot: string, prepared: PreparedInstallation, timeoutMs: number) {
  const config = validateConfig(versionedConfig(prepared.material.configuration)).config;
  const layout = resolveProductLayout({ projectRoot, root: prepared.material.layout.root, resources: config.layout.resources });
  return { layout, installation: new FileInstallationIdentityStore(layout, timeoutMs, undefined, config.installation), project: new FileProjectIdentityStore(projectRoot, timeoutMs) };
}
function lockTimeout(prepared: PreparedInstallation) {
  return Math.min(getConfigFieldDefault('installation').writeLockTimeoutMs, validateConfig(versionedConfig(prepared.material.configuration)).config.installation.writeLockTimeoutMs);
}
async function executeInstallation(projectRoot: string, operator: InstallationApplyChoices, timeoutMs: number, authority: string | null, supplied?: unknown) {
  return withInstallationJournal(projectRoot, { timeoutMs }, async journal => {
    const observed = await journal.observe(), recovery = retained(observed), clock = new SystemTrustedClock(); // I40: journal times are compared (TIME_ORDER)
    if (!supplied && !recovery) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
    const prepared = await prepareSuppliedInstallation(projectRoot, supplied ?? recovery!.material.authoredProfile,
      { allowShutdown: operator.allowShutdown }, recovery?.material.configuration);
    if (recovery) validateInstallationRecovery(recovery, prepared);
    const evidence = await approvedEvidence(prepared, operator);
    if (await assertSuppliedAuthority(projectRoot, prepared, observed) !== authority) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    const { layout, installation: installationIdentity, project: projectIdentity } = identityStores(projectRoot, prepared, timeoutMs);
    await installationIdentity.admitWrite(); await projectIdentity.read(); // re-admitted under the journal lock, before any target is published
    const consent: InstallationConsent = recovery?.consent ?? Object.freeze({ schemaVersion: 1, mode: 'operator-custom',
      id: randomUUID(), atMs: Date.now(), proposalDigest: operator.proposalDigest, principal: prepared.preview.principal });
    const fresh = await lstat(productResourcePath(layout, 'policy')).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    const result = await new InstallationPublicationApplication({ journal, ...installationPublicationPorts(projectRoot, prepared),
      revalidateEvidence: () => inspectPreparedInstallation(prepared, operator.dockerExecutable), now: () => clock.sample().wallMs }).apply(prepared, evidence, consent);
    await installationIdentity.loadOrCreate(); await projectIdentity.loadOrCreate();
    await ensureLocalPrefixCacheSaltKey(layout); // VLLM-CACHE-SALT: the installation's salt secret exists from init (older installations: first use)
    return { result, fresh, scopeId: prepared.preview.scopeId };
  }).then(async ({ result, fresh, scopeId }) => fresh && result.status === 'installed'
    ? Object.freeze({ ...result, secretStore: await defaultSecretStore(projectRoot, scopeId, {}) }) : result);
}
