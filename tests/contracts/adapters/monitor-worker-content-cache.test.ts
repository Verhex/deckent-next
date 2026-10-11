import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import { prepareMonitorInstall, readMonitorWorkerContent } from '#adapters/core/monitor-ledger/index.js';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/core/attempt-store/index.js';
import { loadConfig, clearConfigCache } from '#platform/core/config/index.js';
import { prepareProductDirectory, prepareProductFile } from '#platform/core/managed-files/index.js';
import { WORKER_EVENT_SCHEMA_VERSION } from '#domain/index.js';
import { patchExclusions, patchFile } from '#engine/core/workspace-patch/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); clearConfigCache(); stores.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
type Files = Parameters<typeof readMonitorWorkerContent>[1];
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const receipt = (value: Uint8Array) => ({ schemaVersion: 1 as const, scopeId: 's', digest: createHash('sha256').update(value).digest('hex'), byteLength: value.byteLength });
function fixture() {
  const identity = { scopeId: 's', runId: randomUUID(), taskId: 'task', attemptId: randomUUID(), layoutRevision: 'layout', generation: 1 };
  const output = (summary = 'Done') => bytes({ schemaVersion: 1, identity, completeness: 'complete', stderr: '',
    stdout: JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported',
      report: { schemaVersion: 1, summary, changedFiles: ['file.ts'], checks: [{ command: 'test', outcome: 'passed' }], openIssues: [] } }) });
  const initial = output();
  const files: Files = { identity, output: receipt(initial), events: null, patch: null, workspace: null, failed: false, open: false, finished: true, sealed: true };
  const read = vi.fn(async () => initial);
  return { files, output, read, artifacts: { read } };
}

describe('monitor worker artifact cache', () => {
  it('reads and parses a finished sealed final report once and keeps returned results independent', async () => {
    const f = fixture(), first = await readMonitorWorkerContent(f.artifacts, f.files);
    expect(first.finalReport).toMatchObject({ status: 'reported', report: { summary: 'Done' } });
    const second = await readMonitorWorkerContent(f.artifacts, { ...f.files, identity: { ...f.files.identity }, output: { ...f.files.output! } });
    expect(second).toEqual(first); expect(f.read).toHaveBeenCalledTimes(1);
    if (second.finalReport?.status === 'reported') second.finalReport.report.summary = 'caller mutation';
    expect((await readMonitorWorkerContent(f.artifacts, f.files)).finalReport).toEqual(first.finalReport);
  });
  it('re-reads a changed digest or byte length without invalidating unchanged artifacts', async () => {
    const f = fixture(); await readMonitorWorkerContent(f.artifacts, f.files);
    const changed = f.output('New report'); f.read.mockResolvedValue(changed);
    const revised = { ...f.files, output: receipt(changed) };
    expect((await readMonitorWorkerContent(f.artifacts, revised)).finalReport).toMatchObject({ status: 'reported', report: { summary: 'New report' } });
    await readMonitorWorkerContent(f.artifacts, revised); expect(f.read).toHaveBeenCalledTimes(2);
    await readMonitorWorkerContent(f.artifacts, { ...revised, output: { ...revised.output, byteLength: revised.output.byteLength + 1 } });
    expect(f.read).toHaveBeenCalledTimes(3);
  });
  it('caches scrubbed event, usage and patch projections independently of a changed output receipt', async () => {
    const f = fixture(), events = new TextEncoder().encode(Array.from({ length: 12 }, (_, i) => JSON.stringify({
      schemaVersion: WORKER_EVENT_SCHEMA_VERSION, sequence: i + 1, atMs: i, kind: 'message', role: 'assistant', textBytes: 4, thinking: false, excerpt: '\u001b[31mDone\u001b[0m' })).join('\n'));
    const patch = bytes({ schemaVersion: 1, kind: 'workspace-patch', identity: f.files.identity,
      source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'a'.repeat(64) },
      baseCommit: 'b'.repeat(40), snapshotDigest: 'c'.repeat(64), exclusions: patchExclusions,
      changes: Array.from({ length: 21 }, (_, i) => ({ path: `file-${String(i).padStart(2, '0')}.ts`, before: null, after: patchFile(new TextEncoder().encode('new'), '100644') })) });
    const output = f.output('\u001b[31mDone\u001b[0m'), files = { ...f.files, events: receipt(events), patch: receipt(patch), output: receipt(output) };
    const content = new Map([[files.events.digest, events], [files.patch.digest, patch], [files.output.digest, output]]);
    const read = vi.fn(async (_scope, artifact) => content.get(artifact.digest)!);
    const first = await readMonitorWorkerContent({ read }, files);
    expect(first.transcript).toMatchObject({ state: 'sealed', truncated: true }); expect(first.transcript.excerpt).toHaveLength(10);
    expect(first.patch).toMatchObject({ state: 'recorded', fileCount: 21, truncated: true }); expect(first.patch.files).toHaveLength(20);
    expect(first.usageEvidence).toBe('sealed'); expect(first.tokenUsageRecorded).toBe(false);
    expect(JSON.stringify(first)).not.toContain('\\u001b');
    expect(await readMonitorWorkerContent({ read }, files)).toEqual(first); expect(read).toHaveBeenCalledTimes(3);
    const revised = f.output('Revised'); content.set(receipt(revised).digest, revised);
    const second = await readMonitorWorkerContent({ read }, { ...files, output: receipt(revised) });
    expect(second.transcript).toEqual(first.transcript); expect(second.patch).toEqual(first.patch); expect(read).toHaveBeenCalledTimes(4);
  });
  it('isolates cache entries by installation namespace and exact attempt identity', async () => {
    const f = fixture(); await readMonitorWorkerContent(f.artifacts, f.files, 'installation-a');
    await readMonitorWorkerContent(f.artifacts, f.files, 'installation-b'); expect(f.read).toHaveBeenCalledTimes(2);
    const changed = { ...f.files, identity: { ...f.files.identity, generation: 2 } };
    expect((await readMonitorWorkerContent(f.artifacts, changed, 'installation-a')).finalReport).toMatchObject({ status: 'unavailable' });
    expect(f.read).toHaveBeenCalledTimes(3);
  });
  it('bounds retained artifacts and promotes cache hits before LRU eviction', async () => {
    // Fill the display registry's 512-entry cache, evicting any earlier test's entries without exposing a reset port.
    const entries = Array.from({ length: 512 }, fixture);
    for (const f of entries) await readMonitorWorkerContent(f.artifacts, f.files);
    const oldest = entries[0]!, next = entries[1]!, extra = fixture();
    await readMonitorWorkerContent(oldest.artifacts, oldest.files);
    await readMonitorWorkerContent(extra.artifacts, extra.files);
    await readMonitorWorkerContent(oldest.artifacts, oldest.files); expect(oldest.read).toHaveBeenCalledTimes(1);
    await readMonitorWorkerContent(next.artifacts, next.files); expect(next.read).toHaveBeenCalledTimes(2);
  });
  it.each([{ open: true, finished: false, sealed: false }, { open: false, finished: true, sealed: false }, { open: true, finished: true, sealed: true }])('does not cache live or unsealed attempts: %j', async state => {
    const f = fixture(), files = { ...f.files, ...state };
    await readMonitorWorkerContent(f.artifacts, files); await readMonitorWorkerContent(f.artifacts, files);
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it('retries unavailable reads and unavailable parsed reports instead of caching failures', async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new Error('unavailable'));
    expect((await readMonitorWorkerContent(f.artifacts, f.files)).finalReport).toMatchObject({ status: 'unavailable' });
    expect((await readMonitorWorkerContent(f.artifacts, f.files)).finalReport).toMatchObject({ status: 'reported' });
    expect(f.read).toHaveBeenCalledTimes(2);
    const missing = fixture(); missing.read.mockResolvedValueOnce(bytes({ schemaVersion: 1, identity: missing.files.identity, completeness: 'complete', stdout: '', stderr: '' }));
    expect((await readMonitorWorkerContent(missing.artifacts, missing.files)).finalReport).toMatchObject({ status: 'unavailable' });
    expect((await readMonitorWorkerContent(missing.artifacts, missing.files)).finalReport).toMatchObject({ status: 'reported' });
    expect(missing.read).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(process.platform === 'win32')('monitor cached content authorization', () => {
  it('checks read-output on every snapshot and never returns warm cached content on denial', async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), 'deckent-monitor-content-cache-')); roots.push(root);
    await mkdir(join(root, '.deckent'), { recursive: true });
    const env = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'home', '.config') }, config = await loadConfig(root, { env });
    const artifactStore = new FileArtifactStore({ root: await prepareProductDirectory(config.productLayout, 'artifacts'), maxBytes: config.artifacts.maxBytes });
    const output = await artifactStore.put('s', f.output()), events = await artifactStore.put('s', new Uint8Array());
    const store = await openSqliteAttemptStore(await prepareProductFile(config.productLayout, 'ledger'), config.storage.sqlite,
      { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store);
    const actor = { id: 'operator', issuer: 'test', subject: 'operator' }, capacity = { executionSlots: 1, inFlightSlots: 1 };
    const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
      criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
    await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: f.files.identity.runId, layoutRevision: 'layout' },
      graph, execution: fixtureExecution(graph), now: 1000, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['task'] } });
    await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: f.files.identity.runId, expectedRevision: 0, now: 2000, identities: [f.files.identity] });
    const claim = { request: { protocolVersion: 1 as const, identity: f.files.identity, workspace: '/w', argv: ['fixture'] }, owner: 'fixture-worker' };
    await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, 3000);
    await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: f.files.identity.attemptId, exitCode: 0, interrupted: false });
    await store.saveWorkerEventLog({ schemaVersion: 1, identity: f.files.identity, events, eventCount: 0, sealedAt: 4000 });
    const decision = vi.fn(async () => true), read = vi.spyOn(FileArtifactStore.prototype, 'read');
    const snapshot = async () => (await prepareMonitorInstall(config, env, decision, { scopeId: 's', runId: f.files.identity.runId })).readShown([f.files.identity]);
    expect((await snapshot()).runs[0]!.attempts[0]!.content!.finalReport).toMatchObject({ status: 'reported' });
    expect(read).toHaveBeenCalledTimes(2);
    decision.mockResolvedValue(false);
    expect((await snapshot()).runs[0]!.attempts[0]!.content).toMatchObject({ transcript: { state: 'denied' }, patch: { state: 'denied' }, finalReport: null });
    expect(read).toHaveBeenCalledTimes(2);
    decision.mockResolvedValue(true);
    expect((await snapshot()).runs[0]!.attempts[0]!.content!.finalReport).toMatchObject({ status: 'reported' });
    expect(read).toHaveBeenCalledTimes(2); expect(decision).toHaveBeenCalledTimes(3);
    const narrowed = { ...config, artifacts: { ...config.artifacts, maxBytes: output.byteLength - 1 } };
    const limited = await (await prepareMonitorInstall(narrowed, env, decision, { scopeId: 's', runId: f.files.identity.runId })).readShown([f.files.identity]);
    expect(limited.runs[0]!.attempts[0]!.content!.finalReport).toMatchObject({ status: 'unavailable' });
    expect(decision).toHaveBeenCalledTimes(4);
  });
});
