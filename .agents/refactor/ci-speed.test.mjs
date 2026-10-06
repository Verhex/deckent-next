import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { partitionTests, inventoryDigest, validateShards, SHARDS } from '../../scripts/ci-test-plan.mjs';
import { validateHostedChecks, REQUIRED_CHECKS } from '../../scripts/land-hosted-check.mjs';
import { sealBuild, validateBuild } from '../../scripts/ci-build-artifact.mjs';
import { writeBuildIdentity } from '../../scripts/build-identity.mjs';
import VerificationReporter from '../../scripts/verification-reporter.mjs';

const inventory = Array.from({ length: SHARDS }, (_, i) => `tests/example-${i}.test.ts`);
const identity = { sha: 'a'.repeat(40), node: '24', runId: '123', attempt: '2' };
const receipts = () => inventory.map((file, i) => ({ schemaVersion: 1, ...identity, index: i + 1, count: SHARDS,
  inventoryDigest: inventoryDigest(inventory), exitCode: 0, runReason: 'passed', collectionErrors: 0, unhandledErrors: 0,
  nativeExit: 0, hostExit: 0, smokeExit: 0, files: [{ file, state: 'passed', collectionErrors: 0,
    counts: { passed: 2, failed: 0, skipped: 0, pending: 0 } }] }));
test('duration allocation keeps known and new files exactly once and starts with the longest', () => {
  const files = [...inventory, 'tests/new.test.ts'];
  const plan = partitionTests(files, { [inventory[0]]: 10000, [inventory[1]]: 2000 }, 3);
  assert.deepEqual(plan.flatMap(bin => bin.files).sort(), files.sort());
  assert.equal(new Set(plan.flatMap(bin => bin.files)).size, files.length);
  assert.ok(plan[0].files.includes(inventory[0]));
  assert.deepEqual(partitionTests([...files].reverse(), { [inventory[0]]: 10000, [inventory[1]]: 2000 }, 3), plan);
  assert.throws(() => partitionTests([inventory[0], inventory[0]], {}, 3), /duplicate/);
});
test('aggregate accepts exact coverage and preserves actual skip counts', () => {
  const r = receipts(); r[0].files[0].counts.skipped = 1;
  assert.deepEqual(validateShards(inventory, r, identity).counts, { passed: 16, failed: 0, skipped: 1, pending: 0 });
});
for (const [name, damage] of [
  ['missing shard', r => r.pop()], ['duplicate shard', r => { r[1].index = 1; }],
  ['wrong source', r => { r[0].sha = 'b'.repeat(40); }], ['wrong Node', r => { r[0].node = '26'; }],
  ['old attempt', r => { r[0].attempt = '1'; }], ['old run', r => { r[0].runId = '122'; }],
  ['missing file', r => { r[0].files = []; }], ['duplicate file', r => { r[1].files[0].file = inventory[0]; }],
  ['unexpected file', r => { r[0].files[0].file = 'tests/unexpected.test.ts'; }],
  ['collection error', r => { r[0].collectionErrors = 1; }], ['unhandled error', r => { r[0].unhandledErrors = 1; }],
  ['cancelled', r => { r[0].runReason = 'interrupted'; }], ['nonzero exit', r => { r[0].exitCode = 1; }],
  ['failed test', r => { r[0].files[0].counts.failed = 1; }], ['pending test', r => { r[0].files[0].counts.pending = 1; }],
  ['file collection error', r => { r[0].files[0].collectionErrors = 1; }], ['unfinished file', r => { r[0].files[0].state = 'queued'; }],
  ['native failed', r => { r[0].nativeExit = 1; }], ['host absent', r => { r[0].hostExit = null; }],
  ['smoke failed', r => { r[0].smokeExit = 1; }], ['different inventory', r => { r[0].inventoryDigest = 'unknown'; }],
]) test(`aggregate refuses ${name}`, () => { const r = receipts(); damage(r); assert.throws(() => validateShards(inventory, r, identity)); });

test('hosted landing requires latest exact-SHA GitHub Actions success on both Node versions', () => {
  const checks = REQUIRED_CHECKS.map((name, i) => ({ name, id: i + 1, head_sha: identity.sha, check_suite: { id: 9 },
    app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }));
  const runs = [{ id: 7, check_suite_id: 9, head_sha: identity.sha, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }];
  assert.equal(validateHostedChecks(checks, identity.sha, runs), true);
  assert.throws(() => validateHostedChecks(checks.slice(1), identity.sha, runs));
  assert.throws(() => validateHostedChecks(checks, 'b'.repeat(40), runs));
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', null]) {
    assert.throws(() => validateHostedChecks([...checks, { ...checks[0], id: 20, conclusion }], identity.sha, runs));
  }
  assert.throws(() => validateHostedChecks(checks.map(c => ({ ...c, status: 'in_progress' })), identity.sha, runs));
  assert.throws(() => validateHostedChecks(checks.map(c => ({ ...c, app: { slug: 'other' } })), identity.sha, runs));
  assert.throws(() => validateHostedChecks(checks, identity.sha, [{ ...runs[0], event: 'pull_request' }]), /HOSTED_SOURCE_NOT_EXACT/);
  assert.throws(() => validateHostedChecks([checks[0], { ...checks[1], check_suite: { id: 10 } }], identity.sha, runs), /HOSTED_RUN_SPLIT/);
  assert.throws(() => validateHostedChecks(checks, identity.sha, [{ ...runs[0], conclusion: 'failure' }]), /HOSTED_RUN_NOT_GREEN/);
});
test('built reuse binds Node, source content, native/product bytes and build inputs', t => {
  const root = mkdtempSync(join(tmpdir(), 'ci-build-proof-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  put('src/adapters/core/example/native/package.json', JSON.stringify({ deckentNative: { platforms: [process.platform], artifacts: ['build/example.node'] } }));
  put('src/adapters/core/example/native/build/example.node', 'native');
  put('src/example.ts', 'export {};'); put('dist/example.js', 'export {};');
  for (const path of ['package-lock.json', 'tsconfig.json', 'arch.json', 'packaging/bwrap/bwrap.lock.json']) put(path, '{}');
  put('package.json', '{"name":"fixture","version":"1"}');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c','user.name=fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-qm','fixture'], { cwd: root });
  writeBuildIdentity(root, [join(root, 'src/example.ts'), join(root, 'src/adapters/core/example/native/package.json')], join(root, 'dist'));
  sealBuild(root); assert.doesNotThrow(() => validateBuild(root));
  const stamp = readFileSync(join(root, '.pack/ci-build.json'), 'utf8');
  put('.pack/ci-build.json', JSON.stringify({ ...JSON.parse(stamp), node: '999' })); assert.throws(() => validateBuild(root), /identity/);
  put('.pack/ci-build.json', stamp);
  for (const [path, original] of [['dist/example.js', 'export {};'], ['src/adapters/core/example/native/build/example.node', 'native'], ['package-lock.json', '{}'], ['src/example.ts', 'export {};']]) {
    put(path, 'changed'); assert.throws(() => validateBuild(root)); put(path, original);
  }
  put('src/new.ts', 'export {};'); assert.throws(() => validateBuild(root), /Stale build source/);
});
test('reporter records actual file identities, counts, state and errors', t => {
  const root = mkdtempSync(join(tmpdir(), 'ci-reporter-proof-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.DECKENT_CI_EVIDENCE_DIR; process.env.DECKENT_CI_EVIDENCE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.DECKENT_CI_EVIDENCE_DIR; else process.env.DECKENT_CI_EVIDENCE_DIR = previous; });
  new VerificationReporter().onTestRunEnd([{ relativeModuleId: inventory[0], state: () => 'passed', errors: () => [],
    diagnostic: () => ({ duration: 10 }), children: { allTests: () => [{ result: () => ({ state: 'passed' }) }] } }], [], 'passed');
  const result = JSON.parse(readFileSync(join(root, 'files.json'), 'utf8'));
  assert.deepEqual(result.files[0].counts, { passed: 1, failed: 0, skipped: 0, pending: 0 });
  assert.equal(result.files[0].file, inventory[0]); assert.equal(result.runReason, 'passed');
});
