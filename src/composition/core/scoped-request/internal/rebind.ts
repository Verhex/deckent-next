import { userInfo } from 'node:os';
import { automationMarker, isCodedError, type ConfigLoadOptions, type ResolvedConfig } from '#platform/index.js';
import { REBIND_CLASS } from '#domain/index.js';
import { assertAuthorityWitness, policyRebindAdmission, InstallationIdentityError, type RebindAdmission } from '#engine/index.js';
import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, FileProjectAttachmentStore,
  type FileInstallationIdentityStore } from '#adapters/index.js';
import { contextPolicySource } from '#composition/core/policy/index.js';

/** Static producer capability, never inferred from a failed attestation. Linux is the only current producer. */
export async function plainMacosRebinding(config: ResolvedConfig, options: ConfigLoadOptions, installationId: string | null,
  platform: NodeJS.Platform = process.platform, witnessProducer = platform === 'linux') {
  if (platform !== 'darwin' || witnessProducer || config.installation.sharedRegistrationId) return false;
  const store = new FileProjectAttachmentStore(config.productLayout, options, config.installation.profileMaxBytes, config.installation.writeLockTimeoutMs);
  if (await store.attachment()) return false;
  const registration = await store.registration();
  return !registration || (registration.source.installationId !== installationId && registration.source.projectRoot !== config.projectRoot
    && !registration.entries.some(entry => entry.attachment.location.canonicalRoot === config.projectRoot));
}

export async function admitInstallationRebinding(config: ResolvedConfig, options: ConfigLoadOptions, store: FileInstallationIdentityStore,
  principal: { readonly issuer: string; readonly subject: string }): Promise<RebindAdmission> {
  const observed = await store.inspectRebinding();
  // bind/strengthen retain their existing automatic write behavior; no relocated class is assigned to them.
  if (observed.class === null || observed.class === REBIND_CLASS.deviceOnly) return { class: REBIND_CLASS.deviceOnly, basis: 'open-class' };
  try {
    await assertAuthorityWitness('project.attach', localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), { attest: async () =>
      !automationMarker(process.env, config.cli.agentEnvironment) && !automationMarker(options.env ?? process.env, config.cli.agentEnvironment)
      && await attestLocalInteractiveTerminal() });
    return { class: REBIND_CLASS.moved, basis: 'human-tty' };
  } catch (error) { if (!isCodedError(error, 'AUTHORITY_WITNESS_REQUIRED')) throw error; }
  let grant;
  try { grant = policyRebindAdmission(await contextPolicySource({ layout: config.productLayout, config, ownerUid: userInfo().uid }).load(), principal, observed.class); }
  catch { /* Unsafe, missing or invalid policy never authorizes the rule path. */ }
  if (grant) return grant;
  // The caller must recheck this exception under the attachment lifecycle hold before writing.
  if (await plainMacosRebinding(config, options, observed.installationId)) return { class: REBIND_CLASS.moved, basis: 'macos-plain' };
  throw new InstallationIdentityError('INSTALLATION_IDENTITY_REBIND_REQUIRED');
}
