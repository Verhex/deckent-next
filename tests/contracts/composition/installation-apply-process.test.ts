import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { applyInstallation, inspectInstallation } from '../../../src/index.js';
import { fixture, rehash, unsupported } from './installation-apply-process.fixture.js';
import { writeFile } from 'node:fs/promises';


it.skipIf(unsupported).each([0o700])('publishes a relocated installation in project mode %s through SDK and replays through compiled CLI', async mode => {
  const f = await fixture(); await chmod(f.project, mode);
  const control = { allowShutdown: false, dockerExecutable: '/usr/bin/docker' };
  const evidence = await inspectInstallation(f.project, f.profile, control);
  const installed = await applyInstallation(f.project, f.profile, { ...control, proposalDigest: evidence.proposalDigest, acceptCustom: true });
  expect(installed).toMatchObject({ schemaVersion: 1, status: 'installed', proposalDigest: evidence.proposalDigest,
    trust: { mode: 'operator-custom', publisherVerification: 'unverified' }, paths: {
      config: join(f.project, '.deckent/config.json'), installationJournal: join(f.project, '.deckent/installation/journal.json'),
      policy: join(f.data, 'policy.json'), ledger: join(f.data, 'state/ledger.db') } });

  expect((await lstat(f.project)).mode & 0o777).toBe(mode);
  expect((await lstat(join(f.project, '.deckent/installation/journal.json'))).mode & 0o777).toBe(0o600);
  // VLLM-CACHE-SALT: init creates the installation's own 256-bit prefix-cache salt secret (0600), never in config.
  const saltSecret = await lstat(join(f.data, 'approvals', 'prefix-cache-salt.key'));
  expect(saltSecret.mode & 0o777).toBe(0o600); expect(saltSecret.size).toBe(32);
  const config = JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8'));
  const journal = JSON.parse(await readFile(join(f.project, '.deckent/installation/journal.json'), 'utf8'));
  expect(config.layout.root).toBe(f.data);
  expect(JSON.stringify(config)).not.toContain('prefix-cache-salt');
  expect(JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8'))).toEqual(f.profile.policy);
  expect(journal).toMatchObject({ schemaVersion: 2, transactionId: installed.transactionId, phase: 'committed', blockers: [],
    resources: expect.arrayContaining(['config', 'policy', 'ledger'].map(resource => expect.objectContaining({ resource, state: 'published' }))) });
  const db = new DatabaseSync(join(f.data, 'state/ledger.db'), { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare('SELECT count(*) AS count FROM installation_ownership').get()?.count).toBe(1);
    expect(JSON.parse(String(db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get('pool-1')?.policy))).toEqual(f.profile.pool);
  } finally { db.close(); }

  await rm(f.profilePath);
  const replayed = JSON.parse((await f.run(['init', 'resume', '--docker-executable', '/usr/bin/docker', '--proposal', evidence.proposalDigest,
    '--accept-custom', '--json'])).stdout);
  expect(replayed).toMatchObject({ status: 'replayed', transactionId: installed.transactionId, proposalDigest: evidence.proposalDigest,
    trust: { mode: 'operator-custom', publisherVerification: 'unverified' } });
// Inspect + apply + a compiled-CLI replay measured 27.5-28.1 s on this host and 30.4 s under a running local model server.
}, 90_000);

it.skipIf(unsupported)('fresh Docker init apply selects the encrypted default through secret/switch policy; replay preserves it', async () => {
  const f = await fixture();
  const principal = f.profile.policy.grants[0]!.principals;
  f.profile.policy.grants.push({ id: 'installer-secret-switch', effect: 'allow', actions: ['switch'], scopes: ['scope-1'], principals: principal,
    resource: { kind: 'secret', ids: 'all' } });
  await writeFile(f.profilePath, JSON.stringify(rehash(f.profile)), { mode: 0o600 });
  const evidence = await inspectInstallation(f.project, f.profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker' });
  const args = ['init', 'apply', '--profile', f.profilePath, '--docker-executable', '/usr/bin/docker', '--proposal', evidence.proposalDigest, '--accept-custom', '--json'];
  const applied = JSON.parse((await f.run(args)).stdout);
  expect(applied).toMatchObject({ status: 'installed', secretStore: { status: 'set', backend: 'core.secret-store.encrypted-file@1', record: {
    subject: { kind: 'secret-store-switch', from: 'core.secret-store.env@1', entries: 0, decision: { effect: 'allow', ruleId: 'installer-secret-switch' } } } } });
  const selected = JSON.parse(await readFile(join(f.root, 'home', '.deckent', 'config.json'), 'utf8'));
  expect(selected.secrets.store).toBe('core.secret-store.encrypted-file@1');
  const replay = JSON.parse((await f.run(args)).stdout);
  expect(replay.status).toBe('replayed'); expect(replay).not.toHaveProperty('secretStore');
  expect(JSON.parse(await readFile(join(f.root, 'home', '.deckent', 'config.json'), 'utf8'))).toEqual(selected);
}, 90_000);
