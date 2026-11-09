import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { t, type Locale } from '#platform/index.js';
import { DRIVER, type Step } from '../support/pty-steps.js';
const execute = promisify(execFile);
const roots: string[] = [], fixture = resolve('tests/contracts/surfaces/subscription-surface-pty.fixture.mjs');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function walk(locale: Locale, surface: 'provider' | 'onboarding') {
  if (process.platform !== 'linux') return 'PTY_LINUX_ONLY';
  await access(resolve('dist/surfaces/core/terminal-provider/index.js'));
  const root = await mkdtemp(join(tmpdir(), 'deckent-k13-pty-')); roots.push(root);
  const env = { HOME: root, USERPROFILE: root, DECKENT_GLOBAL_HOME: join(root, 'global'), XDG_CONFIG_HOME: join(root, '.config'),
    K13_REQUESTS: join(root, 'requests.jsonl'), TERM: 'xterm-256color', NO_COLOR: '1' };
  await mkdir(join(root, '.deckent'), { mode: 0o700 }); await writeFile(join(root, '.deckent/config.json'), '{}', { mode: 0o600 });
  const sign = locale === 'en' ? 'Sign in with ChatGPT (Codex CLI)' : 'ChatGPT ile giriş (Codex CLI)';
  const steps: Step[] = [[sign, 'ChatGPT'], [locale === 'en' ? 'filter: ChatGPT' : 'filtre: ChatGPT', '\r', 'next'],
    [t('tui.provider.login.action', {}, locale).replace('…', ''), '\r', 'next'], [t('tui.provider.login.dirTitle', {}, locale), '\r', 'next'],
    [t('headless.agent.login.methodTitle', {}, locale), '\u001b', 'next'],
    [t('tui.provider.login.dirTitle', {}, locale), '\r', 'fresh'], [t('headless.agent.login.methodTitle', {}, locale), '\u001b[B\r', 'fresh'],
    ['K13-SYNTHETIC-LOGIN: device-auth', '', 'fresh'], [t('tui.provider.login.configPolicy', {}, locale), '\u0003', 'next']];
  // Report a missing screen inside this test's 30 s bound, retaining the transcript on failure as well.
  const { stdout } = await execute('python3', ['-c', DRIVER.replaceAll('time.time() + 40', 'time.time() + 12'),
    JSON.stringify([process.execPath, fixture, `${surface}-${locale}`]), JSON.stringify(steps), 'tty'],
  { cwd: root, env: { ...process.env, ...env }, timeout: 28_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { output: string; timeout?: string };
  if (process.env['K13_PROOF_DIR']) await writeFile(join(process.env['K13_PROOF_DIR'], `${surface}-${locale}${process.env['CI'] === 'true' ? '-ci' : ''}.pty.txt`), result.output);
  expect(result.timeout, stripVTControlCharacters(result.output).slice(-3000)).toBeUndefined();
  const text = stripVTControlCharacters(result.output);
  expect(text).toContain(sign);
  expect(text).toContain(t('headless.agent.login.method.device-auth', {}, locale));
  expect(text).not.toContain(locale === 'en' ? 'Sign in with ChatGPT (keep automatic API continuation off)' : 'ChatGPT ile giriş yap (otomatik API geçişi kapalı kalsın)');
  expect((await readFile(env.K13_REQUESTS, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([{ connection: 'codex-cli-subscription', loginMethod: 'device-auth' }]);
  return 'walked';
}
it('K13 real PTY: compiled /provider in English chooses the device method after Esc with no earlier sign-in', async context => {
  if (await walk('en', 'provider') === 'PTY_LINUX_ONLY') context.skip('PTY_LINUX_ONLY');
});
it('K13 real PTY: compiled onboarding in Turkish uses the same methods and typed command', async context => {
  if (await walk('tr', 'onboarding') === 'PTY_LINUX_ONLY') context.skip('PTY_LINUX_ONLY');
});
