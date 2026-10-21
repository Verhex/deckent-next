import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installationSecretRoot, openLocalIntegrityAuthority, openSqliteAuditStore, projectRepository, readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { changeProjectSecretGrant, handOverProjectSecrets, projectCredentialResolver, resolveProjectVaultAnchor, setProjectSecret } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext, resolveConfiguredInstallationIdentity } from '#composition/core/scoped-request/index.js';
import { PROJECT_VAULT, projectVaultKey } from '#engine/index.js';
import { clearConfigCache, getConfigFieldDefault, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { clearConfigCache(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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

  it('a copied project (cp -r, then init identity --keep) cannot open the original vault; a move hands over only after the original is gone', async () => {
    const { base, env } = await home(), root = await project(base, 'orig');
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    const copy = join(base, 'copy');
    await cp(root, copy, { recursive: true });
    clearConfigCache();
    expect(await code(resolverOf(copy, env))).toBe('INSTALLATION_IDENTITY_RELOCATED');
    await resolveConfiguredInstallationIdentity(copy, 'keep', { env });
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
    await writeFile(join(root, 'README'), 'x\n');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', 'README'); git(root, 'commit', '-q', '-m', 'init');
    const tree = join(base, 'repo-wt');
    git(root, 'worktree', 'add', '-q', tree, '-b', 'side');
    await mkdir(join(tree, '.deckent'), { recursive: true, mode: 0o700 });
    for (const file of ['config.json', 'policy.json']) await cp(join(root, '.deckent', file), join(tree, '.deckent', file));
    await installed(tree);
    await changeProjectSecretGrant(root, 'scope', 'DECKENT_ANTHROPIC_KEY', 'grant', 'admin', { env }, human);
    await setProjectSecret(tree, 'scope', 'OWN_KEY', OWN_VALUE, { env }, human);
    await writeFile(join(root, '.deck'), 'DECK_FORMAT=1\nOWN_KEY=project\n'); await cp(join(root, '.deck'), join(tree, '.deck'));
    expect(await (await resolverOf(tree, env)).resolve('DECKENT_ANTHROPIC_KEY')).toBe(MAIN_VALUE);
    expect(await (await resolverOf(root, env)).resolve('OWN_KEY')).toBe(OWN_VALUE);
    expect(await projectRepository(tree)).toMatchObject({ kind: 'linked', mainWorkTree: root });
    const copied = join(base, 'repo-wt-copy');
    await cp(tree, copied, { recursive: true });
    expect(await projectRepository(copied)).toEqual({ kind: 'foreign' });
    await rm(join(copied, '.deckent'), { recursive: true, force: true });
    await mkdir(join(copied, '.deckent'), { recursive: true, mode: 0o700 });
    for (const file of ['config.json', 'policy.json']) await cp(join(root, '.deckent', file), join(copied, '.deckent', file));
    expect(await code((await resolverOf(copied, env)).check('DECKENT_ANTHROPIC_KEY'))).toBe('SECRET_PROJECT_VAULT_CLAIMED');
  });
});
