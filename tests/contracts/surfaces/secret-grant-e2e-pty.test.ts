import { execFile, execFileSync, spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DRIVER, inPty } from '../support/pty-steps.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { createEncryptedFileSecretStore, installationSecretRoot, openSqliteAuditStore, registerProviderConfig } from '#adapters/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '../support/configured-open.js';
import { inspectSecretProjectTarget } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { PROJECT_VAULT, projectVaultKey } from '#engine/index.js';

// PRE-8 v2 end to end (lead fan-in check): a proje-wsl-shaped installation (first-run policy, legacy main key in the encrypted store, no .deck)
// → the terminal turn is refused SECRET_GRANT_REQUIRED → the first-use card → y → the REAL governed grant (witness, secret/set, sealed decision,
// grants.json) → the same message is answered from the main vault, without re-entering the key. Off a terminal the same grant is refused.
const fixture = resolve('tests/contracts/surfaces/secret-grant-e2e-pty.fixture.mjs'), cli = resolve('dist/composition/core/cli/internal/entry.js');
const MAIN_VALUE = 'synthetic-main-canary-e2e-5d1f', roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeEach(async context => {
  if (process.platform !== 'linux') context.skip('PYTHON_PTY_LINUX_ONLY: the terminal witness is Linux /proc evidence (owner decision 6)');
  await access(resolve('dist/composition/core/secrets/index.js')); await access(cli);
});
async function installation() {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'deckent-grant-e2e-')); roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  await mkdir(project, { recursive: true }); await mkdir(home, { mode: 0o700 });
  await applyPolicyTemplateInstallation(project, 'scope-a', { env });
  (await openConfiguredAttemptStore(project, { env })).store.close();
  const globalPath = resolveGlobalConfigPaths(env).platformPath, globalRoot = dirname(globalPath);
  await mkdir(globalRoot, { recursive: true, mode: 0o700 }); await chmod(globalRoot, 0o700);
  await writeFile(globalPath, JSON.stringify({ secrets: { store: 'core.secret-store.encrypted-file@1' } }), { mode: 0o600 });
  await createEncryptedFileSecretStore({ root: globalRoot, platform: 'linux' }).set('DECKENT_ANTHROPIC_KEY', MAIN_VALUE);
  clearConfigCache();
  return { root, home, project, env };
}
const words = (text: string) => stripVTControlCharacters(text).replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/gu, ' ');

it('legacy main key, no .deck: refused, one card, y → sealed grant → the same turn is answered from the main vault; nothing echoes the value', async () => {
  const where = await installation();
  const raw = await inPty(fixture, where.project, { PRE8_E2E_ROOT: where.root, TERM: 'xterm-256color', NO_COLOR: '1', ...where.env }, 'en',
    [['READY', 'hello\r'], ['Use the main key DECKENT_ANTHROPIC_KEY in this project?', ''], ['y yes, grant', 'y', 'next'], ['ANSWER-AFTER-GRANT', '\u0003\u0003', 'fresh']]);
  const out = words(raw.output);
  expect(out).toContain(`ANSWER-AFTER-GRANT len=${MAIN_VALUE.length}`); expect(out).not.toContain(MAIN_VALUE);
  const secretRoot = installationSecretRoot(where.env)!, [vault] = await readdir(join(secretRoot, PROJECT_VAULT.directory));
  const grants = JSON.parse(await readFile(join(secretRoot, PROJECT_VAULT.directory, vault!, PROJECT_VAULT.grantsFile), 'utf8'));
  expect(grants.grants).toEqual([expect.objectContaining({ name: 'DECKENT_ANTHROPIC_KEY', scopeId: 'scope-a', source: 'card' })]);
  const opened = await openConfiguredAttemptStore(where.project, { env: where.env }); const ledger = opened.path; opened.store.close();
  const audit = await openSqliteAuditStore(ledger, { busyTimeoutMs: 1_000, journalMode: 'wal', durability: 'full' }, 'forbid');
  try {
    const decision = audit.page('scope-a', 0, 1_000).find(record => record.event.eventId === grants.grants[0].decisionEventId);
    expect(decision?.event.subject).toMatchObject({ kind: 'authority-decision', action: 'secret-grant', resource: { kind: 'secret', id: 'DECKENT_ANTHROPIC_KEY' }, verdict: { decision: 'allow' } });
  } finally { audit.close(); }
  // Rollback (alpha.50): the audit schema, store and verifier are unchanged since 71bb7b81, so the shipped `audit verify` here is alpha.50's
  // verifier on the same ledger — the sealed grant decision is an existing `authority-decision` and the chain still verifies.
  const verify = spawn(process.execPath, [cli, 'audit', 'verify', '--scope', 'scope-a', '--json'], { cwd: where.project,
    env: { PATH: process.env['PATH'] ?? '', ...where.env, DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let verified = ''; verify.stdout!.on('data', chunk => { verified += String(chunk); }); verify.stderr!.on('data', chunk => { verified += String(chunk); });
  await new Promise(done => verify.once('exit', done));
  // B1 records the system-row publication before the grant; this fixture starts no checkpoint service. The ledger has no checkpoint yet (status unknown, exit 1 by contract); what matters is that every record parsed and chained.
  expect(verified).not.toContain('AUDIT_INTEGRITY'); expect(JSON.parse(verified)).toMatchObject({ scopeId: 'scope-a', head: { sequence: 2 } });
});

it('off a terminal (a pipe, or a detached agent-shell-shaped child) the grant is refused before anything is read or written', async () => {
  const where = await installation();
  for (const detached of [false, true]) {
    const child = spawn(process.execPath, [cli, 'secret', 'grant', 'DECKENT_ANTHROPIC_KEY', '--scope', 'scope-a', '--json'], { cwd: where.project,
      env: { PATH: process.env['PATH'] ?? '', ...where.env, DECKENT_LANGUAGE: 'en', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached });
    let text = ''; child.stdout!.on('data', chunk => { text += String(chunk); }); child.stderr!.on('data', chunk => { text += String(chunk); });
    const code = await new Promise(done => child.once('exit', done));
    expect(code, String(detached)).not.toBe(0); expect(text).toContain('AUTHORITY_WITNESS_REQUIRED');
  }
  await expect(access(join(installationSecretRoot(where.env)!, PROJECT_VAULT.directory))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('from a linked worktree the real CLI card, grant result, durable grant and list all name the main project (EN/TR)', async () => {
  const where = await installation(), tree = join(where.root, 'worktree');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: where.project, stdio: 'pipe', env: { ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  await writeFile(join(where.project, 'README'), 'fixture\n');
  git('init', '-q', '-b', 'main'); git('add', 'README'); git('commit', '-q', '-m', 'fixture'); git('worktree', 'add', '-q', tree, '-b', 'side');
  await applyPolicyTemplateInstallation(tree, 'scope-a', { env: where.env });
  (await openConfiguredAttemptStore(tree, { env: where.env })).store.close();
  const target = await inspectSecretProjectTarget(tree, 'scope-a', { env: where.env });
  const local = await loadConfiguredScopeContext(tree, 'scope-a', { env: where.env }, 'read');
  expect(target.anchor.projectRoot).toBe(where.project); expect(target.anchor.projectId).not.toBe(local.projectId);
  const execute = promisify(execFile), env = { PATH: process.env['PATH'] ?? '', ...where.env, TERM: 'xterm-256color', NO_COLOR: '1' };
  for (const locale of ['en', 'tr'] as const) {
    const steps = [[locale === 'en' ? 'Current working folder:' : 'Çalıştığınız klasör:', 'y']];
    const result = await execute('python3', ['-c', DRIVER, JSON.stringify([process.execPath, cli, 'secret', 'grant', 'DECKENT_ANTHROPIC_KEY', '--scope', 'scope-a', '--lang', locale]), JSON.stringify(steps), 'tty', 'until-exit'],
      { cwd: tree, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const run = JSON.parse(result.stdout) as { status: number; timeout?: string; output: string }, output = words(run.output);
    expect(run.timeout).toBeUndefined(); expect(run.status).toBe(0);
    expect(output).toContain(locale === 'en' ? `in the project ${where.project}?` : `${where.project} projesinde kullanılsın mı?`);
    expect(output).toContain(locale === 'en' ? 'worktrees share this key permission' : 'anahtar iznini paylaşır'); expect(output).toContain(tree);
    expect(output).toContain(locale === 'en' ? `may now be used in ${where.project}.` : `artık ${where.project} projesinde kullanılabilir.`);
    expect(output).not.toContain(MAIN_VALUE);
    const listed = await execute(process.execPath, [cli, 'secret', 'list', '--scope', 'scope-a', '--json'], { cwd: tree, env });
    expect(JSON.parse(listed.stdout)).toMatchObject({ project: where.project, rows: expect.arrayContaining([expect.objectContaining({ name: 'DECKENT_ANTHROPIC_KEY', grant: expect.objectContaining({ state: 'granted' }) })]) });
    const file = JSON.parse(await readFile(join(installationSecretRoot(where.env)!, PROJECT_VAULT.directory, projectVaultKey(target.anchor), PROJECT_VAULT.grantsFile), 'utf8'));
    expect(file).toMatchObject({ schemaVersion: 1, installationId: target.anchor.installationId, projectId: target.anchor.projectId });
    expect(JSON.stringify(file)).not.toContain(tree);
  }
});
