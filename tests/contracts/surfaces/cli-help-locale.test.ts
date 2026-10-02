import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { main } from '#surfaces/core/cli/index.js';

let temporary: string, root: string, globalRoot: string, env: NodeJS.ProcessEnv;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'deckent-help-locale-'));
  root = join(temporary, 'project'); globalRoot = join(temporary, 'global');
  await mkdir(join(root, '.deckent'), { recursive: true });
  await mkdir(globalRoot);
  env = { HOME: temporary, DECKENT_GLOBAL_HOME: globalRoot, LANG: 'en_US.UTF-8', NO_COLOR: '1' };
});
afterEach(async () => { await rm(temporary, { recursive: true, force: true }); });

async function config(language: string, global = false) {
  await writeFile(join(global ? globalRoot : join(root, '.deckent'), 'config.json'), JSON.stringify({ schema_version: 3, language }));
}
async function help(argv: readonly string[], language: 'en' | 'tr') {
  let output = '', errors = '', observedLocale = '';
  expect(await main(argv, { root, env,
    initialize: () => { throw new Error('Help must not initialize execution'); },
    onLocale: locale => { observedLocale = locale; },
    stdout: { write: text => { output += text; } }, stderr: { write: text => { errors += text; } },
  })).toBe(0);
  expect(errors).toBe(''); expect(observedLocale).toBe(language);
  const fixtures = new URL('../../fixtures/cli-help/', import.meta.url);
  const golden = argv[0] === 'run'
    ? (JSON.parse(await readFile(new URL(`commands-${language}.json`, fixtures), 'utf8')) as Record<string, string>)['run']
    : await readFile(new URL(`top-${language}.txt`, fixtures), 'utf8');
  expect(output).toBe(golden);
}

it.each([['-h'], ['--help'], ['run', '--help']])('uses the project Turkish config for %j', async (...argv) => {
  await config('tr'); await help(argv, 'tr');
});
it('uses global language when project language is absent', async () => {
  await config('tr', true); await help(['-h'], 'tr');
});
it('reads language before provider sections are registered', async () => {
  await writeFile(join(root, '.deckent', 'config.json'), JSON.stringify({ schema_version: 3, language: 'tr',
    provider_invocation_profiles: { schemaVersion: 1, profiles: [] }, operations: { catalog: [] },
  }));
  await help(['-h'], 'tr');
});
it('uses the system locale when config language is absent', async () => {
  env['LANG'] = 'tr_TR.UTF-8'; await help(['-h'], 'tr');
});
it('prefers project language over global language', async () => {
  await config('en', true); await config('tr'); await help(['run', '--help'], 'tr');
});
it('prefers explicit language over config and environment', async () => {
  await config('tr'); env['DECKENT_LANGUAGE'] = 'tr';
  await help(['-h', '--lang', 'en'], 'en');
});
it.each(['DECKENT_LANGUAGE', 'DECKENT_LANG'])('prefers %s over config', async key => {
  await config('tr'); env[key] = 'en'; await help(['run', '--help'], 'en');
});
it('prefers DECKENT_LANGUAGE over DECKENT_LANG', async () => {
  await config('tr'); env['DECKENT_LANGUAGE'] = 'en'; env['DECKENT_LANG'] = 'tr';
  await help(['-h'], 'en');
});
it.each(['{broken', '{"schema_version":3,"language":"invalid"}', '[]'])('silently falls back without healing invalid config %s', async text => {
  const path = join(root, '.deckent', 'config.json');
  await writeFile(path, text); await help(['-h'], 'en');
  expect(await readFile(path, 'utf8')).toBe(text);
  expect(await readdir(join(root, '.deckent'))).toEqual(['config.json']);
  expect(await readdir(globalRoot)).toEqual([]);
});
it('silently falls back from invalid global config', async () => {
  await writeFile(join(globalRoot, 'config.json'), '{broken'); await help(['run', '--help'], 'en');
  expect(await readFile(join(globalRoot, 'config.json'), 'utf8')).toBe('{broken');
  expect(await readdir(globalRoot)).toEqual(['config.json']);
});
it('uses the default with missing config and creates no files', async () => {
  await help(['-h'], 'en');
  expect(await readdir(join(root, '.deckent'))).toEqual([]);
  expect(await readdir(globalRoot)).toEqual([]);
});
it('keeps environment locale available with invalid config', async () => {
  await writeFile(join(root, '.deckent', 'config.json'), '{broken');
  env['DECKENT_LANG'] = 'tr'; await help(['run', '--help'], 'tr');
});
