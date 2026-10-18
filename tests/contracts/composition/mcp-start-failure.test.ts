import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { mcpStartFailureText, run } from '#composition/core/mcp/index.js';
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
