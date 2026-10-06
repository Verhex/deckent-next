import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyInstallation } from '../../../src/index.js';
import { fixture, unsupported } from './installation-apply-process.fixture.js';


it.skipIf(unsupported)('rejects a changed proposal or absent custom consent before publishing a target', async () => {
  const changed = await fixture();
  await expect(applyInstallation(changed.project, changed.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker',
    proposalDigest: '0'.repeat(64), acceptCustom: true })).rejects.toMatchObject({ code: 'INSTALLATION_PUBLICATION_CHANGED' });
  await expect(readFile(join(changed.project, '.deckent/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(changed.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });

  const noConsent = await fixture();
  await expect(noConsent.run(['init', 'apply', '--profile', noConsent.profilePath, '--docker-executable', '/usr/bin/docker',
    '--proposal', '0'.repeat(64), '--json'])).rejects.toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('CLI_USAGE') });
  await expect(readFile(join(noConsent.project, '.deckent/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(noConsent.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
