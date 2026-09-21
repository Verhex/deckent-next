import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig, clearConfigCache, resolveGlobalScopePaths, resolveGlobalConfigPaths } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('isolates global config without merging legacy fields or redirecting project data, including cache hits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-global-isolation-')); roots.push(root);
  const home = join(root, 'home'), global = join(root, 'next-global'), project = join(root, 'project');
  for (const path of [join(home, '.deckent'), global, join(project, '.deckent')]) await mkdir(path, { recursive: true });
  const legacy = '{"provider_limits":{"unknown":1},"approval":{"legacy":true}}\n';
  await writeFile(join(home, '.deckent/config.json'), legacy);
  await writeFile(join(global, 'config.json'), JSON.stringify({ language: 'tr' }));
  const data = join(root, 'project-data');
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
  const env = { HOME: home, DECKENT_GLOBAL_HOME: global };
  for (let i = 0; i < 2; i++) expect(await loadConfig(project, { env })).toMatchObject({ language: 'tr', productLayout: { root: data } });
  await expect(loadConfig(project, { env: { HOME: home } })).rejects.toMatchObject({ code: 'CONFIG_VALIDATION' });
  expect((await loadConfig(project, { env, globalOnly: true })).productLayout.root).toBe(global);
  expect((await loadConfig(project, { env: { ...env, DECKENT_HOME: join(root, 'explicit-data') } })).productLayout.root).toBe(join(root, 'explicit-data'));
  expect(await readFile(join(home, '.deckent/config.json'), 'utf8')).toBe(legacy);
});
it('resolves an explicit global root across platforms without HOME, while rejecting relative roots', () => {
  expect(resolveGlobalScopePaths('linux', { DECKENT_GLOBAL_HOME: '/next/global' })).toMatchObject({ configDir: '/next/global', home: null, source: 'env-override' });
  expect(resolveGlobalScopePaths('darwin', { HOME: '/Users/u', DECKENT_GLOBAL_HOME: '/next/global', DECKENT_HOME: '/project/data' }).stateDir).toBe('/next/global');
  expect(resolveGlobalConfigPaths({ DECKENT_GLOBAL_HOME: 'D:\\Next\\global' }, 'win32').platformPath).toBe('D:\\Next\\global\\config.json');
  expect(() => resolveGlobalScopePaths('linux', { HOME: '/h', DECKENT_GLOBAL_HOME: 'relative' })).toThrow('LAYOUT_ROOT_INVALID');
});
