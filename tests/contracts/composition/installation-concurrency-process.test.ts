import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hashInstallationProfilePayload } from '#engine/index.js';
import { inspectInstallation } from '../../../src/index.js';
import { installationProfile } from '../support/installation-profile.js';

const cli = resolve('dist/composition/core/cli/internal/entry.js');
const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function rehash<T extends ReturnType<typeof installationProfile>>(profile: T): T {
  profile.profile.digest = hashInstallationProfilePayload({ ...profile, profile: { id: profile.profile.id, version: profile.profile.version } });
  return profile;
}
function diagnostic(results: readonly ApplyResult[]) {
  return JSON.stringify(results.map(result => ({ code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr })));
}
function apply(project: string, profile: string, proposal: string, env: NodeJS.ProcessEnv): Promise<ApplyResult> {
  const child = spawn(process.execPath, [cli, 'init', 'apply', '--profile', profile, '--docker-executable', '/usr/bin/docker',
    '--proposal', proposal, '--accept-custom', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveResult, reject) => {
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 40_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolveResult({ code, stdout, stderr, timedOut }); });
  });
}
interface ApplyResult { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
function parsed(result: ApplyResult): { status: 'installed' | 'replayed'; transactionId: string } | null {
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout) as { status: 'installed' | 'replayed'; transactionId: string }; }
  catch { return null; }
}
function hasCode(result: ApplyResult, expression: RegExp) { return expression.test(`${result.stdout}\n${result.stderr}`); }
async function fixture() {
  if (!imageId) throw new Error('DECKENT_TEST_DOCKER_IMAGE is required for installer concurrency proof');
  const root = await mkdtemp(join(tmpdir(), 'deckent-install-concurrency-')); roots.push(root); await chmod(root, 0o700);
  const project = join(root, 'project'), data = join(root, 'data'); await mkdir(project, { mode: 0o700 });
  const profile = installationProfile({ root: data, images: [imageId] });
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  profile.policy.grants = profile.policy.grants.map(grant => ({ ...grant, principals: [principal] }));
  profile.configuration.execution.docker.executable = '/usr/bin/docker';
  const env = { HOME: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' };
  return { root, project, data, env, profile: rehash(profile) };
}
async function writeProfile(path: string, profile: ReturnType<typeof installationProfile>) {
  await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
}
async function proposal(project: string, profile: ReturnType<typeof installationProfile>) {
  return (await inspectInstallation(project, profile, { allowShutdown: false, dockerExecutable: '/usr/bin/docker' })).proposalDigest;
}
async function assertWinner(project: string, data: string, winner: ReturnType<typeof installationProfile>) {
  const journal = JSON.parse(await readFile(join(project, '.deckent/installation/journal.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(project, '.deckent/config.json'), 'utf8'));
  const policy = JSON.parse(await readFile(join(data, 'policy.json'), 'utf8'));
  const db = new DatabaseSync(join(data, 'state/ledger.db'), { readOnly: true });
  try {
    const ownershipRecord = JSON.parse(String(db.prepare('SELECT record FROM installation_ownership WHERE singleton=1').get()?.record));
    const pool = JSON.parse(String(db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get(winner.pool.poolId)?.policy));
    expect(journal).toMatchObject({ schemaVersion: 2, phase: 'committed', blockers: [], profileDigest: winner.profile.digest,
      recovery: { material: { authoredProfile: { profile: { digest: winner.profile.digest } } } } });
    expect(ownershipRecord).toMatchObject({ schemaVersion: 1, ownership: { profileDigest: winner.profile.digest,
      planDigest: journal.planDigest, proposalDigest: journal.recovery.evidence.proposalDigest, transactionId: journal.transactionId }, pool: winner.pool });
    expect(policy).toEqual(winner.policy); expect(pool).toEqual(winner.pool);
    expect(db.prepare('SELECT count(*) AS count FROM execution_pools').get()?.count).toBe(1);
    expect(config).toMatchObject({ layout: { root: data }, admission: { poolId: winner.pool.poolId,
      executionSlots: winner.configuration.admission.executionSlots, inFlightSlots: winner.configuration.admission.inFlightSlots } });
  } finally { db.close(); }
}
async function snapshotWinner(project: string, data: string) {
  const [config, policy, journal] = await Promise.all([
    readFile(join(project, '.deckent/config.json'), 'utf8'), readFile(join(data, 'policy.json'), 'utf8'),
    readFile(join(project, '.deckent/installation/journal.json'), 'utf8'),
  ]);
  const db = new DatabaseSync(join(data, 'state/ledger.db'), { readOnly: true });
  try {
    return { config, policy, journal, ownership: String(db.prepare('SELECT record FROM installation_ownership WHERE singleton=1').get()?.record),
      pools: db.prepare('SELECT pool_id,policy FROM execution_pools ORDER BY pool_id').all() };
  } finally { db.close(); }
}

it.skipIf(process.platform !== 'linux')('turns a bounded same-plan hold into one explicit exact replay after the original processes close', async () => {
  const f = await fixture(), first = join(f.root, 'profile-a.json'), second = join(f.root, 'profile-b.json');
  await Promise.all([writeProfile(first, f.profile), writeProfile(second, structuredClone(f.profile))]);
  const digest = await proposal(f.project, f.profile);
  const results = await Promise.all([apply(f.project, first, digest, f.env), apply(f.project, second, digest, f.env)]);
  expect(results.some(result => result.timedOut), diagnostic(results)).toBe(false);
  const values = results.map(parsed), installed = values.map((value, index) => ({ value, index })).filter(item => item.value?.status === 'installed');
  const replayed = values.map((value, index) => ({ value, index })).filter(item => item.value?.status === 'replayed');
  const held = results.map((result, index) => ({ result, index })).filter(item => hasCode(item.result, /INSTALLATION_JOURNAL_BUSY/));
  expect(installed.length, diagnostic(results)).toBe(1);
  expect(replayed.length + held.length, diagnostic(results)).toBe(1);
  expect(replayed.length === 1 || held.length === 1, diagnostic(results)).toBe(true);
  const retry = held.length ? await apply(f.project, held[0]!.index === 0 ? first : second, digest, f.env) : null;
  if (retry) expect(retry.timedOut, diagnostic([...results, retry])).toBe(false);
  const finalReplay = replayed[0]?.value ?? (retry ? parsed(retry) : null);
  expect(finalReplay, diagnostic(retry ? [...results, retry] : results)).toMatchObject({ status: 'replayed', transactionId: installed[0]!.value!.transactionId });
  await assertWinner(f.project, f.data, f.profile);
}, 60_000);

it.skipIf(process.platform !== 'linux')('turns a bounded conflicting-plan hold into one explicit guarded rejection without mixed resources', async () => {
  const f = await fixture(), left = f.profile, right = structuredClone(f.profile);
  right.policy.revision = 'policy-plan-b'; right.pool.capacity.executionSlots = 2; right.pool.capacity.inFlightSlots = 2;
  right.configuration.admission.executionSlots = 2; right.configuration.admission.inFlightSlots = 2; rehash(right);
  const leftPath = join(f.root, 'profile-a.json'), rightPath = join(f.root, 'profile-b.json');
  await Promise.all([writeProfile(leftPath, left), writeProfile(rightPath, right)]);
  const [leftProposal, rightProposal] = await Promise.all([proposal(f.project, left), proposal(f.project, right)]);
  const results = await Promise.all([apply(f.project, leftPath, leftProposal, f.env), apply(f.project, rightPath, rightProposal, f.env)]);
  expect(results.some(result => result.timedOut), diagnostic(results)).toBe(false);
  const successes = results.map((result, index) => ({ result, index, value: parsed(result) })).filter(item => item.value !== null);
  expect(successes.length, diagnostic(results)).toBe(1);
  expect(successes[0]!.value!.status, diagnostic(results)).toBe('installed');
  const failure = results.find(result => result.code !== 0)!;
  const held = hasCode(failure, /INSTALLATION_JOURNAL_BUSY/);
  const beforeRetry = held ? await snapshotWinner(f.project, f.data) : null;
  const retry = held ? await apply(f.project, successes[0]!.index === 0 ? rightPath : leftPath,
    successes[0]!.index === 0 ? rightProposal : leftProposal, f.env) : null;
  if (retry) expect(retry.timedOut, diagnostic([...results, retry])).toBe(false);
  const rejection = retry ?? failure;
  // The retained winner configuration checks pool compatibility before recovery material can bind a conflicting profile.
  expect(`${rejection.stdout}\n${rejection.stderr}`, diagnostic(retry ? [...results, retry] : results))
    .toMatch(/INSTALLATION_(PROFILE_POOL|RECOVERY_(CHANGED|CONSENT))/);
  if (beforeRetry) expect(await snapshotWinner(f.project, f.data)).toEqual(beforeRetry);
  await assertWinner(f.project, f.data, successes[0]!.index === 0 ? left : right);
}, 60_000);
