import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mcpConfigLanguage, mcpHelpRequested, mcpHelpText, mcpStartFailureText, run } from '#composition/core/mcp/index.js';
import { DeckentError, ErrorRegistry, t } from '#platform/index.js';

// g2-mcp-hata (analysis 2026-10-18): a failed deckent-mcp start said only MCP_START_FAILED. The first stderr line stays exactly that (clients
// and the launch-argument tests key on it); a typed Deckent error adds its localized message and code, any other error adds nothing.
const roots: string[] = [], home = process.env['HOME'];
afterEach(async () => { if (home === undefined) delete process.env['HOME']; else process.env['HOME'] = home; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('a typed Deckent error is named with its localized message and code, in English and Turkish; stdout stays untouched', () => {
  const error = ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE');
  const en = mcpStartFailureText(error, { LANG: 'en_US.UTF-8' }), tr = mcpStartFailureText(error, { DECKENT_LANG: 'tr' });
  expect(en.split('\n')[0]).toBe('MCP_START_FAILED');
  expect(en).toContain(t('error.LOCAL_RUNTIME_UNAVAILABLE', {}, 'en')); expect(en).toContain('[LOCAL_RUNTIME_UNAVAILABLE]');
  expect(tr).toContain(t('error.LOCAL_RUNTIME_UNAVAILABLE', {}, 'tr')); expect(tr).toContain('[LOCAL_RUNTIME_UNAVAILABLE]');
  expect(en).not.toContain('\u001b['); expect(en.endsWith('\n')).toBe(true);
});

it('an untyped failure (launch arguments) stays the bare line', () => {
  expect(mcpStartFailureText(new Error('MCP_PROJECT_INVALID'))).toBe('MCP_START_FAILED\n');
  expect(mcpStartFailureText(Object.assign(new TypeError('Unknown option'), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' }))).toBe('MCP_START_FAILED\n');
});

it('the real start path: a project whose configuration cannot load fails with a typed error that the line names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-start-')); roots.push(root);
  process.env['HOME'] = join(root, 'home'); await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'project', '.deckent'), { recursive: true, mode: 0o700 }); await writeFile(join(root, 'project', '.deckent', 'config.json'), '{ not json', { mode: 0o600 });
  const failure = await run(['--project', join(root, 'project')]).then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(DeckentError);
  const text = mcpStartFailureText(failure, { LANG: 'en_US.UTF-8' });
  expect(text.split('\n')[0]).toBe('MCP_START_FAILED'); expect(text).toContain(`[${(failure as DeckentError).code}]`);
});

// inbox 2026-10-21: `deckent-mcp --help` fell into the strict option parser, so a request for help printed MCP_START_FAILED. Help is answered
// before any start work: usage on stdout in the resolved language, exit 0; every real start failure keeps its non-zero exit.
it('--help / -h is recognized before the parser; other options are not help', () => {
  expect(mcpHelpRequested(['--help'])).toBe(true); expect(mcpHelpRequested(['--project', 'x', '-h'])).toBe(true);
  expect(mcpHelpRequested(['--project', 'x'])).toBe(false); expect(mcpHelpRequested(['--bogus'])).toBe(false);
});
it('the help text names the usage and the project option, in English and Turkish, with no MCP_START_FAILED', () => {
  const en = mcpHelpText({ LANG: 'en_US.UTF-8' }), tr = mcpHelpText({ DECKENT_LANG: 'tr' });
  expect(en).toContain('deckent-mcp'); expect(en).toContain('--project'); expect(tr).toContain('--project'); expect(tr).not.toBe(en);
  expect(en + tr).not.toContain('MCP_START_FAILED'); expect(en.endsWith('\n')).toBe(true);
});
it.skipIf(process.platform === 'win32')('the real built entry: --help prints help on stdout and exits 0; an unknown option still fails non-zero', async () => {
  const entry = fileURLToPath(new URL('../../../dist/composition/core/mcp/internal/entry.js', import.meta.url));
  const env = { PATH: process.env['PATH'] ?? '', HOME: tmpdir(), LANG: 'en_US.UTF-8' };
  const help = spawnSync(process.execPath, [entry, '--help'], { env, encoding: 'utf8', input: '' });
  expect(help.status).toBe(0); expect(help.stdout).toContain('--project'); expect(help.stderr).toBe('');
  const bad = spawnSync(process.execPath, [entry, '--bogus'], { env, encoding: 'utf8', input: '' });
  expect(bad.status).not.toBe(0); expect(bad.stderr.split('\n')[0]).toBe('MCP_START_FAILED'); expect(bad.stdout).toBe('');
});

// alpha.53 D3: the help and the start-failure line follow the project's configured language, not only LANG/DECKENT_LANG.
it('config language drives the help text and the failure line when the environment says nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-mcp-lang-')); roots.push(root);
  await mkdir(join(root, 'home'), { recursive: true }); await mkdir(join(root, 'project', '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'project', '.deckent', 'config.json'), JSON.stringify({ schema_version: 3, language: 'tr' }), { mode: 0o600 });
  const env = { HOME: join(root, 'home'), LANG: 'C' };
  const language = await mcpConfigLanguage(['--project', join(root, 'project')], env);
  expect(language).toBe('tr');
  expect(mcpHelpText(env, language)).toBe(mcpHelpText({ DECKENT_LANG: 'tr' })); expect(mcpHelpText(env, language)).not.toBe(mcpHelpText(env));
  expect(await mcpConfigLanguage(['--project', join(root, 'missing')], env)).toBeUndefined();
  const failure = mcpStartFailureText(ErrorRegistry.createError('LOCAL_RUNTIME_UNAVAILABLE'), env, language);
  expect(failure).toContain(t('error.LOCAL_RUNTIME_UNAVAILABLE', {}, 'tr'));
});
