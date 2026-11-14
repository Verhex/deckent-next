import * as platform from '#platform/index.js';
import * as adapters from '#adapters/index.js';
import { openModelInspection } from '#composition/core/model-inspection/index.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEncryptedFileSecretStore, installationSecretRoot, listProjectVaults, observeOwnerRoot, openLocalIntegrityAuthority, openSecretGrantStore, openSqliteAuditStore, projectRepository, projectVaultDirectory, readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { inspectConfiguredSecretInventory, inspectSecretProjectTarget, changeProjectSecretGrant, handOverProjectSecrets, projectCredentialResolver, resolveProjectVaultAnchor, setProjectSecret } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext, resolveConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { PROJECT_VAULT, projectVaultKey } from '#engine/index.js';
import { clearConfigCache, getConfigFieldDefault, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  // A person accepts the moved identity at a terminal, as in installation-relocation.test.ts.
  vi.spyOn(adapters, 'attestLocalInteractiveTerminal').mockResolvedValue(true);
  vi.spyOn(platform, 'automationMarker').mockReturnValue(null);
});
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const MAIN_VALUE = 'synthetic-main-canary-7f3a', OWN_VALUE = 'synthetic-project-canary-91c2';
const SQLITE = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };
const human = { attest: async () => true }, noTerminal = { attest: async () => false };
const me = () => { const { issuer, subject } = readLocalOsIdentity(); return [{ issuer, subject }]; };
const policy = (secretSet = true) => JSON.stringify({ schemaVersion: 1, revision: secretSet ? 'owner' : 'member', restrictions: [], grants: [
  { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me(), resource: { kind: 'scope', ids: ['scope'] } },
  ...(secretSet ? [{ id: 'secrets', effect: 'allow', actions: ['set', 'delete'], scopes: ['scope'], principals: me(), resource: { kind: 'secret', ids: 'all' } }] : [])] });

async function home() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-project-vault-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const user = join(base, 'home');
  await mkdir(user, { mode: 0o700 });
  // The main vault is the environment backend here: the legacy installation-wide key (proje-wsl shape).
  return { base, env: { HOME: user, USERPROFILE: user, PATH: process.env.PATH ?? '/usr/bin:/bin', DECKENT_ANTHROPIC_KEY: MAIN_VALUE } };
}
/** An installed project has its ledger and integrity key (the grant decision is sealed there). */
async function installed(root: string) {
  const layout = resolveProductLayout({ projectRoot: root });
  (await openSqliteAuditStore(await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']), SQLITE, 'allow')).close();
  await openLocalIntegrityAuthority(layout, getConfigFieldDefault('approvals').keyFile, true);
}
async function project(base: string, name: string, secretSet = true) {
  const root = join(base, name);
  await mkdir(join(root, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ storage: { driver: 'sqlite' } }), { mode: 0o600 });
  await writeFile(join(root, '.deckent/policy.json'), policy(secretSet), { mode: 0o600 });
  await installed(root);
  return root;
}
const resolverOf = async (root: string, env: Record<string, string>) => {
  clearConfigCache();
  return projectCredentialResolver(await loadConfiguredScopeContext(root, 'scope', { env }, 'write'), 'scope', { env });
};
const code = async (work: Promise<unknown>) => work.then(() => null, (error: { code?: string }) => error.code ?? String(error));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

describe.skipIf(process.platform !== 'linux')('PRE-8 v2 project vault, .deck and grant at use', () => {
  it('migration: a legacy main key with no .deck is refused until one grant, then works without re-entering the key; the grant is sealed first', async () => {
    const { base, env } = await home(), root = await project(base, 'proje-wsl');
    expect(await (await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY')).toEqual({ source: 'refused', code: 'SECRET_GRANT_REQUIRED' });
    const refused = await (await resolverOf(root, env)).resolve('DECKENT_ANTHROPIC_KEY').catch((error: Error & { suggestion?: string }) => error);
    expect(refused).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect((refused as { suggestion?: string }).suggestion).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope scope');
    expect(JSON.stringify(refused)).not.toContain(MAIN_VALUE);
    clearConfigCache();
    expect(await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human)).toMatchObject({ granted: true, revision: 1 });
    expect(await (await resolverOf(root, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
    // The grant names the sealed authority-decision recorded before it (action secret-grant on the secret/set cell); no value anywhere.
    const anchor = (await resolveProjectVaultAnchor(await loadConfiguredScopeContext(root, 'scope', { env }, 'read'), { env }))!;
    const directory = join(installationSecretRoot(env)!, PROJECT_VAULT.directory, projectVaultKey(anchor));
    const grants = JSON.parse(await readFile(join(directory, PROJECT_VAULT.grantsFile), 'utf8'));
    const audit = await openSqliteAuditStore(join(root, '.deckent/state/ledger.db'), SQLITE, 'forbid');
    try {
      const decision = audit.page('scope', 0, 1_000).map(record => record.event).find(event => event.eventId === grants.grants[0].decisionEventId);
      expect(decision?.subject).toMatchObject({ kind: 'authority-decision', action: 'secret-grant', resource: { kind: 'secret', id: 'DECKENT_ANTHROPIC_KEY' }, verdict: { decision: 'allow' } });
    } finally { audit.close(); }
    expect(JSON.stringify(grants)).not.toContain(MAIN_VALUE);
    // Revoke: refused again.
    clearConfigCache();
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'revoke', 'admin', { env }, human);
    expect(await (await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY')).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
  });

  it('a grant needs the human terminal witness (never MCP, never off a terminal) and the secret/set cell; a refusal is sealed and grants nothing', async () => {
    const { base, env } = await home(), root = await project(base, 'p'), member = await project(base, 'member', false);
    expect(await code(changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'card', { env }, noTerminal))).toBe('AUTHORITY_WITNESS_REQUIRED');
    expect(await code(withMcpPrincipal(() => changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'card', { env }, human)))).toBe('AUTHORITY_WITNESS_REQUIRED');
    expect(await code(setProjectSecret(root, 'scope', 'OWN_KEY', OWN_VALUE, { env }, noTerminal))).toBe('AUTHORITY_WITNESS_REQUIRED');
    expect(await code(changeProjectSecretGrant(member, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human))).toBe('SECRET_CHANGE_DENIED');
    expect(await (await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY')).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(await (await resolverOf(member, env)).check('DECKENT_ANTHROPIC_KEY')).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    const audit = await openSqliteAuditStore(join(member, '.deckent/state/ledger.db'), SQLITE, 'forbid');
    try {
      expect(audit.page('scope', 0, 1_000).map(record => record.event.subject)).toContainEqual(expect.objectContaining({ kind: 'authority-decision', action: 'secret-grant', verdict: expect.objectContaining({ decision: 'deny' }) }));
    } finally { audit.close(); }
  });

  it('.deck: a project key is read only when declared; undeclared shadowing, a missing declared key and an invalid file are typed refusals', async () => {
    const { base, env } = await home(), root = await project(base, 'p');
    await setProjectSecret(root, 'scope', 'OPENAI_API_KEY', OWN_VALUE, { env }, human);
    // Undeclared but present in the project vault: never read (no shadowing), even with no grant on the main side.
    expect(await (await resolverOf(root, env)).check('OPENAI_API_KEY')).toMatchObject({ code: 'DECK_DECLARATION_REQUIRED' });
    await writeFile(join(root, '.deck'), '# references only\nDECK_FORMAT=1\nOPENAI_API_KEY=project\nGLM_KEY=project\nDECKENT_ANTHROPIC_KEY=main\n');
    expect(await (await resolverOf(root, env)).resolve('OPENAI_API_KEY')).toBe(OWN_VALUE);
    expect(await (await resolverOf(root, env)).check('GLM_KEY')).toMatchObject({ code: 'SECRET_PROJECT_MISSING' });
    // Declared main is still a grant: `.deck` alone never lends a key.
    expect(await (await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY')).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    await writeFile(join(root, '.deck'), 'DECK_FORMAT=1\nOPENAI_API_KEY=main:OTHER\n');
    expect(await code((await resolverOf(root, env)).check('OPENAI_API_KEY'))).toBe('DECK_FILE_INVALID');
    // p4 e6 (R17): a symlinked or non-regular `.deck` is `not-a-file`, never followed or read.
    const notAFile = async () => expect(await (await resolverOf(root, env)).check('OPENAI_API_KEY').catch((error: unknown) => error)).toMatchObject({ code: 'DECK_FILE_INVALID', params: { reason: 'not-a-file' } });
    await writeFile(join(base, 'elsewhere.deck'), 'DECK_FORMAT=1\nOPENAI_API_KEY=project\n'); await rm(join(root, '.deck'));
    await symlink(join(base, 'elsewhere.deck'), join(root, '.deck')); await notAFile();
    await unlink(join(root, '.deck')); await mkdir(join(root, '.deck')); await notAFile();
    expect(JSON.stringify(await readFile(join(installationSecretRoot(env)!, PROJECT_VAULT.directory), 'utf8').catch(() => ''))).not.toContain(OWN_VALUE);
  });

  it('two projects on one main vault: a grant or a project key of one never serves the other', async () => {
    const { base, env } = await home(), a = await project(base, 'a'), b = await project(base, 'b');
    await changeProjectSecretGrant(a, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    await setProjectSecret(a, 'scope', 'OWN_KEY', OWN_VALUE, { env }, human);
    await writeFile(join(b, '.deck'), 'DECK_FORMAT=1\nOWN_KEY=project\n');
    expect(await (await resolverOf(a, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
    expect(await (await resolverOf(b, env)).check('DECKENT_ANTHROPIC_KEY')).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    expect(await (await resolverOf(b, env)).check('OWN_KEY')).toMatchObject({ code: 'SECRET_PROJECT_MISSING' });
  });

  it('grants.json of another project, non-private, hard-linked or oversized grants nothing and is never overwritten; a grant is project-wide (owner B1 6)', async () => {
    const { base, env } = await home(), root = await project(base, 'p');
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    const anchor = (await resolveProjectVaultAnchor(await loadConfiguredScopeContext(root, 'scope', { env }, 'read'), { env }))!;
    const path = join(installationSecretRoot(env)!, PROJECT_VAULT.directory, projectVaultKey(anchor), PROJECT_VAULT.grantsFile);
    const granted = JSON.parse(await readFile(path, 'utf8'));
    // Owner B1 row 6 (a): a grant serves its project by name; its recorded scope is not compared with the asking one.
    await writeFile(path, JSON.stringify({ ...granted, grants: granted.grants.map((grant: object) => ({ ...grant, scopeId: 'another-scope' })) }));
    expect(await (await resolverOf(root, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
    const refusedUnchanged = async (expected: string) => {
      const before = await readFile(path);
      expect(await code((await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY'))).toBe(expected);
      clearConfigCache();
      expect(await code(changeProjectSecretGrant(root, 'scope', 'OTHER_KEY', 'grant', 'admin', { env }, human))).toBe(expected);
      expect((await readFile(path)).equals(before)).toBe(true);
    };
    await writeFile(path, JSON.stringify({ ...granted, projectId: randomUUID() })); await refusedUnchanged('SECRET_GRANT_STORE_INVALID');
    await writeFile(path, JSON.stringify(granted)); await chmod(path, 0o644); await refusedUnchanged('SECRET_GRANT_STORE_UNSAFE');
    await chmod(path, 0o600); await link(path, join(base, 'second')); await refusedUnchanged('SECRET_GRANT_STORE_UNSAFE'); await unlink(join(base, 'second'));
    await writeFile(path, ' '.repeat(PROJECT_VAULT.grantsMaxBytes + 1)); await refusedUnchanged('SECRET_GRANT_STORE_UNSAFE');
    // KG12 F6: `secret list --all` and uninstall list a vault whose ownership record is not private without a record, never failing the listing.
    const owner = join(dirname(path), PROJECT_VAULT.projectFile); await chmod(owner, 0o644);
    expect(await listProjectVaults(installationSecretRoot(env)!)).toEqual([{ directory: dirname(path), record: null }]); await chmod(owner, 0o600);
    // Owner decision A23 (KG12 F1): without getuid the vault folder and its grants are never private (no skipped owner check).
    await writeFile(path, JSON.stringify(granted)); const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')!;
    Object.defineProperty(process, 'getuid', { value: undefined, configurable: true });
    try {
      expect(await code(projectVaultDirectory(installationSecretRoot(env)!, anchor, false))).toBe('SECRET_STORE_UNSAFE');
      expect(await code(openSecretGrantStore(installationSecretRoot(env)!, anchor, 1_000).read())).toBe('SECRET_GRANT_STORE_UNSAFE');
    } finally { Object.defineProperty(process, 'getuid', getuid); }
  });

  it('a copied project (cp -r, then init identity --keep) cannot open the original vault; a move hands over only after the original is gone', async () => {
    const { base, env } = await home(), root = await project(base, 'orig');
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    const copy = join(base, 'copy');
    await cp(root, copy, { recursive: true });
    clearConfigCache();
    const relocated = await resolverOf(copy, env).catch((error: unknown) => error);
    expect(relocated).toMatchObject({ code: 'INSTALLATION_IDENTITY_RELOCATED' });
    for (const locale of ['en', 'tr'] as const) {
      const message = (relocated as platform.DeckentError).localize!(locale).message;
      expect(message).toContain('deckent init identity --keep');
      expect(message).toContain(locale === 'en' ? 'at your terminal' : 'terminalinizde');
    }
    const target = await inspectSecretProjectTarget(root, 'scope', { env });
    const vault = join(installationSecretRoot(env)!, PROJECT_VAULT.directory, projectVaultKey(target.anchor));
    const paths = [join(copy, '.deckent/installation-identity/identity.json'), join(copy, '.deckent/policy.json'),
      join(vault, PROJECT_VAULT.projectFile), join(vault, PROJECT_VAULT.grantsFile)];
    const before = await Promise.all(paths.map(path => readFile(path)));
    vi.mocked(platform.automationMarker).mockImplementation(markedEnv => markedEnv['AI_AGENT'] === '1' ? 'agent' : null);
    expect(await code(resolveConfiguredInstallationIdentity(copy, 'keep', { env: { ...env, AI_AGENT: '1' } })))
      .toBe('INSTALLATION_IDENTITY_REBIND_REQUIRED');
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before);
    vi.mocked(platform.automationMarker).mockReturnValue(null);
    expect(await resolveConfiguredInstallationIdentity(copy, 'keep', { env })).toMatchObject({ class: 'moved', basis: 'human-tty' });
    expect(await code((await resolverOf(copy, env)).check('DECKENT_ANTHROPIC_KEY'))).toBe('SECRET_PROJECT_VAULT_CLAIMED');
    expect(await code(handOverProjectSecrets(copy, 'scope', { env }, human))).toBe('SECRET_PROJECT_VAULT_CLAIMED');
    expect(await (await resolverOf(root, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
    // The original is gone (a move): the explicit handover moves the vault, after the human witness.
    await rm(root, { recursive: true, force: true });
    expect(await code(handOverProjectSecrets(copy, 'scope', { env }, noTerminal))).toBe('AUTHORITY_WITNESS_REQUIRED');
    await handOverProjectSecrets(copy, 'scope', { env }, human);
    expect(await (await resolverOf(copy, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
  });

  it('worktrees of one repository are one project (shared vault and grants); a copied worktree folder is refused', async () => {
    const { base, env } = await home(), root = await project(base, 'repo');
    const globalPath = platform.resolveGlobalConfigPaths(env).platformPath;
    await mkdir(dirname(globalPath), { recursive: true, mode: 0o700 });
    await writeFile(globalPath, JSON.stringify({ secrets: { store: 'core.secret-store.encrypted-file@1' } }), { mode: 0o600 });
    await createEncryptedFileSecretStore({ root: dirname(globalPath), platform: 'linux' }).set('DECKENT_ANTHROPIC_KEY', MAIN_VALUE);
    await writeFile(join(root, 'README'), 'x\n');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', 'README'); git(root, 'commit', '-q', '-m', 'init');
    const tree = join(base, 'repo-wt');
    git(root, 'worktree', 'add', '-q', tree, '-b', 'side');
    await mkdir(join(tree, '.deckent'), { recursive: true, mode: 0o700 });
    for (const file of ['config.json', 'policy.json']) await cp(join(root, '.deckent', file), join(tree, '.deckent', file));
    await installed(tree);
    await resolverOf(root, env); await resolverOf(tree, env); // existing identity bootstrap, before the read-only card preview
    const target = await inspectSecretProjectTarget(tree, 'scope', { env });
    expect(target).toMatchObject({ anchor: { projectRoot: root }, workingFolder: tree });
    expect(await inspectSecretProjectTarget(root, 'scope', { env })).toMatchObject({ anchor: target.anchor, workingFolder: root });
    const alias = join(base, 'alias'); await symlink(root, alias);
    expect(await inspectSecretProjectTarget(alias, 'scope', { env })).toEqual({ anchor: target.anchor, workingFolder: root });
    const granted = await changeProjectSecretGrant(tree, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human, target);
    expect(granted).toMatchObject({ project: root, granted: true });
    await writeFile(join(tree, '.deck'), 'DECK_FORMAT=1\nDECKENT_ANTHROPIC_KEY=main\n');
    const inventory = await inspectConfiguredSecretInventory(tree, 'scope', false, { env });
    expect(inventory.project).toBe(root); expect(inventory.workingFolder).toBe(tree);
    expect((await inspectConfiguredSecretInventory(alias, 'scope', false, { env })).project).toBe(root); expect(inventory.rows.find(row => row.name === granted.name)?.grant.state).toBe('granted');
    const vault = (await projectVaultDirectory(installationSecretRoot(env)!, target.anchor, false))!;
    const grantsPath = join(vault, PROJECT_VAULT.grantsFile), grantsBefore = await readFile(grantsPath, 'utf8');
    expect(JSON.parse(grantsBefore)).toMatchObject({ installationId: target.anchor.installationId, projectId: target.anchor.projectId });
    const ownerPath = join(vault, PROJECT_VAULT.projectFile), ownerBefore = await readFile(ownerPath, 'utf8');
    const audit = await openSqliteAuditStore(join(tree, '.deckent/state/ledger.db'), SQLITE, 'forbid');
    const decisionsBefore = audit.page('scope', 0, 1_000).length;
    expect(await code(changeProjectSecretGrant(tree, 'scope', 'OTHER_KEY', 'grant', 'admin', { env }, human, { ...target,
      anchor: { ...target.anchor, binding: { ...target.anchor.binding, inode: String(BigInt(target.anchor.binding.inode) + 1n) } } }))).toBe('SECRET_PROJECT_TARGET_CHANGED');
    const identityPath = join(platform.productResourcePath(resolveProductLayout({ projectRoot: root }), 'projectIdentity'), 'identity.json'), identity = await readFile(identityPath, 'utf8');
    await writeFile(identityPath, JSON.stringify({ ...JSON.parse(identity), projectId: randomUUID() })); clearConfigCache();
    const changed = await changeProjectSecretGrant(tree, 'scope', 'OTHER_KEY', 'grant', 'admin', { env }, human, target).catch((error: unknown) => error);
    expect(changed).toMatchObject({ code: 'SECRET_PROJECT_TARGET_CHANGED' });
    for (const locale of ['en', 'tr'] as const) expect((changed as platform.DeckentError).localize!(locale).message).toContain(locale === 'en' ? 'Nothing was granted' : 'İzin verilmedi');
    expect(await readFile(grantsPath, 'utf8')).toBe(grantsBefore); expect(await readFile(ownerPath, 'utf8')).toBe(ownerBefore);
    expect(audit.page('scope', 0, 1_000)).toHaveLength(decisionsBefore); audit.close();
    expect(await code(handOverProjectSecrets(tree, 'scope', { env }, human, target))).toBe('SECRET_PROJECT_TARGET_CHANGED');
    expect((await listProjectVaults(installationSecretRoot(env)!)).length).toBe(1);
    await writeFile(identityPath, identity); clearConfigCache();
    await setProjectSecret(tree, 'scope', 'OWN_KEY', OWN_VALUE, { env }, human);
    await writeFile(join(root, '.deck'), 'DECK_FORMAT=1\nOWN_KEY=project\n'); await cp(join(root, '.deck'), join(tree, '.deck'));
    expect(await (await resolverOf(tree, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
    expect(await (await resolverOf(root, env)).resolve('OWN_KEY')).toBe(OWN_VALUE);
    expect(await projectRepository(tree)).toMatchObject({ kind: 'linked', mainWorkTree: root });
    const loads = vi.spyOn(platform, 'loadConfig'), opening = await openModelInspection(tree, 'scope', { env });
    try {
      const context = await opening.context(), resolver = projectCredentialResolver(context, 'scope', { env }, opening);
      for (let read = 0; read < 3; read++) expect(await resolver.resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
      expect(loads).toHaveBeenCalledTimes(2); loads.mockRestore();
      await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'revoke', 'admin', { env }, human);
      expect(await code(resolver.resolve('DECKENT_ANTHROPIC_KEY'))).toBe('SECRET_GRANT_REQUIRED');
    } finally { opening.dispose(); loads.mockRestore(); }
    const copied = join(base, 'repo-wt-copy');
    await cp(tree, copied, { recursive: true });
    expect(await projectRepository(copied)).toEqual({ kind: 'foreign' });
    await rm(join(copied, '.deckent'), { recursive: true, force: true });
    await mkdir(join(copied, '.deckent'), { recursive: true, mode: 0o700 });
    for (const file of ['config.json', 'policy.json']) await cp(join(root, '.deckent', file), join(copied, '.deckent', file));
    expect(await code((await resolverOf(copied, env)).check('DECKENT_ANTHROPIC_KEY'))).toBe('SECRET_PROJECT_VAULT_CLAIMED');
  });
});

// Astra REVISE 2702 P1-B: only a truly new EMPTY vault is claimed automatically. A vault with any content (a key, a grant) whose ownership record is
// missing, JSON null or invalid is refused — never read, never re-claimed — until an explicit handover at the person's terminal.
describe.skipIf(process.platform !== 'linux')('REVISE 2702 P1-B: a vault whose ownership record is lost is refused, never read or re-claimed', () => {
  const vaultOf = async (root: string, env: Record<string, string>) => {
    const anchor = (await resolveProjectVaultAnchor(await loadConfiguredScopeContext(root, 'scope', { env }, 'read'), { env }))!;
    return join(installationSecretRoot(env)!, PROJECT_VAULT.directory, projectVaultKey(anchor));
  };
  for (const [label, damage] of [['missing', async (file: string) => rm(file)], ['JSON null', async (file: string) => writeFile(file, 'null\n', { mode: 0o600 })],
    ['invalid', async (file: string) => writeFile(file, '{"schemaVersion":1}\n', { mode: 0o600 })]] as const) {
    it(`${label} project.json beside a surviving grant and key: reads, writes and handover are all refused (REVISE 2704: no witness-only recovery)`, async () => {
      const { base, env } = await home(), root = await project(base, 'p');
      await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
      await setProjectSecret(root, 'scope', 'OWN_KEY', OWN_VALUE, { env }, human);
      await writeFile(join(root, '.deck'), 'DECK_FORMAT=1\nOWN_KEY=project\n');
      const directory = await vaultOf(root, env);
      await damage(join(directory, PROJECT_VAULT.projectFile));
      expect(await code((await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY'))).toBe('SECRET_PROJECT_VAULT_OWNERSHIP_LOST');
      expect(await code((await resolverOf(root, env)).resolve('OWN_KEY'))).toBe('SECRET_PROJECT_VAULT_OWNERSHIP_LOST');
      clearConfigCache();
      expect(await code(changeProjectSecretGrant(root, 'scope', 'OTHER_KEY', 'grant', 'admin', { env }, human))).toBe('SECRET_PROJECT_VAULT_OWNERSHIP_LOST');
      expect(await code(setProjectSecret(root, 'scope', 'OWN_KEY', 'x', { env }, human))).toBe('SECRET_PROJECT_VAULT_OWNERSHIP_LOST');
      // Never re-claimed silently: still no ownership record.
      await expect(readFile(join(directory, PROJECT_VAULT.projectFile), 'utf8').then(text => JSON.parse(text)?.anchor ?? null).catch(() => null)).resolves.toBeNull();
      expect(await code(handOverProjectSecrets(root, 'scope', { env }, noTerminal))).toBe('AUTHORITY_WITNESS_REQUIRED');
      // Astra REVISE 2704 A: a lost ownership record is never recovered by a handover (governed recovery is beta); the next step is a fresh identity.
      const refused = await handOverProjectSecrets(root, 'scope', { env }, human).catch((error: { code?: string; suggestion?: string }) => error);
      expect(refused).toMatchObject({ code: 'SECRET_PROJECT_VAULT_OWNERSHIP_LOST' });
      expect((refused as { suggestion?: string }).suggestion).toContain('deckent init identity --new');
      expect(await code((await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY'))).toBe('SECRET_PROJECT_VAULT_OWNERSHIP_LOST');
    });
  }
  it('a truly new empty vault is claimed by its first write; a reader of a never-written project creates nothing', async () => {
    const { base, env } = await home(), root = await project(base, 'fresh');
    expect(await (await resolverOf(root, env)).check('DECKENT_ANTHROPIC_KEY')).toMatchObject({ code: 'SECRET_GRANT_REQUIRED' });
    await expect(readFile(join(installationSecretRoot(env)!, PROJECT_VAULT.directory, 'x'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    const record = JSON.parse(await readFile(join(await vaultOf(root, env), PROJECT_VAULT.projectFile), 'utf8'));
    expect(record).toMatchObject({ schemaVersion: 1, anchor: { projectRoot: root }, handedOverAtMs: null });
    expect(await (await resolverOf(root, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
  });
});

// Astra REVISE 2704 A: a normal handover (intact record, original root gone) is authorized on the existing `secret`/`set` cell and sealed as an
// `authority-decision` BEFORE the binding changes; refused or unrecorded, nothing changes.
describe.skipIf(process.platform !== 'linux')('REVISE 2704 A: the handover is authorized and sealed before the binding changes', () => {
  const moved = async (where = 'orig') => {
    const { base, env } = await home();
    await mkdir(join(base, dirname(where)), { recursive: true });
    const root = await project(base, where);
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    const copy = join(base, 'moved');
    await cp(root, copy, { recursive: true });
    clearConfigCache(); await resolveConfiguredInstallationIdentity(copy, 'keep', { env });
    const anchor = (await resolveProjectVaultAnchor(await loadConfiguredScopeContext(copy, 'scope', { env }, 'read'), { env }))!;
    const record = join(installationSecretRoot(env)!, PROJECT_VAULT.directory, projectVaultKey(anchor), PROJECT_VAULT.projectFile);
    return { base, env, root, copy, record, grants: join(dirname(record), PROJECT_VAULT.grantsFile) };
  };
  it('an authorized move: the sealed secret-vault-handover decision precedes the new binding', async () => {
    const m = await moved();
    await rm(m.root, { recursive: true, force: true });
    await handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human);
    expect(JSON.parse(await readFile(m.record, 'utf8'))).toMatchObject({ anchor: { projectRoot: m.copy }, handedOverAtMs: expect.any(Number) });
    const audit = await openSqliteAuditStore(join(m.copy, '.deckent/state/ledger.db'), SQLITE, 'forbid');
    try {
      expect(audit.page('scope', 0, 1_000).map(record => record.event.subject)).toContainEqual(expect.objectContaining({ kind: 'authority-decision', action: 'secret-vault-handover',
        resource: { kind: 'secret', id: 'project-vault' }, verdict: expect.objectContaining({ decision: 'allow' }) }));
    } finally { audit.close(); }
    expect(await (await resolverOf(m.copy, m.env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
  });
  it('a member without secret/set is refused; the refusal is sealed and the binding is unchanged', async () => {
    const m = await moved(), before = await readFile(m.record, 'utf8');
    await rm(m.root, { recursive: true, force: true });
    await writeFile(join(m.copy, '.deckent/policy.json'), policy(false), { mode: 0o600 }); clearConfigCache();
    expect(await code(handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human))).toBe('SECRET_CHANGE_DENIED');
    expect(await readFile(m.record, 'utf8')).toBe(before);
    // REVISE 2706 evidence: the refusal itself is the sealed decision row.
    const audit = await openSqliteAuditStore(join(m.copy, '.deckent/state/ledger.db'), SQLITE, 'forbid');
    try {
      expect(audit.page('scope', 0, 1_000).map(record => record.event.subject)).toContainEqual(expect.objectContaining({ kind: 'authority-decision', action: 'secret-vault-handover',
        verdict: expect.objectContaining({ decision: 'deny' }) }));
    } finally { audit.close(); }
  });
  it('the original still present: refused, unchanged', async () => {
    const m = await moved(), before = await readFile(m.record, 'utf8');
    expect(await code(handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human))).toBe('SECRET_PROJECT_VAULT_CLAIMED');
    expect(await readFile(m.record, 'utf8')).toBe(before);
    // Same canonical path and inode, only the recorded device differs: never evidence of an abandoned owner (owner 80).
    const record = JSON.parse(before), grants = await readFile(m.grants, 'utf8');
    expect(await observeOwnerRoot(record.anchor.binding)).toBe('present');
    record.anchor.binding.device = String(BigInt(record.anchor.binding.device) + 1n);
    await writeFile(m.record, JSON.stringify(record));
    const uncertain = await readFile(m.record, 'utf8');
    expect(await observeOwnerRoot(record.anchor.binding)).toBe('uncertain');
    const failure = await handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(platform.DeckentError);
    expect(failure).toMatchObject({ code: 'SECRET_PROJECT_VAULT_OWNER_UNOBSERVABLE', params: { reason: 'uncertain' } });
    for (const locale of ['en', 'tr'] as const) {
      expect((failure as platform.DeckentError).localize!(locale).message).toContain(locale === 'en' ? 'disk device number differs' : 'disk aygıt numarası farklı');
    }
    expect(await code((await resolverOf(m.root, m.env)).resolve('DECKENT_ANTHROPIC_KEY'))).toBe('SECRET_PROJECT_VAULT_OWNER_UNOBSERVABLE');
    expect(await code(setProjectSecret(m.root, 'scope', 'OWN_KEY', OWN_VALUE, { env: m.env }, human))).toBe('SECRET_PROJECT_VAULT_OWNER_UNOBSERVABLE');
    expect(await readFile(m.record, 'utf8')).toBe(uncertain); expect(await readFile(m.grants, 'utf8')).toBe(grants);
    // Other inode remains gone; removing the original still permits today's witnessed, authorized handover.
    expect(await observeOwnerRoot({ ...record.anchor.binding, inode: String(BigInt(record.anchor.binding.inode) + 1n) })).toBe('gone');
    await rm(m.root, { recursive: true, force: true });
    expect(await observeOwnerRoot(record.anchor.binding)).toBe('gone');
    await handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human);
    expect(JSON.parse(await readFile(m.record, 'utf8')).anchor.projectRoot).toBe(m.copy);
    expect(await (await resolverOf(m.copy, m.env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
  });
  it('the decision cannot be written: nothing changes (binding and grants)', async () => {
    const m = await moved(), before = await readFile(m.record, 'utf8'), grants = await readFile(m.grants, 'utf8');
    await rm(m.root, { recursive: true, force: true });
    await rm(join(m.copy, '.deckent/state/ledger.db'));
    expect(await code(handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human))).not.toBeNull();
    expect(await readFile(m.record, 'utf8')).toBe(before); expect(await readFile(m.grants, 'utf8')).toBe(grants);
  });
});

describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)('REVISE 2706: handover proves the original gone; an unobservable original and a failed record write change nothing', () => {
  const movedAt = async (where: string) => {
    const { base, env } = await home(); await mkdir(join(base, dirname(where)), { recursive: true });
    const root = await project(base, where);
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    const copy = join(base, 'moved'); await cp(root, copy, { recursive: true });
    clearConfigCache(); await resolveConfiguredInstallationIdentity(copy, 'keep', { env });
    const anchor = (await resolveProjectVaultAnchor(await loadConfiguredScopeContext(copy, 'scope', { env }, 'read'), { env }))!;
    const record = join(installationSecretRoot(env)!, PROJECT_VAULT.directory, projectVaultKey(anchor), PROJECT_VAULT.projectFile);
    return { base, env, root, copy, record, grants: join(dirname(record), PROJECT_VAULT.grantsFile) };
  };
  it('the original is present but cannot be observed (EACCES on its parent): refused, binding and grants unchanged', async () => {
    const m = await movedAt('locked/orig'), before = await readFile(m.record, 'utf8'), grants = await readFile(m.grants, 'utf8');
    await chmod(join(m.base, 'locked'), 0o000);
    try { expect(await code(handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human))).toBe('SECRET_PROJECT_VAULT_OWNER_UNOBSERVABLE'); }
    finally { await chmod(join(m.base, 'locked'), 0o700); }
    expect(await readFile(m.record, 'utf8')).toBe(before); expect(await readFile(m.grants, 'utf8')).toBe(grants);
  });
  it('a truly moved original (gone): the authorized handover works', async () => {
    const m = await movedAt('away/orig');
    await rm(join(m.base, 'away'), { recursive: true, force: true });
    await handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human);
    expect(JSON.parse(await readFile(m.record, 'utf8'))).toMatchObject({ anchor: { projectRoot: m.copy } });
  });
  it('the decision record write fails inside the running store (an injected insert abort on the audit table): nothing changes', async () => {
    const m = await movedAt('busy/orig'), before = await readFile(m.record, 'utf8'), grants = await readFile(m.grants, 'utf8');
    await rm(join(m.base, 'busy'), { recursive: true, force: true });
    const ledger = new DatabaseSync(join(m.copy, '.deckent/state/ledger.db'));
    try { ledger.exec("CREATE TRIGGER pre8_injected_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected'); END;"); } finally { ledger.close(); }
    // The store still opens with the trigger (the failure is the decision's INSERT, not the open) …
    (await openSqliteAuditStore(join(m.copy, '.deckent/state/ledger.db'), SQLITE, 'forbid')).close();
    // … and the handover's sealed-decision write fails there: typed, before any binding change.
    expect(await code(handOverProjectSecrets(m.copy, 'scope', { env: m.env }, human))).toBe('AUDIT_UNAVAILABLE');
    expect(await readFile(m.record, 'utf8')).toBe(before); expect(await readFile(m.grants, 'utf8')).toBe(grants);
  });
});

it('refuses reserved sessions before generic resolution, admission checks or grant writes, including an injected resolver', async () => {
  const name = 'DECKENT_CREDENTIAL_SESSION_FIXTURE'; let called = false;
  const resolver = projectCredentialResolver({} as never, 'scope', { secretResolver: async () => { called = true; return MAIN_VALUE; } });
  await expect(resolver.check(name)).rejects.toMatchObject({ code: 'SECRET_SESSION_RESERVED' });
  await expect(resolver.resolve(name)).rejects.toMatchObject({ code: 'SECRET_SESSION_RESERVED' });
  await expect(changeProjectSecretGrant('unused', 'scope', name, 'grant', 'admin', {}, { attest: async () => { called = true; return true; } }))
    .rejects.toMatchObject({ code: 'SECRET_SESSION_RESERVED' });
  expect(called).toBe(false);
});

describe.skipIf(process.platform !== 'linux')('A6-3 service environment and main-vault grants (Astra 3042 R2)', () => {
  it('the autostarted service keeps a granted plain environment name, never an ungranted one or an unrelated token', async () => {
    const { ensureConfiguredRuntimeService } = await import('../../../src/composition/core/cli/index.js');
    const { grantedMainSecretNames } = await import('#composition/core/secrets/index.js');
    const { base, env: start } = await home(), root = await project(base, 'granted');
    await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ storage: { driver: 'sqlite' }, terminal: { serviceStartTimeoutMs: 1_000 } }), { mode: 0o600 });
    const env = { ...start, FIXTURE_PROVIDER_TOKEN: MAIN_VALUE, FIXTURE_UNGRANTED: 'not-granted', UNRELATED_TOKEN: 'leak' };
    expect(await grantedMainSecretNames(root, { env })).toEqual([]);
    expect(await changeProjectSecretGrant(root, 'scope', 'FIXTURE_PROVIDER_TOKEN', 'grant', 'admin', { env }, human)).toMatchObject({ granted: true });
    clearConfigCache();
    expect(await grantedMainSecretNames(root, { env })).toEqual(['FIXTURE_PROVIDER_TOKEN']);
    const launches: Array<{ env: Record<string, string> }> = [];
    await ensureConfiguredRuntimeService(root, { env }, async input => { launches.push(input); return { pid: 1 }; }, import.meta.filename).catch((error: unknown) => { if (!launches.length) throw error; });
    expect(launches[0]?.env).toMatchObject({ FIXTURE_PROVIDER_TOKEN: MAIN_VALUE, DECKENT_ANTHROPIC_KEY: MAIN_VALUE });
    expect(Object.keys(launches[0]?.env ?? {})).not.toContain('FIXTURE_UNGRANTED');
    expect(Object.keys(launches[0]?.env ?? {})).not.toContain('UNRELATED_TOKEN');
  }, 30_000);
});
