import { lstat, readFile, stat } from 'node:fs/promises';
import { FileInstallationIdentityStore, FileProjectIdentityStore, inspectInstallationFile, publishInstallationFile, readLocalOsIdentity, withInstallationJournal } from '#adapters/index.js';
import { userInfo } from 'node:os';
import { FIRST_RUN_EDIT_SHELL_TOOL_NAMES, FIRST_RUN_MCP_CALL_OPERATION_ID, FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID, FIRST_RUN_PROPOSE_MCP_TOOL_NAME, FIRST_RUN_READ_TOOL_NAMES, FIRST_RUN_SCRATCH_TOOL_NAMES,
  FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, FIRST_RUN_SHELL_OPERATION_ID, FIRST_RUN_WRITE_OPERATION_ID, inspectFirstRunPolicyTemplate, InstallationPublicationError,
  PolicyTemplateInstallationApplication, preparePolicyTemplateInstallation, upgradePolicyTemplate, type FirstRunToolNames, type PolicyTemplatePublishTarget } from '#engine/index.js';
import { getConfigFieldDefault, productResourcePath, resolveProductLayout, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { assertConfiguredInstallationIdentity, configuredInstallationBinding } from './apply.js';
const TOOL_NAMES: FirstRunToolNames = Object.freeze({ readToolNames: FIRST_RUN_READ_TOOL_NAMES, scratchToolNames: FIRST_RUN_SCRATCH_TOOL_NAMES,
  scratchWriteOperationId: FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, editShellToolNames: FIRST_RUN_EDIT_SHELL_TOOL_NAMES, writeOperationId: FIRST_RUN_WRITE_OPERATION_ID,
  shellOperationId: FIRST_RUN_SHELL_OPERATION_ID, proposeMcpToolName: FIRST_RUN_PROPOSE_MCP_TOOL_NAME, mcpCallOperationId: FIRST_RUN_MCP_CALL_OPERATION_ID,
  policyAdministerOperationId: FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID });
/** No project config is read or required: a policy-only installation works without Docker/pool/registry. */
function prepare(projectRoot: string, scopeId: string) {
  const layout = resolveProductLayout({ projectRoot }), identity = readLocalOsIdentity(); const installation = getConfigFieldDefault('installation'), inspection = getConfigFieldDefault('inspection');
  const prepared = preparePolicyTemplateInstallation({ scopeId, principal: { issuer: identity.issuer, subject: identity.subject },
    paths: { policy: productResourcePath(layout, 'policy'), bindings: productResourcePath(layout, 'bindings') }, toolNames: TOOL_NAMES });
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
/** `deckent init policy --upgrade [--apply] [--person <issuer>/<subject>]` (owner 2026-10-07): the first-run v4 → v5 migration of this installation's
 * policy, as the local person the template names (or, for a hand-built policy, the person its file owner names: lead 2026-10-08), through the
 * authority documents' one conditional writer. Without `--apply` it only reads (what would change, or why not). */
export async function upgradePolicyTemplateInstallation(projectRoot: string, scopeId: string, apply: boolean, expect?: string, options: ConfigLoadOptions = {},
  callerUid: number | undefined = process.getuid?.(), person?: { readonly issuer: string; readonly subject: string }) {
  // An existing installation: its configured layout (a custom data root, as a live installation has), not only the default `.deckent`.
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false }), layout = config.productLayout, identity = readLocalOsIdentity();
  if (apply) await assertConfiguredInstallationIdentity(projectRoot);
  // Ownership (lead 2026-10-07): the caller's uid owns both authority documents (the same custody the policy source enforces on every read);
  // missing, foreign or unreadable documents fail closed as `not-owner`.
  const owns = async (path: string) => { try { const stat = await lstat(path); return callerUid !== undefined && stat.isFile() && !stat.isSymbolicLink() && stat.uid === callerUid; } catch { return false; } };
  const owner = await owns(productResourcePath(layout, 'policy')) && await owns(productResourcePath(layout, 'bindings'));
  const writer = createLayoutPolicySource(layout, callerUid ?? userInfo().uid, config.inspection.policyMaxBytes);
  return upgradePolicyTemplate(writer, { scopeId, principal: { issuer: identity.issuer, subject: identity.subject }, toolNames: TOOL_NAMES, apply, owner,
    peopleLimit: config.inspection.maxPageSize, ...(expect === undefined ? {} : { expect }), ...(person === undefined ? {} : { person }) });
}
/** Doctor-only, read-soft: not the trusted gate (that stays FilePolicySource); oversized/missing/unparsable/custom -> null, never a doctor failure. */
export async function inspectPolicyTemplate(projectRoot: string) {
  try {
    const path = productResourcePath(resolveProductLayout({ projectRoot }), 'policy');
    if ((await stat(path)).size > getConfigFieldDefault('inspection').policyMaxBytes) return null;
    return await inspectFirstRunPolicyTemplate({ load: async () => JSON.parse(await readFile(path, 'utf8')) as unknown });
  } catch { return null; }
}
