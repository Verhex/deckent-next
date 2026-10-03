import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { TaskEvaluationApplication, TaskHandoffApplication, TaskPatchStartApplication, recordAttemptHandoffStart, readAttemptHandoffEvents,
  HandoffError, recordHandoffRefusal, RunInspectionApplication } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import type { SqliteAttemptStore } from '#adapters/index.js';
import { ArtifactError, type ArtifactStore } from '#capabilities/index.js';
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = { runId: 'r', taskId: 'a', attemptId: 'a1', scopeId: 's', layoutRevision: 'l', generation: 1 };
const target = { ...source, taskId: 'b', attemptId: 'b1' };
const principal = { id: 'evaluator', issuer: 'test', subject: 'subject', assurance: 'os-user' as const, scopeIds: ['s'] };
const verifier = { async verify() { return principal; } }, authorization = { async authorizeIdentity() {} };
// The engine consumes the typed artifact port, not POSIX ownership. Keep the real POSIX adapter
// coverage and exercise the same engine contracts on Windows with exact content-addressed bytes.
function portableArtifacts(): ArtifactStore {
  const bytes = new Map<string, Uint8Array>();
  return {
    async put(scopeId, input) {
      const digest = createHash('sha256').update(input).digest('hex');
      bytes.set(`${scopeId}:${digest}`, Uint8Array.from(input));
      return { schemaVersion: 1, scopeId, digest, byteLength: input.byteLength };
    },
    async read(scopeId, receipt) {
      if (scopeId !== receipt.scopeId) throw new ArtifactError('ARTIFACT_SCOPE_DENIED');
      const value = bytes.get(`${scopeId}:${receipt.digest}`);
      if (!value || value.byteLength !== receipt.byteLength) throw new ArtifactError('ARTIFACT_CORRUPT');
      return Uint8Array.from(value);
    },
  };
}
async function fixture(mode: 'valid' | 'invalid' | 'absent' = 'valid', verdict: 'pass' | 'fail' | 'unknown' = 'pass', sourceTaskId = 'a') {
  const source = { runId: 'r', taskId: sourceTaskId, attemptId: 'a1', scopeId: 's', layoutRevision: 'l', generation: 1 };
  const root = await mkdtemp(join(tmpdir(), 'handoff-delivery-')); roots.push(root);
  const store = await openSqliteAttemptStore(join(root, 'ledger.db'), { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: () => 100, timeoutMs: 1000 }, 'allow', custodyProfiles); stores.push(store);
  const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
  const graph = { schemaVersion: 4 as const, revision: 1, tasks: [{ id: source.taskId, kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }, { id: 'b', kind: 'fixture', dependencies: [source.taskId], acceptanceCriteria: ['verified'] }, { id: 'c', kind: 'fixture', dependencies: ['b'], acceptanceCriteria: ['verified'] }], criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } });
  await store.createRun({ commandId: 'create', actor, identity: { runId: 'r', scopeId: 's', layoutRevision: 'l' }, now: 0, graph, execution: fixtureExecution(graph), policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: [source.taskId, 'b', 'c'] } });
  await store.reserveRunTasks({ commandId: 'reserve-a', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [source] });
  await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const artifacts = process.platform === 'win32' ? portableArtifacts() : new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
  const file = await artifacts.put('s', Buffer.from('code'));
  const note = { toTask: 'b', summary: 'Use result', artifacts: [{ name: 'code', digest: mode === 'invalid' ? 'b'.repeat(64) : file.digest }], openQuestions: ['review the API'] };
  const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1, summary: 'done', changedFiles: [], checks: [], openIssues: [], handoff: note, sharedNotes: ['shared for this Run'] } };
  const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: source, completeness: 'complete', stdout: mode === 'absent' ? 'worker plain output' : JSON.stringify(report), stderr: '', files: [{ name: 'code', status: 'collected', receipt: file }] })));
  const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity: source, workspace: join(root, 'workspace'), argv: ['fixture'] } };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: 'fixture', exitCode: verdict === 'fail' ? 1 : 0, interrupted: false });
  const evaluation = await new TaskEvaluationApplication(store, verifier, { async authorize() {} }, { async evaluate() { return verdict; } }, artifacts, { maxEvidenceItems: 1, maxTotalBytes: 65536 }, { now: () => 100, timeoutMs: 1000 }).execute({ schemaVersion: 1, commandId: 'evaluate', identity: source, expectedRevision: 2 });
  if (verdict === 'pass') await store.reserveRunTasks({ commandId: 'reserve-b', actor, scopeId: 's', runId: 'r', expectedRevision: evaluation.snapshot.revision, now: 100, identities: [target] });
  return { root, store, artifacts, evaluation, note, graph };
}
const limits = { maxBytes: 65536, maxSharedNotes: 10, promptBytes: 8192 };
describe('sealed report to accepted dependent', () => {
  it('records validity in evaluation, mounts exact note/shared artifacts, prompts and derives durable edge receipt', async () => {
    const f = await fixture();
    expect(JSON.parse(f.evaluation.command).evaluation.handoff.status).toBe('valid');
    const start = await new TaskHandoffApplication(f.store, verifier, authorization, f.artifacts, limits).resolve(target);
    expect(start.files.map(file => file.target)).toEqual(['/deckent/inputs/_handoff/a.json', '/deckent/inputs/_shared.json']);
    expect(JSON.parse(Buffer.from(await f.artifacts.read('s', start.files[0]!.receipt)).toString())).toEqual(f.note);
    expect(start.prompt).toContain('Use result'); expect(start.prompt).toContain('shared for this Run');
    await recordAttemptHandoffStart(f.store, target, start.events);
    expect(await readAttemptHandoffEvents(f.store, target)).toMatchObject({ events: [{ source, kind: 'handoff-received' }] });
    const view = await new RunInspectionApplication(f.store, verifier, { async authorize() {} }).inspect({ schemaVersion: 1, scopeId: 's', runId: 'r' });
    expect(view!.tasks.find(task => task.id === 'b')!.handoffs).toHaveLength(1);
    expect(await new TaskPatchStartApplication(f.store, f.artifacts, verifier, authorization, 65536).resolve(target)).toEqual([]);
  });
  it('invalid artifact note does not change acceptance or deliver handoff, but accepted shared notes remain', async () => {
    const f = await fixture('invalid');
    expect(JSON.parse(f.evaluation.command).evaluation.handoff).toEqual({ status: 'invalid', code: 'HANDOFF_ARTIFACT_MISMATCH' });
    expect(f.evaluation.snapshot.progress[0]!.phase).toBe('accepted');
    const start = await new TaskHandoffApplication(f.store, verifier, authorization, f.artifacts, limits).resolve(target);
    expect(start.events).toEqual([]); expect(start.files.map(file => file.target)).toEqual(['/deckent/inputs/_shared.json']);
  });
  it('refuses output bytes whose digest differs from the exact evaluated receipt', async () => {
    const f = await fixture();
    const tampered = { put: f.artifacts.put.bind(f.artifacts), async read(scope: string, receipt: import('#capabilities/index.js').ArtifactReceipt) {
      const bytes = await f.artifacts.read(scope, receipt); return Buffer.concat([bytes, Buffer.from(' ')]);
    } };
    await expect(new TaskHandoffApplication(f.store, verifier, authorization, tampered, limits).resolve(target)).rejects.toThrow('HANDOFF_ARTIFACT_MISMATCH');
  });
  it('plain accepted output requires no new source read permission and delivers no notes', async () => {
    const f = await fixture('absent'); let reads = 0;
    const app = new TaskHandoffApplication(f.store, verifier, { async authorizeIdentity(action) { if (action === 'read-output') { reads++; throw new Error('denied'); } } }, f.artifacts, limits);
    expect(await app.resolve(target)).toEqual({ files: [], prompt: '', events: [] }); expect(reads).toBe(0);
  });
  it.each(['fail', 'unknown'] as const)('does not open or deliver from %s predecessor', async verdict => {
    const f = await fixture('valid', verdict);
    await expect(new TaskHandoffApplication(f.store, verifier, authorization, f.artifacts, limits).resolve(target)).rejects.toThrow();
    expect(await readAttemptHandoffEvents(f.store, target)).toBeNull();
  });
  it('delivery size limits refuse before receipt/worker; typed refusal fails task, skips its dependent and survives replay', async () => {
    const f = await fixture();
    await expect(new TaskHandoffApplication(f.store, verifier, authorization, f.artifacts, { ...limits, promptBytes: 1 }).resolve(target)).rejects.toThrow('HANDOFF_LIMIT_EXCEEDED');
    const error = new HandoffError('HANDOFF_PATCH_UNAPPLICABLE');
    await recordHandoffRefusal(f.store, target, error, { id: principal.id, issuer: principal.issuer, subject: principal.subject });
    await recordHandoffRefusal(f.store, target, error, { id: principal.id, issuer: principal.issuer, subject: principal.subject });
    const run = await f.store.loadRun('s', 'r');
    expect(run!.progress.map(task => task.phase)).toEqual(['accepted', 'failed', 'skipped']); expect(run!.state.kind).toBe('parked');
    expect(await f.store.loadBoundDispatch(target)).toBeNull();
    expect((await f.store.load('s', 'b1'))!.lastObservation!.result).toEqual({ kind: 'handoff-refused', code: 'HANDOFF_PATCH_UNAPPLICABLE' });
    expect(await readAttemptHandoffEvents(f.store, target)).toBeNull();
  });
});

it.each(['src\ud800', 'src\udc00'])('refuses an accepted unpaired UTF-16 source %j before artifact writes', async sourceTaskId => {
  const f = await fixture('valid', 'pass', sourceTaskId), put = vi.fn(f.artifacts.put.bind(f.artifacts));
  expect(f.evaluation.snapshot.progress[0]).toMatchObject({ taskId: sourceTaskId, phase: 'accepted' });
  const app = new TaskHandoffApplication(f.store, verifier, authorization, { read: f.artifacts.read.bind(f.artifacts), put }, limits);
  await expect(app.resolve(target)).rejects.toBeInstanceOf(HandoffError);
  await expect(app.resolve(target)).rejects.toMatchObject({ code: 'HANDOFF_INVALID' });
  expect(put).not.toHaveBeenCalled();
  expect(await f.store.loadBoundDispatch(target)).toBeNull();
  expect(await readAttemptHandoffEvents(f.store, target)).toBeNull();
});
it.each([
  ['src\ud83d\ude80', 'src%F0%9F%9A%80.json'], ['Türkçe漢', 'T%C3%BCrk%C3%A7e%E6%BC%A2.json'],
  ["percent%/slash!'()*", 'percent%25%2Fslash%21%27%28%29%2A.json'], ['é'.repeat(41) + 'abcd', '%C3%A9'.repeat(41) + 'abcd.json'],
])('preserves exact representable source %j and encoded component bytes', async (sourceTaskId, filename) => {
  const f = await fixture('valid', 'pass', sourceTaskId);
  const start = await new TaskHandoffApplication(f.store, verifier, authorization, f.artifacts, limits).resolve(target);
  expect(start.files[0]!.target).toBe('/deckent/inputs/_handoff/' + filename);
  expect(start.events[0]!.source.taskId).toBe(sourceTaskId);
  expect(Buffer.byteLength(filename)).toBeLessThanOrEqual(255);
  // These percent-encoded ASCII components are legal on NTFS as well as POSIX.
  // Exercise the host filesystem too, including the exact 255-byte boundary.
  const bytes = await f.artifacts.read('s', start.files[0]!.receipt);
  await writeFile(join(f.root, filename), bytes);
  expect(await readFile(join(f.root, filename))).toEqual(Buffer.from(bytes));
});
it('refuses a 256-byte encoded component before writing either note or shared artifact', async () => {
  const f = await fixture('valid', 'pass', 'é'.repeat(41) + 'abcde'), put = vi.fn(f.artifacts.put.bind(f.artifacts));
  expect(Buffer.byteLength(encodeURIComponent('é'.repeat(41) + 'abcde') + '.json')).toBe(256);
  await expect(new TaskHandoffApplication(f.store, verifier, authorization, { read: f.artifacts.read.bind(f.artifacts), put }, limits).resolve(target)).rejects.toMatchObject({ code: 'HANDOFF_INVALID' });
  expect(put).not.toHaveBeenCalled();
});

it.for(['win32'] as const)('real artifact adapter refuses %s before creating a storage root (native Windows; platform-property simulation on POSIX)', async platform => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-artifact-refusal-')); roots.push(root);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try { expect(() => new FileArtifactStore({ root: join(root, 'never-created'), maxBytes: 65536 })).toThrow(new ArtifactError('ARTIFACT_UNSUPPORTED')); }
  finally { Object.defineProperty(process, 'platform', original); }
  expect(await readdir(root)).toEqual([]);
});
