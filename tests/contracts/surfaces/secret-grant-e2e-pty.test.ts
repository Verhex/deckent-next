import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inPty } from '../support/pty-steps.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { createEncryptedFileSecretStore, installationSecretRoot, openSqliteAuditStore, registerProviderConfig } from '#adapters/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { PROJECT_VAULT } from '#engine/index.js';

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
  // A fresh ledger has no checkpoint yet (status unknown, exit 1 by contract); what matters is that every record parsed and chained.
  expect(verified).not.toContain('AUDIT_INTEGRITY'); expect(JSON.parse(verified)).toMatchObject({ scopeId: 'scope-a', head: { sequence: 1 } });
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
