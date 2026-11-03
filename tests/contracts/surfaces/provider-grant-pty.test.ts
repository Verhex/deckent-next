import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inPty, type Step } from '../support/pty-steps.js';
import { clearConfigCache, resolveGlobalConfigPaths } from '#platform/index.js';
import { createEncryptedFileSecretStore, installationSecretRoot, registerProviderConfig } from '#adapters/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { PROJECT_VAULT } from '#engine/index.js';

// Lead 2026-10-21: `/provider` must not dead-end on a fresh or migrated install. Listing a provider's models needs its main-vault key in this project:
// the window offers the SAME first-use card (same offer, same governed grant, same witness, solo only); yes → the list loads; no → nothing recorded.
const fixture = resolve('tests/contracts/surfaces/provider-grant-pty.fixture.mjs'), MAIN_VALUE = 'synthetic-provider-canary-7b2e', roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
beforeEach(async context => {
  if (process.platform !== 'linux') context.skip('PYTHON_PTY_LINUX_ONLY: the terminal witness is Linux /proc evidence (owner decision 6)');
  await access(resolve('dist/surfaces/core/cli-terminal/index.js'));
});
async function installation(profile: string | null) {
  registerProviderConfig();
  const root = await mkdtemp(join(tmpdir(), 'deckent-provider-grant-')); roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  await mkdir(project, { recursive: true }); await mkdir(home, { mode: 0o700 });
  await applyPolicyTemplateInstallation(project, 'scope-a', { env });
  (await openConfiguredAttemptStore(project, { env })).store.close();
  const globalPath = resolveGlobalConfigPaths(env).platformPath, globalRoot = dirname(globalPath);
  await mkdir(globalRoot, { recursive: true, mode: 0o700 }); await chmod(globalRoot, 0o700);
  await writeFile(globalPath, JSON.stringify({ secrets: { store: 'core.secret-store.encrypted-file@1' }, ...(profile ? { identity: { profile: { id: profile, version: 1 } } } : {}) }), { mode: 0o600 });
  await createEncryptedFileSecretStore({ root: globalRoot, platform: 'linux' }).set('DECKENT_FIXTURE_KEY', MAIN_VALUE);
  clearConfigCache();
  return { root, env };
}
const words = (text: string) => stripVTControlCharacters(text).replace(/[│╭╮╰╯─]/gu, ' ').replace(/\s+/gu, ' ');
const grants = async (env: Record<string, string>) => {
  const parent = join(installationSecretRoot(env)!, PROJECT_VAULT.directory), vaults = await readdir(parent).catch(() => [] as string[]);
  return vaults.length ? JSON.parse(await readFile(join(parent, vaults[0]!, PROJECT_VAULT.grantsFile), 'utf8').catch(() => '{"grants":[]}')).grants as unknown[] : [];
};
// Open the kind, its "connect a model" action: the model list needs the key.
const OPEN: readonly Step[] = [['OpenRouter', '\r'], ['Connect a model', '\u001b[B'], ['Connect a model', '\r', 'next']];

it('solo: listing the models asks the first-use card; y records the sealed grant and the list loads from the main key', async () => {
  const where = await installation(null);
  const out = words((await inPty(fixture, join(where.root, 'project'), { PRE8_E2E_ROOT: where.root, TERM: 'xterm-256color', NO_COLOR: '1', ...where.env }, 'en',
    [...OPEN, ['Use the main key DECKENT_FIXTURE_KEY in this project?', ''], ['y yes, grant', 'y', 'next'], ['FIXTURE-MODEL-AFTER-GRANT', '\u0003', 'fresh']])).output);
  expect(out).toContain(`FIXTURE-MODEL-AFTER-GRANT len=${MAIN_VALUE.length}`); expect(out).not.toContain(MAIN_VALUE);
  expect(await grants(where.env)).toEqual([expect.objectContaining({ name: 'DECKENT_FIXTURE_KEY', source: 'card' })]);
  // A62: the shipped registry + compiled provider/SIWC windows on a clean HOME under the checkout's home filesystem.
  // Fixture ports stop before OAuth/network I/O; existing native-headless tests exercise the CLI adapter separately.
  for (const locale of ['en', 'tr'] as const) {
    // Not the checkout root itself: the installed-package measurement observes that directory, so a sibling entry there reads as a changed package.
    const homes = resolve('node_modules/.cache/deckent-login-pty'); await mkdir(homes, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(join(homes, 'home-')); roots.push(home);
    const loginFixture = resolve('tests/contracts/surfaces/provider-login-pty.fixture.mjs');
    const api = locale === 'en' ? 'Connect with an API key' : 'API anahtarıyla bağlan';
    const signIn = locale === 'en' ? 'Sign in with ChatGPT' : 'ChatGPT ile giriş';
    const keys = locale === 'en' ? '↑/↓ select · Enter continue · Esc cancel' : '↑/↓ seç · Enter devam · Esc vazgeç';
    const noApi = locale === 'en' ? 'Sign in with ChatGPT (keep automatic API continuation off)' : 'ChatGPT ile giriş yap (otomatik API geçişi kapalı kalsın)';
    const failure = locale === 'en' ? 'session credentials must stay on' : 'oturum bilgileri bu bilgisayarın';
    const env = { HOME: home, USERPROFILE: home, DECKENT_GLOBAL_HOME: join(home, 'global'), XDG_CONFIG_HOME: join(home, '.config'), TERM: 'xterm-256color', NO_COLOR: '1' };
    const sign = words((await inPty(loginFixture, home, env, `chatgpt-${locale}`, [
      ['K13-HIDDEN-SIWC-BETA: fixture-only', ''], [keys, '\r', 'next'], [noApi, '\r', 'next'],
      ['FIXTURE-OAUTH-CONNECT-REACHED', ''], [failure, '\r'],
      [api, api], [`${locale === 'en' ? 'filter' : 'filtre'}: ${api}`, '\r', 'fresh'], [locale === 'en' ? 'API providers' : 'API sağlayıcıları', '\r', 'fresh'],
      [locale === 'en' ? 'Connect (enter the key' : 'Bağlan (anahtarı girin', '\r', 'next'],
      [locale === 'en' ? 'Masked' : 'Gizlenerek', '\u0003', 'fresh']])).output);
    expect(sign.match(/FIXTURE-OAUTH-CONNECT-REACHED/gu)).toHaveLength(1);
    expect(sign).not.toContain('Codex subscription workers'); expect(sign).not.toContain('Codex abonelik işçileri');
    expect(sign).toContain(locale === 'en' ? 'Sign in with Claude' : 'Claude ile giriş');
    // The beta custody denial remains exercised, while the public ChatGPT row is now the person's Codex CLI.
    expect(sign).toContain('K13-HIDDEN-SIWC-BETA: fixture-only');
    expect(sign).toContain(locale === 'en' ? 'Sign in with ChatGPT (Codex CLI)' : 'ChatGPT ile giriş (Codex CLI)');
    const claude = words((await inPty(loginFixture, home, env, `claude-${locale}`, [
      [signIn, 'Claude'], [`${locale === 'en' ? 'filter' : 'filtre'}: Claude`, '\r', 'fresh'], [locale === 'en' ? 'Sign in with its CLI and connect…' : "CLI'ıyla giriş yap ve bağla…", '\r', 'next'],
      [locale === 'en' ? 'Login directory' : 'Giriş dizini', '\r', 'next'],
      ['FIXTURE-CLI-LOGIN: completed', ''], [locale === 'en' ? 'Who may use this login now:' : 'Bu girişi şu an kim kullanabilir:', '\u0003']])).output);
    expect(claude).toContain('FIXTURE-CLI-LOGIN: completed');
  }

}, 120_000);
it('solo: n records nothing; the window names the command', async () => {
  const where = await installation(null);
  const out = words((await inPty(fixture, join(where.root, 'project'), { PRE8_E2E_ROOT: where.root, TERM: 'xterm-256color', NO_COLOR: '1', ...where.env }, 'en',
    [...OPEN, ['Use the main key DECKENT_FIXTURE_KEY in this project?', ''], ['y yes, grant', 'n', 'next'], ['SECRET_GRANT_REQUIRED', '\u0003', 'fresh']])).output);
  expect(out).toContain('deckent secret grant DECKENT_FIXTURE_KEY --scope scope-a');
  expect(await grants(where.env)).toEqual([]);
});
it('team: no card; the refusal names the admin command and nothing is recorded', async () => {
  const where = await installation('core:team');
  const out = words((await inPty(fixture, join(where.root, 'project'), { PRE8_E2E_ROOT: where.root, TERM: 'xterm-256color', NO_COLOR: '1', ...where.env }, 'en',
    [...OPEN, ['SECRET_GRANT_REQUIRED', '\u0003', 'fresh']])).output);
  expect(out).not.toContain('Use the main key'); expect(out).toContain('an admin grants it');
  expect(await grants(where.env)).toEqual([]);
});
it('solo: a key just stored from /provider is offered to this project with the same card; y records the grant before the result', async () => {
  const where = await installation(null);
  const out = words((await inPty(fixture, join(where.root, 'project'), { PRE8_E2E_ROOT: where.root, TERM: 'xterm-256color', NO_COLOR: '1', ...where.env }, 'en',
    [['OpenRouter', '\r'], ['Replace the key', '\r', 'next'], ['Masked; it is never shown again', 'synthetic-typed-key\r', 'next'], ['Use the main key DECKENT_FIXTURE_KEY in this project?', ''],
      ['y yes, grant', 'y', 'next'], ['Connected: OpenRouter', '\u0003', 'fresh']])).output);
  expect(out).not.toContain('synthetic-typed-key');
  expect(await grants(where.env)).toEqual([expect.objectContaining({ name: 'DECKENT_FIXTURE_KEY', source: 'card' })]);
});
