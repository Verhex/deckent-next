import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuredSecretResolver, ErrorRegistry, SystemTrustedClock, withConfigWriteLock, type ConfigLoadOptions } from '#platform/index.js';
import { admitProjectVault, attestLocalInteractiveTerminal, directoryLocation, FileInstallationIdentityStore, FileProjectIdentityStore, handOverProjectVault, installationSecretRoot,
  localPrincipalChannel, localPrincipalPeer, openLocalIntegrityAuthority, openProjectVaultStore, openSecretGrantStore, openSqliteAuditStore, projectRepository, projectVaultDirectory, readProjectDeck } from '#adapters/index.js';
import { assertAuthorityWitness, AuditApplication, AuthorityDecisionRecords, SecretStoreAdministration, credentialSourceError, decideCredentialSource, decideSecretGrant,
  deckDeclaration, findSecretGrant, parseDeckDeclarations, policySecretChangeAuthorization, projectVaultAnchorSchema, projectVaultClaimed, type AuthorityWitness,
  type CredentialSource, type ProjectCredentialResolver, type ProjectVaultAnchor } from '#engine/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';

type ScopeContext = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
/** What the project credential path needs of a verified scope context (the invocation and scoped-request contexts both carry it). */
export type ProjectSecretContext = Pick<ScopeContext, 'config' | 'layout' | 'installationId' | 'projectId'>;
const lockMs = (context: ProjectSecretContext) => context.config.configFile.writeLockTimeoutMs;
const envOf = (options: ConfigLoadOptions) => ({ env: options.env ?? process.env, platform: options.platform ?? process.platform });
const globalRoot = (options: ConfigLoadOptions) => {
  const { env, platform } = envOf(options), root = installationSecretRoot(env, platform);
  if (root === null) throw ErrorRegistry.createError('SECRET_STORE_UNAVAILABLE', { params: { backend: 'project-vault' } });
  return root;
};

/**
 * The project a vault belongs to (owner decision 5, lead 2026-10-21): a verified linked worktree resolves to its repository's main working tree
 * (one project, one vault, one grant record); any other project to itself. A `.git` file that is not a worktree of its repository (a copied
 * worktree folder) is `SECRET_PROJECT_VAULT_CLAIMED`. Null: the anchor has no installation or project identity yet.
 */
export async function resolveProjectVaultAnchor(context: ProjectSecretContext, options: ConfigLoadOptions): Promise<ProjectVaultAnchor | null> {
  const projectRoot = context.config.projectRoot, repository = await projectRepository(projectRoot);
  if (repository.kind === 'foreign') throw projectVaultClaimed({ projectRoot });
  let installationId = context.installationId, projectId = context.projectId, dataRoot = context.layout.root, anchorRoot = projectRoot;
  if (repository.kind === 'linked' && repository.mainWorkTree !== null && repository.mainWorkTree !== projectRoot) {
    const main = await loadComposedConfig(repository.mainWorkTree, { ...options, heal: false });
    const installation = await new FileInstallationIdentityStore(main.productLayout, main.configFile.writeLockTimeoutMs, undefined, main.installation).read();
    const project = await new FileProjectIdentityStore(main.projectRoot, main.configFile.writeLockTimeoutMs).read();
    installationId = installation.status === 'available' ? installation.value.installationId : null;
    projectId = project.status === 'available' ? project.value.projectId : null;
    dataRoot = main.productLayout.root; anchorRoot = main.projectRoot;
  }
  const binding = await directoryLocation(dataRoot);
  if (installationId === null || projectId === null || binding === null) return null;
  return projectVaultAnchorSchema.parse({ installationId, projectId, binding, repository: repository.kind === 'none' ? null : repository.repository, projectRoot: anchorRoot });
}

/** The project's vault, read-only (also the inventory's current project): its anchor, directory (null: never written), `.deck`, store and grants. An existing vault of another owner is refused. */
export async function openProjectSecrets(context: ProjectSecretContext, options: ConfigLoadOptions) {
  const anchor = await resolveProjectVaultAnchor(context, options);
  if (!anchor) return null;
  const root = globalRoot(options), directory = await projectVaultDirectory(root, anchor, false);
  if (directory) await admitProjectVault(directory, anchor, false, 0, lockMs(context));
  const text = await readProjectDeck(context.config.projectRoot), { env, platform } = envOf(options);
  return { anchor, root, directory, deck: text === null ? null : parseDeckDeclarations(text),
    store: directory ? openProjectVaultStore(directory, anchor, env, platform) : null,
    grants: directory ? await openSecretGrantStore(root, anchor, lockMs(context)).read() : null };
}

/**
 * The one provider credential entry point (PRE-8 v2 §1.5): every provider read (model invocation and its invocable-now check, model
 * discovery, provider workspaces) goes through `.deck` → ownership → project vault or main vault through a grant → typed refusal, before any
 * value is read. An injected `options.secretResolver` (tests, SDK) substitutes only the final main-vault read. Installation-level secrets
 * (backup passphrase, `$DECK:` in global config, MCP server secrets) never come here.
 */
export function projectCredentialResolver(context: ProjectSecretContext, scopeId: string, options: ConfigLoadOptions): ProjectCredentialResolver {
  const decide = async (name: string): Promise<{ readonly decision: CredentialSource; readonly opened: Awaited<ReturnType<typeof openProjectSecrets>> }> => {
    const opened = await openProjectSecrets(context, options);
    if (!opened) return { decision: decideCredentialSource({ identified: false, declaration: 'undeclared', projectHas: false, granted: false }), opened };
    const declaration = deckDeclaration(opened.deck, name);
    const projectHas = declaration !== 'main' && opened.store !== null && (await opened.store.listNames()).includes(name);
    return { decision: decideCredentialSource({ identified: true, declaration, projectHas, granted: opened.grants !== null && findSecretGrant(opened.grants, name) !== null }), opened };
  };
  return Object.freeze({
    async check(name: string) { return (await decide(name)).decision; },
    async resolve(name: string) {
      const { decision, opened } = await decide(name);
      if (decision.source === 'refused') throw credentialSourceError(decision.code, { name, project: opened?.anchor.projectRoot ?? context.config.projectRoot, scopeId });
      return decision.source === 'project' ? opened!.store!.get(name) : configuredSecretResolver(context.config, options)(name);
    },
  });
}

/** Typed refusal before send (headless, Brain, runtime and terminal turns alike): the decision, never a transport error. */
export async function assertProjectCredential(context: ProjectSecretContext, scopeId: string, name: string, options: ConfigLoadOptions): Promise<void> {
  const decision = await projectCredentialResolver(context, scopeId, options).check(name);
  if (decision.source !== 'refused') return;
  const anchor = await resolveProjectVaultAnchor(context, options).catch(() => null);
  throw credentialSourceError(decision.code, { name, project: anchor?.projectRoot ?? context.config.projectRoot, scopeId });
}

const defaultWitness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() };
/** The human gate of every project-secret authority write (law audit MAJOR 2): the same terminal attestation as `approval decide`, refused for the
 * MCP actor and for any request relayed over the runtime socket (a peer); off a terminal (an agent's host shell) nothing is read or written. */
async function witnessed(write: string, witness: AuthorityWitness) {
  await assertAuthorityWitness(write, localPrincipalChannel() ?? (localPrincipalPeer() ? 'mcp' : undefined), witness);
}
/** Opens the project's vault for a writer: anchor required, directory created, ownership recorded (a copy is refused). */
async function writerContext(projectRoot: string, scopeId: string, options: ConfigLoadOptions) {
  const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), anchor = await resolveProjectVaultAnchor(context, options);
  if (!anchor) throw ErrorRegistry.createError('SECRET_PROJECT_IDENTITY_REQUIRED');
  const clock = new SystemTrustedClock(), root = globalRoot(options), directory = (await projectVaultDirectory(root, anchor, true))!;
  await admitProjectVault(directory, anchor, true, clock.sample().wallMs, lockMs(context));
  const open = async () => {
    const store = await openSqliteAuditStore(await context.path(), context.config.storage.sqlite, 'forbid');
    try { return { store, audit: new AuditApplication(store, await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile)) }; }
    catch (error) { store.close(); throw error; }
  };
  return { context, anchor, root, directory, clock, open };
}

/** `deckent secret grant|revoke NAME --scope S`: lend (or take back) main-vault key NAME to this project, decided on `secret`/`set` and sealed first. */
export async function changeProjectSecretGrant(projectRoot: string, scopeId: string, name: string, action: 'grant' | 'revoke', source: 'card' | 'admin',
  options: ConfigLoadOptions = {}, witness: AuthorityWitness = defaultWitness) {
  await witnessed('secretGrant', witness);
  const { context, anchor, root, clock, open } = await writerContext(projectRoot, scopeId, options), ledger = await open();
  try {
    const records = new AuthorityDecisionRecords(ledger.audit);
    const file = await decideSecretGrant({ principal: context.principal, scopeId, name, action, source, commandId: randomUUID() },
      { anchor, policy: context.document, record: (subject, atMs) => records.record(subject, atMs), store: openSecretGrantStore(root, anchor, lockMs(context)), now: () => clock.sample().wallMs });
    return Object.freeze({ name, project: anchor.projectRoot, granted: findSecretGrant(file, name) !== null, revision: file.revision });
  } finally { ledger.store.close(); }
}

/** `deckent secret set NAME --project`: the governed change (policy cell, `secret-change` audit before the write) on this project's own vault. */
export async function setProjectSecret(projectRoot: string, scopeId: string, name: string, value: string | null, options: ConfigLoadOptions = {}, witness: AuthorityWitness = defaultWitness) {
  await witnessed('secretSet', witness);
  const { context, anchor, directory, clock, open } = await writerContext(projectRoot, scopeId, options), ledger = await open(), { env, platform } = envOf(options);
  try {
    const store = openProjectVaultStore(directory, anchor, env, platform);
    const administration = new SecretStoreAdministration(store, policySecretChangeAuthorization(context.document, context.principal), event => { ledger.audit.record(event); },
      () => clock.sample().wallMs, { exclusive: work => withConfigWriteLock(join(directory, '.vault'), work, lockMs(context)), selected: async () => store.descriptor.id });
    const request = { principal: { issuer: context.principal.issuer, subject: context.principal.subject }, scopeId, name };
    if (value === null) return Object.freeze({ name, project: anchor.projectRoot, removed: await administration.delete(request) });
    await administration.set(request, value);
    return Object.freeze({ name, project: anchor.projectRoot, removed: false });
  } finally { ledger.store.close(); }
}

/** `deckent secret handover`: a moved project takes its vault along (only when the recorded owner's data root is gone). */
export async function handOverProjectSecrets(projectRoot: string, scopeId: string, options: ConfigLoadOptions = {}, witness: AuthorityWitness = defaultWitness) {
  await witnessed('secretHandover', witness);
  const context = await loadConfiguredScopeContext(projectRoot, scopeId, options, 'write'), anchor = await resolveProjectVaultAnchor(context, options);
  if (!anchor) throw ErrorRegistry.createError('SECRET_PROJECT_IDENTITY_REQUIRED');
  const directory = await projectVaultDirectory(globalRoot(options), anchor, false);
  if (!directory) throw projectVaultClaimed(anchor);
  const record = await handOverProjectVault(directory, anchor, new SystemTrustedClock().sample().wallMs, lockMs(context));
  return Object.freeze({ project: record.anchor.projectRoot, handedOverAtMs: record.handedOverAtMs });
}
