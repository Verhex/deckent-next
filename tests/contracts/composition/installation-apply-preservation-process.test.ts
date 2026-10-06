import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { applyInstallation, inspectInstallation } from '../../../src/index.js';
import { fixture, unsupported } from './installation-apply-process.fixture.js';


it.skipIf(unsupported)('never overwrites pre-existing config or policy bytes', async () => {
  const f = await fixture(), config = join(f.project, '.deckent/config.json'), policy = join(f.data, 'policy.json');
  await mkdir(resolve(config, '..'), { recursive: true, mode: 0o700 });
  await mkdir(resolve(policy, '..'), { recursive: true, mode: 0o700 });
  await writeFile(config, '{"foreign":"config"}\n', { mode: 0o600 });
  await writeFile(policy, '{"foreign":"policy"}\n', { mode: 0o600 });
  const beforeConfig = await readFile(config), beforePolicy = await readFile(policy);
  const evidence = await inspectInstallation(f.project, f.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker' });
  await expect(applyInstallation(f.project, f.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker',
    proposalDigest: evidence.proposalDigest, acceptCustom: true })).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CONFLICT' });
  expect(await readFile(config)).toEqual(beforeConfig);
  expect(await readFile(policy)).toEqual(beforePolicy);
});
