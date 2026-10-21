import { firstSessionTargets, firstSessionPublication } from '#adapters/index.js';
import { lstat, readFile, stat } from 'node:fs/promises';
import { FileInstallationIdentityStore, FileProjectIdentityStore, attestLocalInteractiveTerminal, inspectInstallationFile, localPrincipalChannel, openLocalIntegrityAuthority, openSqliteAuditStore, publishInstallationFile, readLocalOsIdentity, withInstallationJournal } from '#adapters/index.js';
import { userInfo } from 'node:os'; import { randomUUID } from 'node:crypto'; import { dirname } from 'node:path';
import { FIRST_RUN_TOOL_NAMES, inspectFirstRunPolicyTemplate, InstallationPublicationError, AuditApplication, PolicyTemplateInstallationApplication, firstRunServiceIdentity, settleFirstRunServiceIdentity,
  upgradeInstalledPolicyTemplate, preparePolicyTemplateInstallation, assertAuthorityWitness, setInstallerPermissionModes, type AuthorityWitness, type FirstRunServiceIdentityPort, type PolicyTemplatePublishTarget } from '#engine/index.js';
import { getConfigFieldDefault, prepareProductFile, productResourcePath, resolveProductLayout, observeBootstrapState, SystemTrustedClock, withConfigLayersLocked, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import type { AuditEvent } from '#domain/index.js';
import { composeCore, loadComposedConfig } from '#composition/core/root/index.js';
import { assertConfiguredInstallationIdentity, configuredInstallationBinding } from './apply.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal, snapshotConfiguredConfig } from '#composition/core/config/index.js';
const identityPort = (projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}): FirstRunServiceIdentityPort => ({
  read: async () => { const snapshot = await snapshotConfiguredConfig(projectRoot, options); return { identity: snapshot.effective.service.identity, digest: snapshot.digest }; },
  write: async (identity, expect) => createConfiguredConfigApplication(projectRoot, options).set({ keyPath: 'service.identity', value: { ...identity }, layer: 'project', expect,
    principal: await resolveConfiguredConfigPrincipal(projectRoot, scopeId, options), scopeId, commandId: randomUUID() }), hold: work => withConfigLayersLocked(projectRoot, options, work) }); // v12: one config write contract and lock
/** Fresh policy installation also initializes first-session config and ledger, without Docker or a pool. */
async function prepare(projectRoot: string, scopeId: string, options: ConfigLoadOptions, sampled?: ProductLayout) {
  composeCore(); // v12: the shutdown rule and the first config name this scope's configured service, else the default (an unreadable config: the default).
  const loaded = await loadComposedConfig(projectRoot, { ...options, heal: false, force: true }).catch(() => null), configured = loaded === null ? null : loaded.service.identity;
  // g2-deckent-home: the configured data root (DECKENT_HOME, layout.root) as upgrade, doctor and the service read it; an unreadable config keeps the default.
  const service = firstRunServiceIdentity(scopeId, configured), layout = sampled ?? loaded?.productLayout ?? resolveProductLayout({ projectRoot }), identity = readLocalOsIdentity();
  const installation = getConfigFieldDefault('installation'), inspection = getConfigFieldDefault('inspection');
  const maxBytes = Math.min(installation.profileMaxBytes, inspection.policyMaxBytes);
  const observed = await observeBootstrapState(projectRoot);
  const held = observed.record?.recovery as { firstSessionTargets?: unknown } | undefined;
  const targets = observed.record && !held?.firstSessionTargets ? [] : await firstSessionTargets(layout, scopeId, maxBytes, held?.firstSessionTargets, service);
  const prepared = preparePolicyTemplateInstallation({ scopeId, principal: { issuer: identity.issuer, subject: identity.subject },
    paths: { policy: productResourcePath(layout, 'policy'), bindings: productResourcePath(layout, 'bindings') }, toolNames: FIRST_RUN_TOOL_NAMES, serviceId: service.serviceId, firstSessionTargets: targets });
  return { prepared, service, configured, layout, maxBytes: Math.min(installation.profileMaxBytes, inspection.policyMaxBytes), timeoutMs: installation.writeLockTimeoutMs };
}
export async function previewPolicyTemplateInstallation(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}) { const { prepared, service } = await prepare(projectRoot, scopeId, options); return Object.freeze({ ...prepared.preview, serviceIdentity: await settleFirstRunServiceIdentity(identityPort(projectRoot, scopeId, options), service, false) }); }
export async function applyPolicyTemplateInstallation(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}) {
  await assertConfiguredInstallationIdentity(projectRoot); const { prepared, service, configured, layout, maxBytes, timeoutMs } = await prepare(projectRoot, scopeId, options), clock = new SystemTrustedClock(); // I40: journal times are compared (TIME_ORDER), never raw Date.now
  const installationIdentity = new FileInstallationIdentityStore(layout, timeoutMs, undefined, await configuredInstallationBinding(projectRoot)), projectIdentity = new FileProjectIdentityStore(projectRoot, timeoutMs);
  // Identity write admission (relocation, configured source, required machine binding) before the journal or any target is written.
  await installationIdentity.admitWrite(); await projectIdentity.read();
  // The first-session config is the project's bootstrap file: its own directory is its root, also when the data root moved.
  const file = (target: PolicyTemplatePublishTarget) => ({ root: target.resource === 'config' ? dirname(target.path) : layout.root, path: target.path, maxBytes });
  const firstSession = firstSessionPublication(layout, maxBytes);
  const result = await withInstallationJournal(projectRoot, { timeoutMs }, async journal => {
    const current = await prepare(projectRoot, scopeId, options, layout);
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
  return Object.freeze({ ...result, serviceIdentity: journaled ? Object.freeze({ status: 'written' as const, identity: service }) : await settleFirstRunServiceIdentity(identityPort(projectRoot, scopeId, options), service, true, configured) });
}
/** `deckent init policy --upgrade [--apply] [--person <issuer>/<subject>]` (owner 2026-10-07): the first-run v4 → v5 migration of this installation's
 * policy, as the local person the template names (or, for a hand-built policy, the person its file owner names: lead 2026-10-08), through the
 * authority documents' one conditional writer. Without `--apply` it only reads (what would change, or why not). `--apply` is an authority write
 * (SEC-1, owner A48-D5): it needs the witness (Core: this process's controlling terminal; an Enterprise composition may pass a stronger one) and is
 * refused for the MCP actor, with `AUTHORITY_WITNESS_REQUIRED` before any configuration, policy, identity or audit is read or written. */
export async function upgradePolicyTemplateInstallation(projectRoot: string, scopeId: string, apply: boolean, expect?: string, options: ConfigLoadOptions = {},
  callerUid: number | undefined = process.getuid?.(), person?: { readonly issuer: string; readonly subject: string },
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }) {
  if (apply) await assertAuthorityWitness('policyTemplateUpgrade', localPrincipalChannel(), witness);
  // An existing installation: its configured layout (a custom data root, as a live installation has), not only the default `.deckent`.
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false }), layout = config.productLayout, identity = readLocalOsIdentity();
  if (apply) await assertConfiguredInstallationIdentity(projectRoot);
  // Ownership (lead 2026-10-07): the caller's uid owns both authority documents (the same custody the policy source enforces on every read);
  // missing, foreign or unreadable documents fail closed as `not-owner`.
  const owner = await ownsAuthority(layout, callerUid);
  const writer = createLayoutPolicySource(layout, callerUid ?? userInfo().uid, config.inspection.policyMaxBytes);
  const clock = new SystemTrustedClock(), input = { scopeId, principal: { issuer: identity.issuer, subject: identity.subject }, toolNames: FIRST_RUN_TOOL_NAMES, owner, apply,
    peopleLimit: config.inspection.maxPageSize, now: () => clock.sample().wallMs, ...(expect === undefined ? {} : { expect }), ...(person === undefined ? {} : { person }) };
  return upgradeInstalledPolicyTemplate(writer, identityPort(projectRoot, scopeId, options), { ...input, openAudit: () => installerAudit(layout, config) });
}
/** The sealed audit store of this installation, opened for one authority write (the installer's own record precedes the publication). */
async function installerAudit(layout: ProductLayout, config: Awaited<ReturnType<typeof loadComposedConfig>>) {
  const store = await openSqliteAuditStore(await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite, 'allow');
  try { const audit = new AuditApplication(store, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true)); return { record: (event: AuditEvent) => { audit.record(event); }, close: () => store.close() }; }
  catch (error) { store.close(); throw error; }
}
/** `deckent init policy --scope <id> --modes <set> --preview|--apply [--expect <revision>] [--person <issuer>/<subject>]` (PRE-9, owner 2026-10-21): the
 * installation owner opens or closes full-auto / full-access for a person. The same custody as `--upgrade`: `--apply` needs the authority witness
 * (Core: this process's controlling terminal) and is refused for the MCP actor with `AUTHORITY_WITNESS_REQUIRED` before anything is read or written;
 * only the owner of both authority documents writes; the plan is the effective decision per mode (the engine's). */
export async function openPermissionModesInstallation(projectRoot: string, scopeId: string, input: { readonly modes: readonly string[]; readonly apply: boolean;
  readonly expect?: string; readonly person?: { readonly issuer: string; readonly subject: string } }, options: ConfigLoadOptions = {}, callerUid: number | undefined = process.getuid?.(),
  witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }) {
  if (input.apply) await assertAuthorityWitness('policyPermissionModes', localPrincipalChannel(), witness);
  const config = await loadComposedConfig(projectRoot, { ...options, heal: false }), layout = config.productLayout, identity = readLocalOsIdentity();
  if (input.apply) await assertConfiguredInstallationIdentity(projectRoot);
  const owner = await ownsAuthority(layout, callerUid), clock = new SystemTrustedClock();
  return setInstallerPermissionModes(createLayoutPolicySource(layout, callerUid ?? userInfo().uid, config.inspection.policyMaxBytes), { scopeId,
    principal: { issuer: identity.issuer, subject: identity.subject }, ...(input.person === undefined ? {} : { person: input.person }), modes: input.modes, apply: input.apply,
    ...(input.expect === undefined ? {} : { expect: input.expect }), owner, peopleLimit: config.inspection.maxPageSize, now: () => clock.sample().wallMs, openAudit: () => installerAudit(layout, config) });
}
/** Ownership (lead 2026-10-07): the caller's uid owns both authority documents (the custody the policy source enforces on every read); missing,
 * foreign or unreadable documents fail closed. */
async function ownsAuthority(layout: ProductLayout, callerUid: number | undefined) {
  const owns = async (path: string) => { try { const stat = await lstat(path); return callerUid !== undefined && stat.isFile() && !stat.isSymbolicLink() && stat.uid === callerUid; } catch { return false; } };
  return await owns(productResourcePath(layout, 'policy')) && await owns(productResourcePath(layout, 'bindings'));
}
/** Doctor-only, read-soft: not the trusted gate (that stays FilePolicySource); oversized/missing/unparsable/custom -> null, never a doctor failure. */
export async function inspectPolicyTemplate(projectRoot: string, options: ConfigLoadOptions = {}) {
  try {
    const path = productResourcePath((await loadComposedConfig(projectRoot, { ...options, heal: false })).productLayout, 'policy');
    if ((await stat(path)).size > getConfigFieldDefault('inspection').policyMaxBytes) return null;
    return await inspectFirstRunPolicyTemplate({ load: async () => JSON.parse(await readFile(path, 'utf8')) as unknown });
  } catch { return null; }
}
