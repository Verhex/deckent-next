import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { patchDigest, patchExclusions, type DeliverySummaryRequest } from '#engine/index.js';
import { describeConfiguredDeliverySummaries } from '#composition/core/workspace-patch/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, prepareProductDirectory, resolveGlobalConfigPaths } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import { homeEnv } from '../support/host-platform.js';

/**
 * REVISE 2734 R3 + R4 through the REAL human-card composition (`describeConfiguredDeliverySummaries`, the CLI/terminal `describeDeliverySummaries`):
 * a config-known secret that matches no credential pattern is masked in the title, the worker outcome and the paths, also where it crosses the
 * bound; a boundary Unicode card projects; one bad card in a host batch degrades alone instead of blanking every card.
 */
const canary = 'registered-delivery-fixture-canary', roots: string[] = [], emoji = '\u{1F600}';
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-summary-composition-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') } }));
  const options = { env: homeEnv(join(root, 'home')), secretResolver: async () => canary };
  // SEC-3: only the installation layer may name a $DECK secret; it makes the literal a config-known secret of every load.
  const installation = resolveGlobalConfigPaths(options.env).platformPath; await mkdir(dirname(installation), { recursive: true });
  await writeFile(installation, JSON.stringify({ service: { identity: { scopeId: 's', serviceId: '$DECK:DELIVERY_FIXTURE' } } }));
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const graph = { schemaVersion: 3 as const, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  const execution = structuredClone(fixtureExecution(graph));
  execution.criteria[0]!.evaluator.implementation = { id: 'process-exit', version: 1 };
  const codingGraph = { ...graph, tasks: graph.tasks.map(task => ({ ...task, workInput: { schemaVersion: 1, task: 'Rotate the key', title: `Rotate ${canary} now`,
    scope: { paths: ['src/**'] }, acceptance: 'Key rotated', model: { channelId: 'test-channel', modelId: 'test-model', auxiliaryModelIds: [] } } })) };
  // Trusted ledger fixture (as coding-change): the summary read is under test, admission compilation has its own tests.
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const actor = { id: 'fixture', issuer: 'test', subject: 'fixture' };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor, identity: { runId: 'r', scopeId: 's', layoutRevision: identity.layoutRevision }, graph: codingGraph, execution, now: 0,
    policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
  const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['test'] } };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
  // The known literal crosses the 240-code-point outcome bound: redaction before bounding must leave no prefix of it.
  const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1, summary: `${'y'.repeat(225)}${canary} tail`,
    changedFiles: [`src/${canary}.txt`], checks: [], openIssues: [] } };
  await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: JSON.stringify(report), stderr: '' }))));
  await store.finishDispatch(claim, { handle: 'h', exitCode: 0, interrupted: false });
  await store.retainDispatchPatch(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'workspace-patch', identity,
    source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'c'.repeat(64) }, baseCommit: 'a'.repeat(40), snapshotDigest: 'b'.repeat(64), exclusions: patchExclusions,
    changes: [{ path: `src/${canary}.txt`, before: null, after: { mode: '100644', text: 'rotated\n', digest: patchDigest('rotated\n') } }] }))));
  store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(root, 'data/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'summary', restrictions: [], grants: [
    { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'output', effect: 'allow', actions: ['read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } },
  ] }), { mode: 0o600 });
  const request: DeliverySummaryRequest = { schemaVersion: 1, identity, operation: 'deliver', target: { id: 'refs/heads/feature', protected: false }, verificationRunId: null };
  return { project, options, request };
}

describe.skipIf(process.platform === 'win32')('human delivery-card summaries through the real composition', () => {
  it('R3: masks a config-known secret that matches no credential pattern in the title, the worker outcome and the paths', async () => {
    const f = await fixture(), [summary] = await describeConfiguredDeliverySummaries(f.project, [f.request], f.options);
    expect(summary).toMatchObject({ title: { source: 'work-input' }, outcome: { state: 'available', truncated: true }, change: { state: 'available', files: 1 } });
    const text = JSON.stringify(summary);
    expect(text).not.toContain(canary.slice(0, 12));
    expect(text).toContain('‹secret:DELIVERY_FIXTURE›');
    if (summary?.title.source !== 'work-input' || summary.change.state !== 'available') throw new Error('expected title and change');
    expect(summary.title.text).toBe('Rotate ‹secret:DELIVERY_FIXTURE› now');
    expect(summary.change.topPaths).toEqual(['src/‹secret:DELIVERY_FIXTURE›.txt']);
  });
  it('R4: a boundary Unicode target projects, and one bad card in the batch degrades alone', async () => {
    const f = await fixture(), boundary = { ...f.request, target: { id: `${'r'.repeat(255)}${emoji}`, protected: false } };
    const [wide, plain] = await describeConfiguredDeliverySummaries(f.project, [boundary, f.request], f.options);
    expect(wide?.target).toEqual({ state: 'available', id: `${'r'.repeat(255)}${emoji}`, protected: false });
    expect(plain?.target).toEqual({ state: 'available', id: 'refs/heads/feature', protected: false });
    const invalid = { ...f.request, target: { id: 'x'.repeat(4097), protected: false } };
    const [bad, good] = await describeConfiguredDeliverySummaries(f.project, [invalid, f.request], f.options);
    expect(bad).toBeNull();
    expect(good).toMatchObject({ operation: 'deliver', subject: f.request.identity, target: { state: 'available', id: 'refs/heads/feature' } });
    // Characterization of the per-card read path: a card whose Run may not be inspected (POLICY_DENIED inside describe) is null beside a good card.
    const refused = { ...f.request, identity: { ...f.request.identity, runId: 'not-granted' } };
    const [denied, kept] = await describeConfiguredDeliverySummaries(f.project, [refused, f.request], f.options);
    expect(denied).toBeNull();
    expect(kept).toMatchObject({ subject: f.request.identity });
  });
});
