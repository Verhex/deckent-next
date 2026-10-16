import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { createConfigFileDocuments } from '#adapters/index.js';
import { clearConfigCache, resolveGlobalConfigPaths, withConfigLayersLocked } from '#platform/index.js';

// POLICY-V12 (Astra 2598): the installer's consistency boundary is the configuration writer's own lock. While `withConfigLayersLocked` holds it,
// a configuration write on either layer through the real file writer (the one ConfigApplication uses) waits; it lands only after the locked work.
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.skipIf(process.platform === 'win32').each(['project', 'global'] as const)('a %s configuration write waits for the locked work and lands after it', async layer => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-layers-lock-')); roots.push(root);
  const project = join(root, 'project'), env = { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') };
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ schema_version: 4 }), { mode: 0o600 });
  const documents = createConfigFileDocuments(project, { env }), order: string[] = [];
  let write: Promise<unknown> | undefined;
  await withConfigLayersLocked(project, { env }, async () => {
    write = documents.publish({ keyPath: 'language', layer, principal: { id: 'p', issuer: 'host', subject: 'owner', assurance: 'os-user', scopeIds: ['s'] }, scopeId: 's', commandId: 'c' },
      async snapshot => { order.push('config-write'); return { document: { ...snapshot.document, language: 'tr' }, event: {} as never }; });
    await sleep(300);
    order.push('locked-work-done');
  });
  await write;
  expect(order).toEqual(['locked-work-done', 'config-write']);
  const path = layer === 'project' ? join(project, '.deckent', 'config.json') : resolveGlobalConfigPaths(env).platformPath;
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ language: 'tr' });
});
