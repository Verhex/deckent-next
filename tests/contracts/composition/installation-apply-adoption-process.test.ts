import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { immutableJsonObjectSchema } from '#domain/index.js';
import { validateConfig, versionedConfig } from '#platform/index.js';
import { applyInstallation, inspectInstallation } from '../../../src/index.js';
import { fixture, unsupported } from './installation-apply-process.fixture.js';


it.skipIf(unsupported)('adopts exact approved config and policy bytes without replacing their files', async () => {
  const f = await fixture(), control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const evidence = await inspectInstallation(f.project, f.profile, control);
  const content = (value: unknown) => `${JSON.stringify(immutableJsonObjectSchema.parse(value))}\n`;
  const selected = ([
    { resource: 'config' as const, path: evidence.preview.paths.config,
      content: content(validateConfig(versionedConfig(f.profile.configuration)).config) },
    { resource: 'policy' as const, path: evidence.preview.paths.policy, content: content(f.profile.policy) },
  ]).map(target => ({ ...target, digest: createHash('sha256').update(target.content, 'utf8').digest('hex') }));
  for (const target of selected) {
    await mkdir(resolve(target.path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(target.path, target.content, { mode: 0o600 });
  }
  const before = new Map(await Promise.all(selected.map(async target => [target.resource,
    { bytes: await readFile(target.path), stat: await lstat(target.path) }] as const)));

  const installed = await applyInstallation(f.project, f.profile, { ...control, proposalDigest: evidence.proposalDigest, acceptCustom: true });
  expect(installed.status).toBe('installed');
  const journal = JSON.parse(await readFile(join(f.project, '.deckent/installation/journal.json'), 'utf8'));
  for (const target of selected) {
    const prior = before.get(target.resource)!; const after = await lstat(target.path);
    expect(await readFile(target.path)).toEqual(prior.bytes);
    expect([after.dev, after.ino]).toEqual([prior.stat.dev, prior.stat.ino]);
    expect(journal.resources).toContainEqual(expect.objectContaining({ resource: target.resource,
      preimageDigest: target.digest, targetDigest: target.digest, state: 'published' }));
  }
});
