// s3c (owner 2026-10-24): the subscription Brain's own login dir (layout `headlessLogins`) is never in any backup set: the archive lists logical
// resources only, none of which is, contains or lies inside the login dir; a planted credential canary never reaches an archive.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { productResourcePath, resolveProductLayout, type ProductResource } from '#platform/index.js';
// eslint-disable-next-line no-restricted-imports
import { BACKUP_RESOURCES, archiveState } from '#adapters/core/backup-store/internal/archive.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const CANARY = 'CREDENTIAL-CANARY-b7e0';
const within = (outer: string, inner: string) => { const path = relative(outer, inner); return path === '' || (!path.startsWith('..') && !path.startsWith(sep)); };

it('no backup resource is, contains or lies inside the Brain\'s login dir', () => {
  const layout = resolveProductLayout({ projectRoot: '/home/p' }), login = productResourcePath(layout, 'headlessLogins');
  expect(BACKUP_RESOURCES as readonly string[]).not.toContain('headlessLogins');
  for (const resource of BACKUP_RESOURCES) {
    const path = productResourcePath(layout, resource as ProductResource);
    expect([resource, within(path, login) || within(login, path)]).toEqual([resource, false]);
  }
});
it.skipIf(process.platform === 'win32')('an archive of a state root with a signed-in Brain login holds no entry of it and never its credential bytes', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'deckent-backup-login-'))); roots.push(base);
  const layout = resolveProductLayout({ projectRoot: base });
  await mkdir(layout.root, { mode: 0o700 });
  for (const resource of ['config', 'installationIdentity', 'policy', 'bindings'] as const) await writeFile(productResourcePath(layout, resource), '{}', { mode: 0o600 });
  const login = join(productResourcePath(layout, 'headlessLogins'), 'claude');
  await mkdir(login, { recursive: true, mode: 0o700 });
  await writeFile(join(login, '.credentials.json'), CANARY, { mode: 0o600 }); await writeFile(join(login, '.claude.json'), CANARY, { mode: 0o600 });
  const archive = await archiveState(layout, base, 'installation', 'key', { maxFiles: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 24, maxDepth: 16 }, new Date(0).toISOString());
  const text = gunzipSync(archive).toString('utf8'), state = JSON.parse(text) as { entries: { resource: string; path: string; content: string }[] };
  expect(state.entries.map(entry => entry.resource).sort()).toEqual(['bindings', 'config', 'installationIdentity', 'policy']);
  for (const entry of state.entries) expect(Buffer.from(entry.content, 'base64').toString('utf8')).not.toContain(CANARY);
  expect(text).not.toContain(Buffer.from(CANARY).toString('base64'));
  expect(text).not.toContain('.credentials.json');
});
