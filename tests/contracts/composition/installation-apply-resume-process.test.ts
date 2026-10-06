import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyInstallation, inspectInstallation } from '../../../src/index.js';
import { fixture, unsupported } from './installation-apply-process.fixture.js';


it.skipIf(unsupported || userInfo().uid === 0)('resumes a real pending publication without the external profile after fixing owned directory permissions', async () => {
  const f = await fixture(), control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const evidence = await inspectInstallation(f.project, f.profile, control);
  await mkdir(f.data, { mode: 0o700 }); await chmod(f.data, 0o555);
  await expect(applyInstallation(f.project, f.profile, { ...control, proposalDigest: evidence.proposalDigest, acceptCustom: true })).rejects.toBeDefined();

  const journalPath = join(f.project, '.deckent/installation/journal.json');
  const pending = JSON.parse(await readFile(journalPath, 'utf8'));
  expect(pending).toMatchObject({ schemaVersion: 2, phase: 'pending', planDigest: evidence.preview.planDigest,
    profileDigest: f.profile.profile.digest, blockers: ['INSTALLATION_NOT_APPLIED'],
    resources: expect.arrayContaining(['config', 'policy', 'ledger'].map(resource => expect.objectContaining({ resource, state: 'pending' }))),
    recovery: { schemaVersion: 1, material: { authoredProfile: f.profile, allowShutdown: false },
      consent: { mode: 'operator-custom', proposalDigest: evidence.proposalDigest } } });
  expect(pending.transactionId).toBe(pending.recovery.consent.id);
  await expect(readFile(join(f.data, 'policy.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(f.data, 'state/ledger.db'))).rejects.toMatchObject({ code: 'ENOENT' });

  await rm(f.profilePath); await chmod(f.data, 0o700);
  const installed = JSON.parse((await f.run(['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', evidence.proposalDigest,
    '--accept-custom', '--json'])).stdout);
  expect(installed).toMatchObject({ status: 'installed', transactionId: pending.transactionId, proposalDigest: evidence.proposalDigest,
    trust: { mode: 'operator-custom', publisherVerification: 'unverified' } });
  expect(JSON.parse(await readFile(journalPath, 'utf8'))).toMatchObject({ transactionId: pending.transactionId, phase: 'committed', blockers: [] });
// Two real installation passes plus a compiled CLI resume: measured 27-31 s on the WSL host (2026-09-25/26), at the 30 s default.
}, 90_000);
