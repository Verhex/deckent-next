import { mkdir, mkdtemp, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readInstallationProfileFile } from '#adapters/core/installation-profile-file/index.js';

const roots: string[] = [];
async function fixture(bytes: string | Buffer) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-installation-input-')); roots.push(root);
  const path = join(root, 'profile.json'); await writeFile(path, bytes); return { root, path };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('reads bounded caller-selected JSON as untrusted data without altering it', async () => {
  const { path } = await fixture('{"schemaVersion":1,"text":"şema"}');
  expect(await readInstallationProfileFile(path, 100)).toEqual({ schemaVersion: 1, text: 'şema' });
});
it('refuses oversized, malformed and non-UTF8 content without exposing its bytes', async () => {
  const { path } = await fixture('{"secret":"value"}');
  await expect(readInstallationProfileFile(path, 2)).rejects.toMatchObject({ code: 'INSTALL_PROFILE_SOURCE_TOO_LARGE' });
  await writeFile(path, '{"private"');
  await expect(readInstallationProfileFile(path, 100)).rejects.toMatchObject({ code: 'INSTALL_PROFILE_INVALID' });
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await expect(readInstallationProfileFile(path, 100)).rejects.toMatchObject({ code: 'INSTALL_PROFILE_INVALID' });
});
it('rejects directories, linked files and missing sources', async () => {
  const { root, path } = await fixture('{}'); const alias = join(root, 'alias');
  await symlink(path, alias);
  await expect(readInstallationProfileFile(alias, 100)).rejects.toMatchObject({ code: 'INSTALL_PROFILE_SOURCE_UNSAFE' });
  await link(path, join(root, 'hardlink'));
  await expect(readInstallationProfileFile(path, 100)).rejects.toMatchObject({ code: 'INSTALL_PROFILE_SOURCE_UNSAFE' });
  const directory = join(root, 'directory'); await mkdir(directory);
  await expect(readInstallationProfileFile(directory, 100)).rejects.toMatchObject({ code: 'INSTALL_PROFILE_SOURCE_UNSAFE' });
  await expect(readInstallationProfileFile(join(root, 'missing'), 100)).rejects.toMatchObject({ code: 'INSTALL_PROFILE_SOURCE_UNAVAILABLE' });
});
