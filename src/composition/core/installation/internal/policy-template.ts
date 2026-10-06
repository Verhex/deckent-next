import { readFile, stat } from 'node:fs/promises';
import { FileInstallationIdentityStore, FileProjectIdentityStore, inspectInstallationFile, publishInstallationFile, readLocalOsIdentity, withInstallationJournal } from '#adapters/index.js';
import { FIRST_RUN_EDIT_SHELL_TOOL_NAMES, FIRST_RUN_READ_TOOL_NAMES, FIRST_RUN_SCRATCH_TOOL_NAMES, FIRST_RUN_SCRATCH_WRITE_OPERATION_ID,
  FIRST_RUN_SHELL_OPERATION_ID, FIRST_RUN_WRITE_OPERATION_ID, inspectFirstRunPolicyTemplate, InstallationPublicationError,
  PolicyTemplateInstallationApplication, preparePolicyTemplateInstallation, type PolicyTemplatePublishTarget } from '#engine/index.js';
import { getConfigFieldDefault, productResourcePath, resolveProductLayout, SystemTrustedClock } from '#platform/index.js';
import { assertConfiguredInstallationIdentity, configuredInstallationBinding } from './apply.js';
/** No project config is read or required: a policy-only installation works without Docker/pool/registry. */
function prepare(projectRoot: string, scopeId: string) {
  const layout = resolveProductLayout({ projectRoot }), identity = readLocalOsIdentity(); const installation = getConfigFieldDefault('installation'), inspection = getConfigFieldDefault('inspection');
  const prepared = preparePolicyTemplateInstallation({ scopeId, principal: { issuer: identity.issuer, subject: identity.subject },
    paths: { policy: productResourcePath(layout, 'policy'), bindings: productResourcePath(layout, 'bindings') },
    toolNames: { readToolNames: FIRST_RUN_READ_TOOL_NAMES, scratchToolNames: FIRST_RUN_SCRATCH_TOOL_NAMES,
      scratchWriteOperationId: FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, editShellToolNames: FIRST_RUN_EDIT_SHELL_TOOL_NAMES,
      writeOperationId: FIRST_RUN_WRITE_OPERATION_ID, shellOperationId: FIRST_RUN_SHELL_OPERATION_ID } });
  return { prepared, layout, maxBytes: Math.min(installation.profileMaxBytes, inspection.policyMaxBytes), timeoutMs: installation.writeLockTimeoutMs };
}
export async function previewPolicyTemplateInstallation(projectRoot: string, scopeId: string) { return prepare(projectRoot, scopeId).prepared.preview; }
export async function applyPolicyTemplateInstallation(projectRoot: string, scopeId: string) {
  await assertConfiguredInstallationIdentity(projectRoot); const { prepared, layout, maxBytes, timeoutMs } = prepare(projectRoot, scopeId), clock = new SystemTrustedClock(); // I40: journal times are compared (TIME_ORDER), never raw Date.now
  const installationIdentity = new FileInstallationIdentityStore(layout, timeoutMs, undefined, await configuredInstallationBinding(projectRoot)), projectIdentity = new FileProjectIdentityStore(projectRoot, timeoutMs);
  // Identity write admission (relocation, configured source, required machine binding) before the journal or any target is written.
  await installationIdentity.admitWrite(); await projectIdentity.read();
  const file = (target: PolicyTemplatePublishTarget) => ({ root: layout.root, path: target.path, maxBytes });
  const result = await withInstallationJournal(projectRoot, { timeoutMs }, journal => new PolicyTemplateInstallationApplication({
    journal,
    async inspectPreimage(target) { return (await inspectInstallationFile(file(target))).digest; },
    async publish(target, transactionId) { await publishInstallationFile({ ...file(target), transactionId }, target.content); },
    async verify(target) { if ((await inspectInstallationFile(file(target))).digest !== target.digest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED'); },
    now: () => clock.sample().wallMs,
  }).apply(prepared));
  await installationIdentity.loadOrCreate(); await projectIdentity.loadOrCreate(); return result;
}
/** Doctor-only, read-soft: not the trusted gate (that stays FilePolicySource); oversized/missing/unparsable/custom -> null, never a doctor failure. */
export async function inspectPolicyTemplate(projectRoot: string) {
  try {
    const path = productResourcePath(resolveProductLayout({ projectRoot }), 'policy');
    if ((await stat(path)).size > getConfigFieldDefault('inspection').policyMaxBytes) return null;
    return await inspectFirstRunPolicyTemplate({ load: async () => JSON.parse(await readFile(path, 'utf8')) as unknown });
  } catch { return null; }
}
