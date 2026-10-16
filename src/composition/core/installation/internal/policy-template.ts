import { firstSessionTargets, firstSessionPublication } from '#adapters/index.js';
import { lstat, readFile, stat } from 'node:fs/promises';
import { configLayersFingerprint, FileInstallationIdentityStore, FileProjectIdentityStore, inspectInstallationFile, openLocalIntegrityAuthority, openSqliteAuditStore, publishInstallationFile, readLocalOsIdentity, withInstallationJournal } from '#adapters/index.js';
import { userInfo } from 'node:os'; import { randomUUID } from 'node:crypto';
import { FIRST_RUN_TOOL_NAMES, inspectFirstRunPolicyTemplate, InstallationPublicationError, AuditApplication, PolicyTemplateInstallationApplication, firstRunServiceIdentity, settleFirstRunServiceIdentity,
  upgradeInstalledPolicyTemplate, preparePolicyTemplateInstallation, type FirstRunServiceIdentityPort, type PolicyTemplatePublishTarget } from '#engine/index.js';
import { getConfigFieldDefault, prepareProductFile, productResourcePath, resolveProductLayout, observeBootstrapState, SystemTrustedClock, type ConfigLoadOptions } from '#platform/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { composeCore, loadComposedConfig } from '#composition/core/root/index.js';
import { assertConfiguredInstallationIdentity, configuredInstallationBinding } from './apply.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig } from '#composition/core/config/index.js';
/** v12 (owner 2026-10-16): `service.identity` via the one config write contract (own config grant, read digest as `expect`, audited) when no fresh first config has it. */
const identityPort = (projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): FirstRunServiceIdentityPort => ({
  read: async () => { const snapshot = await snapshotConfiguredConfig(projectRoot, options); return { identity: snapshot.effective.service.identity, digest: snapshot.digest }; },
  write: async (identity, expect) => createConfiguredConfigApplication(projectRoot, options).set({ keyPath: 'service.identity', value: { ...identity }, layer: 'project', expect,
    principal: await resolveConfiguredConfigPrincipal(projectRoot, scopeId, options), scopeId, commandId: randomUUID() }), fingerprint: () => configLayersFingerprint(projectRoot, options) });
/** Fresh policy installation also initializes first-session config and ledger, without Docker or a pool. */
async function prepare(projectRoot: string, scopeId: string) {
  composeCore(); // v12: the shutdown rule and the first config name this scope's configured service, else the default (an unreadable config: the default).
  const configured = await loadComposedConfig(projectRoot, { heal: false, force: true }).then(config => config.service.identity, () => null), service = firstRunServiceIdentity(scopeId, configured);
  const layout = resolveProductLayout({ projectRoot }), identity = readLocalOsIdentity(); const installation = getConfigFieldDefault('installation'), inspection = getConfigFieldDefault('inspection');
  const maxBytes = Math.min(installation.profileMaxBytes, inspection.policyMaxBytes);
  const observed = await observeBootstrapState(projectRoot);
  const held = observed.record?.recovery as { firstSessionTargets?: unknown } | undefined;
  const targets = observed.record && !held?.firstSessionTargets ? [] : await firstSessionTargets(layout, scopeId, maxBytes, held?.firstSessionTargets, service);
  const prepared = preparePolicyTemplateInstallation({ scopeId, principal: { issuer: identity.issuer, subject: identity.subject },
    paths: { policy: productResourcePath(layout, 'policy'), bindings: productResourcePath(layout, 'bindings') }, toolNames: FIRST_RUN_TOOL_NAMES, serviceId: service.serviceId, firstSessionTargets: targets });
  return { prepared, service, configured, layout, maxBytes: Math.min(installation.profileMaxBytes, inspection.policyMaxBytes), timeoutMs: installation.writeLockTimeoutMs };
}
export async function previewPolicyTemplateInstallation(projectRoot: string, scopeId: string) { const { prepared, service } = await prepare(projectRoot, scopeId);
  return Object.freeze({ ...prepared.preview, serviceIdentity: await settleFirstRunServiceIdentity(identityPort(projectRoot, scopeId), service, false) }); }
export async function applyPolicyTemplateInstallation(projectRoot: string, scopeId: string) {
  await assertConfiguredInstallationIdentity(projectRoot); const { prepared, service, configured, layout, maxBytes, timeoutMs } = await prepare(projectRoot, scopeId), clock = new SystemTrustedClock(); // I40: journal times are compared (TIME_ORDER), never raw Date.now
  const installationIdentity = new FileInstallationIdentityStore(layout, timeoutMs, undefined, await configuredInstallationBinding(projectRoot)), projectIdentity = new FileProjectIdentityStore(projectRoot, timeoutMs);
  // Identity write admission (relocation, configured source, required machine binding) before the journal or any target is written.
  await installationIdentity.admitWrite(); await projectIdentity.read();
  const file = (target: PolicyTemplatePublishTarget) => ({ root: layout.root, path: target.path, maxBytes });
  const firstSession = firstSessionPublication(layout, maxBytes);
  const result = await withInstallationJournal(projectRoot, { timeoutMs }, async journal => {
    const current = await prepare(projectRoot, scopeId);
    if (current.prepared.preview.planDigest !== prepared.preview.planDigest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    return new PolicyTemplateInstallationApplication({
    journal,
    async inspectPreimage(target) { return (await inspectInstallationFile(file(target))).digest; },
    async publish(target, transactionId) {
      if (target.resource === 'config' || target.resource === 'ledger') await firstSession.publish(target, transactionId);
      else await publishInstallationFile({ ...file(target), transactionId }, target.content);
    },
    async verify(target) {
      if (target.resource === 'config' || target.resource === 'ledger') await firstSession.verify(target);
      else if ((await inspectInstallationFile(file(target))).digest !== target.digest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    },
    now: () => clock.sample().wallMs,
  }).apply(prepared); });
  await installationIdentity.loadOrCreate(); await projectIdentity.loadOrCreate();
  const journaled = result.status === 'installed' && prepared.targets.some(target => target.resource === 'config' && (JSON.parse(target.content) as { service?: unknown }).service);
  return Object.freeze({ ...result, serviceIdentity: journaled ? Object.freeze({ status: 'written' as const, identity: service }) : await settleFirstRunServiceIdentity(identityPort(projectRoot, scopeId), service, true, configured) });
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
  const clock = new SystemTrustedClock(), input = { scopeId, principal: { issuer: identity.issuer, subject: identity.subject }, toolNames: FIRST_RUN_TOOL_NAMES, owner, apply,
    peopleLimit: config.inspection.maxPageSize, now: () => clock.sample().wallMs, ...(expect === undefined ? {} : { expect }), ...(person === undefined ? {} : { person }) };
  // v12 (Astra 2596): the engine reads the identity once, binds it to the plan and the `--expect` token, and publishes only on unchanged config.
  return upgradeInstalledPolicyTemplate(writer, identityPort(projectRoot, scopeId, options), { ...input, openAudit: async () => {
    const store = await openSqliteAuditStore(await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite, 'allow');
    try { const audit = new AuditApplication(store, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true)); return { record: event => { audit.record(event); }, close: () => store.close() }; }
    catch (error) { store.close(); throw error; } } });
}
/** Doctor-only, read-soft: not the trusted gate (that stays FilePolicySource); oversized/missing/unparsable/custom -> null, never a doctor failure. */
export async function inspectPolicyTemplate(projectRoot: string) {
  try {
    const path = productResourcePath(resolveProductLayout({ projectRoot }), 'policy');
    if ((await stat(path)).size > getConfigFieldDefault('inspection').policyMaxBytes) return null;
    return await inspectFirstRunPolicyTemplate({ load: async () => JSON.parse(await readFile(path, 'utf8')) as unknown });
  } catch { return null; }
}
