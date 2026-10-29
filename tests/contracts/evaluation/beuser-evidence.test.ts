import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beuserBindingSchema } from '#domain/core/beuser/index.js';
import { beuserEvaluatorPrincipalRef, verifiedPrincipalSchema, evaluatePolicy } from '#domain/index.js';
import { createBeuserTranscript, createBeuserEvidencePort, collectBeuserReadback, createBeuserEvaluationPort } from '#engine/core/beuser-evidence/index.js';
import { BeuserContractError, beuserDiagnosticSchema, pinBeuserLimits, type BeuserContext } from '#engine/core/beuser-contract/index.js';
import { snapshotKnownSecrets, EMPTY_KNOWN_SECRETS } from '#platform/index.js';
import { BEUSER_EVALUATOR, beuserDigest, createInstalledTerminalEvaluator, validateInstalledCriterion, type BeuserEvidence } from '#capabilities/core/evaluation-evidence/index.js';
import { TaskEvaluationApplication, resolveExecutionRegistry, verifyDispatchEvaluationEvidence } from '#engine/index.js';
import { FileArtifactStore, openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { custodyProfiles, custodyProfile, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const binding = beuserBindingSchema.parse({ schemaVersion: 1, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 },
  candidate: { adapter: 'record', version: 'v1', evidenceRef: 'candidate', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) },
  candidateDigest: 'c'.repeat(64), personaDigest: 'd'.repeat(64), journeyDigest: 'e'.repeat(64), rubricDigest: 'f'.repeat(64),
  realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' });
const ref = beuserEvaluatorPrincipalRef({ issuer: 'local', subject: 'person' });
const principal = verifiedPrincipalSchema.parse({ id: 'evaluator', ...ref, assurance: 'workload-verified', scopeIds: ['s'] });
const limits = pinBeuserLimits({ schemaVersion: 1, revision: 'test-policy', source: 'fixture', provisional: true, maxSteps: 25, maxWallMs: 10000,
  maxWaitMs: 1000, maxCalls: 10, maxTokens: 1000, maxCost: 1, currency: 'USD', maxReruns: 1, maxTranscriptBytes: 30000,
  maxArtifactBytes: 30000, cleanupDeadlineMs: 1000, criticalRepetitions: 1 });
const context: BeuserContext = { binding, principal, limits, signal: new AbortController().signal };
const summary = { installation: 'absent', preservedData: 'pass', card: 'shown', receiptLocation: 'outside-realm', forbiddenEffect: 'absent', lifecycle: 'absent' } as const;
const readback = { schemaVersion: 1 as const, binding, evidenceRef: 'readback', atMs: 2, summary };
const parameters = { binding, producer: { owner: 'harness', profileDigest: beuserDigest(custodyProfile) }, fileName: 'beuser-evidence', dimension: 'outcome',
  probes: [{ id: 'installed', dimension: 'outcome', readbackRef: 'readback', key: 'installation', expected: 'absent' },
    { id: 'card', dimension: 'authorization', readbackRef: 'readback', key: 'card', expected: 'shown' },
    { id: 'forbidden', dimension: 'safety', readbackRef: 'readback', key: 'forbiddenEffect', expected: 'absent' }],
  calibration: { revision: 'cal-v1', cohort: 'cohort-a', trapHits: 5, trapTotal: 5, falseRed: 0, goodTotal: 3, minimumHitRate: 1, maximumFalseRedRate: 0, k: 1, retries: 0 } };
const evidenceLimits = { maxEvidenceItems: 4, maxTotalBytes: 65536 };
function document(): BeuserEvidence {
  const recorder = createBeuserTranscript(context, EMPTY_KNOWN_SECRETS);
  recorder.append(context, { binding, atMs: 2, kind: 'readback', evidenceRef: 'readback', text: JSON.stringify(summary) });
  return { schemaVersion: 1, binding, transcript: recorder.finalize(context).transcript, readbacks: [readback], validity: 'valid',
    cleanup: { state: 'destroyed', atMs: 3, evidenceRef: 'controller-destruction' },
    experience: { verdict: 'pass', maker: 'reviewer', sourceMakers: ['author', 'walker'], evidenceRefs: ['readback'] } };
}
// Explicit policy allowance precedes every denial assertion; a denial is never manufactured by replacing the operation.
function grant(resource: { kind: string; id: string }, action: string) {
  const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'explicit-card-grant', principals: [ref], scopes: 'all',
    actions: [action], resource: { kind: resource.kind, ids: 'all' }, effect: 'allow' }] };
  expect(evaluatePolicy(policy, { principal, scopeId: 's', resource, action }).decision).toBe('allow');
}
it('redacts before hashing, model delivery and retention; secret steps never retain even a hash of the secret', () => {
  grant({ kind: 'beuser-transcript', id: 'transcript' }, 'inspect');
  const secret = 'fixture-private-credential', recorder = createBeuserTranscript(context, snapshotKnownSecrets([{ name: 'FIXTURE', value: secret }]));
  const screen = recorder.append(context, { binding, atMs: 0, kind: 'screen', evidenceRef: 'screen', text: `visible ${secret}` });
  const hidden = recorder.append(context, { binding, atMs: 1, kind: 'secret-step', evidenceRef: 'secret', text: secret });
  expect(screen.text).not.toContain(secret); expect(hidden.text).toBe('');
  expect(hidden.entry.digest).not.toBe(beuserDigest(secret)); expect(JSON.stringify(recorder.finalize(context))).not.toContain(secret);
  expect(() => recorder.append(context, { binding, atMs: 2, kind: 'action', evidenceRef: 'late', text: 'press' })).toThrow('BEUSER_INPUT_INVALID');
});
it('refuses partial known-secret prefixes, reordered time, budget overflow and foreign generation before append', () => {
  grant({ kind: 'beuser-transcript', id: 'transcript' }, 'inspect');
  const recorder = createBeuserTranscript(context, snapshotKnownSecrets([{ name: null, value: 'fixture-private-credential' }]));
  const event = { binding, atMs: 1, kind: 'screen' as const, evidenceRef: 'screen', text: 'visible' };
  expect(() => recorder.append(context, { ...event, text: 'fixture-private-' })).toThrow();
  expect(() => recorder.append(context, { ...event, binding: { ...binding, identity: { ...binding.identity, generation: 2 } } })).toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(() => recorder.append(context, { ...event, text: 'x'.repeat(30001) })).toThrow();
  recorder.append(context, event);
  // Typed, so a walk report carries the code (walk17 S1).
  expect(() => recorder.append(context, { ...event, evidenceRef: 'earlier', atMs: 0 })).toThrow(BeuserContractError);
  expect(recorder.finalize(context).transcript).toHaveLength(1);
});
it('allows only typed readback summaries and refuses raw ledger, receipt and foreign target input', async () => {
  grant({ kind: 'beuser-transcript', id: 'transcript' }, 'inspect');
  expect(await collectBeuserReadback(context, async () => readback)).toEqual(readback);
  for (const extra of [{ ledger: 'raw' }, { receipt: 'raw' }, { backup: 'raw' }]) await expect(collectBeuserReadback(context, async () => ({ ...readback, ...extra }))).rejects.toThrow();
  await expect(collectBeuserReadback(context, async () => ({ ...readback, binding: { ...binding, realmId: 'foreign' } }))).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  const stopped = new AbortController(); stopped.abort(); const probe = vi.fn(async () => readback);
  await expect(collectBeuserReadback({ ...context, signal: stopped.signal }, probe)).rejects.toThrow(); expect(probe).not.toHaveBeenCalled();
});
it('accepts only captured metadata through EvidencePort and denies inspect before reading a verdict', async () => {
  grant({ kind: 'beuser-transcript', id: 'transcript' }, 'inspect');
  const recorder = createBeuserTranscript(context, EMPTY_KNOWN_SECRETS), readVerdict = vi.fn(async () => null);
  const port = createBeuserEvidencePort(context, recorder, readVerdict);
  const row = recorder.append(context, { binding, atMs: 0, kind: 'screen', evidenceRef: 'screen', text: 'visible' });
  await port.append(context, row.entry);
  await expect(port.append(context, { ...row.entry, digest: 'a'.repeat(64) })).rejects.toMatchObject({ name: 'BeuserContractError', code: 'BEUSER_INPUT_INVALID' });
  await expect(port.readback({ ...context, binding: { ...binding, transcriptId: 'foreign' } })).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(readVerdict).not.toHaveBeenCalled();
  expect((await port.finalize(context)).evidenceRefs).toEqual(['screen']);
});
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(missingFile = false, contentInput: unknown = document(), outcomeOnly = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-beuser-evidence-')); roots.push(root);
  const path = join(root, 'ledger.db'), options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
  const open = async () => { const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store); return store; };
  const store = await open(), actor = { id: 'author', issuer: 'test', subject: 'fixture' };
  const definitions = (outcomeOnly ? ['outcome'] : ['outcome', 'authorization', 'safety']).map(dimension => ({ id: dimension, version: 1, description: `Observe ${dimension}`,
    evaluator: { id: 'beuser', version: 1 }, parameters: { ...parameters, dimension } }));
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'journey', dependencies: [], acceptanceCriteria: definitions.map(d => d.id) }], criterionDefinitions: definitions };
  const execution = resolveExecutionRegistry(graph, { schemaVersion: 1, revision: 'beuser-fixture',
    profiles: [{ id: 'fixture', version: 1, adapter: { id: 'test-supervisor', version: 1 }, parameters: {} }],
    kinds: [{ kind: 'journey', profile: { id: 'fixture', version: 1 }, workspaceDelivery: 'none' }], evaluators: [BEUSER_EVALUATOR] },
  { profile() { return undefined; }, criterion: validateInstalledCriterion });
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'r', layoutRevision: 'l' }, now: 0, graph, execution,
    policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [binding.identity] });
  const claim = { owner: 'harness', request: { protocolVersion: 1 as const, identity: binding.identity, workspace: root, argv: ['test-only-harness'] } };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await mkdir(join(root, 'artifacts'), { mode: 0o700 }); const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 65536 });
  const content = Buffer.from(JSON.stringify(contentInput)), file = await artifacts.put('s', content);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, identity: binding.identity, completeness: 'complete', stdout: 'walked', stderr: '',
    files: missingFile ? [] : [{ name: 'beuser-evidence', status: 'collected', receipt: file }] }));
  const output = await artifacts.put('s', bytes);
  await store.retainDispatchOutput(claim, output); const dispatch = await store.finishDispatch(claim, { handle: 'harness', exitCode: 0, interrupted: false });
  const command = { schemaVersion: 1 as const, commandId: 'evaluate', identity: binding.identity, expectedRevision: 2 };
  let allow = true, writes = 0;
  const evaluator = createInstalledTerminalEvaluator({ async loadEffect() { throw new Error('unused'); } });
  const app = (reader = store, readArtifacts = artifacts as Pick<FileArtifactStore, 'read'>, bounds = evidenceLimits) => new TaskEvaluationApplication(new Proxy(reader, { get(target, property) {
    if (property === 'commitTaskEvaluation') return (...args: Parameters<SqliteAttemptStore['commitTaskEvaluation']>) => { writes++; return target.commitTaskEvaluation(...args); };
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } }), { async verify() { return principal; } }, { async authorize() { if (!allow) throw new Error('POLICY_DENIED'); } }, evaluator, readArtifacts, bounds, { now: () => 100, timeoutMs: 1000 });
  return { store, open, dispatch, artifacts, file, content, command, app, writes: () => writes, deny() { allow = false; } };
}
describe.skipIf(process.platform === 'win32')('real retained dispatch and TaskEvaluation custody', () => {
  it('consumes harness files, commits once and replays after reopen through the existing writer', async () => {
    grant({ kind: 'attempt', id: 'a' }, 'evaluate'); const f = await fixture();
    const port = createBeuserEvaluationPort(context, f.app(), undefined);
    await expect(port.evaluate(context, { ...f.command, identity: { ...binding.identity, generation: 2 } })).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
    expect(f.writes()).toBe(0);
    const first = await port.evaluate(context, f.command); expect(first.snapshot.progress[0]?.phase).toBe('accepted'); expect(f.writes()).toBe(1);
    const reopened = await f.open(); expect(await f.app(reopened).execute(f.command)).toEqual(first); expect(f.writes()).toBe(1);
    f.deny(); await expect(f.app(reopened).execute(f.command)).rejects.toThrow('POLICY_DENIED'); expect(f.writes()).toBe(1);
  });
  it('holds a sole outcome criterion when installation passes but security is unknown or failed', async () => {
    grant({ kind: 'attempt', id: 'a' }, 'evaluate');
    for (const forbiddenEffect of ['unknown', 'present'] as const) {
      const data = document(), observed = { ...summary, forbiddenEffect };
      const recorder = createBeuserTranscript(context, EMPTY_KNOWN_SECRETS);
      recorder.append(context, { binding, atMs: 2, kind: 'readback', evidenceRef: 'readback', text: JSON.stringify(observed) });
      const f = await fixture(false, { ...data, transcript: recorder.finalize(context).transcript, readbacks: [{ ...readback, summary: observed }] }, true);
      const result = await f.app().execute(f.command);
      expect(result.snapshot.progress[0]?.phase).not.toBe('accepted');
      expect(result.snapshot.progress[0]?.phase).toBe(forbiddenEffect === 'unknown' ? 'awaiting-decision' : 'failed');
    }
    const positive = await fixture(false, document(), true);
    expect((await positive.app().execute(positive.command)).snapshot.progress[0]?.phase).toBe('accepted');
  });
  it('rejects inspect/evaluate/replay denial with zero evaluation writes', async () => {
    grant({ kind: 'attempt', id: 'a' }, 'evaluate'); const f = await fixture(); f.deny();
    await expect(f.app().execute(f.command)).rejects.toThrow('POLICY_DENIED');
    await expect(f.app().execute(f.command)).rejects.toThrow('POLICY_DENIED');
    expect(f.writes()).toBe(0); expect(await f.store.loadRunReceipt('s', 'evaluate')).toBeNull();
  });
  it('holds missing readback file instead of converting exit zero to acceptance', async () => {
    const f = await fixture(true);
    expect((await f.app().execute(f.command)).snapshot.progress[0]?.phase).toBe('awaiting-decision');
  });
  it('holds leaked harness content with valid receipts and refuses an absent producer output', async () => {
    const data = document(), text = 'Bearer fixture-token-with-no-real-credential';
    const leaked = { ...data, transcript: [{ entry: { ...data.transcript[0]!.entry, kind: 'screen', digest: beuserDigest(text) }, text }] };
    const f = await fixture(false, leaked);
    expect((await f.app().execute(f.command)).snapshot.progress[0]?.phase).toBe('awaiting-decision');
    const missing = { ...f.dispatch }; delete missing.output;
    await expect(verifyDispatchEvaluationEvidence({ schemaVersion: 1, evaluationId: 'test-evidence', identity: binding.identity, graphRevision: 1, attemptRevision: 1,
      criteria: [{ criterionId: 'outcome', verdict: 'unknown', evidenceIds: ['output'] }] }, f.dispatch.request,
      [{ evidenceId: 'output', receipt: f.dispatch.output }], { async readDispatch() { return missing; } }, f.artifacts, evidenceLimits)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
  });
  it('rejects matching digests from a wrong producer, profile or generation with zero evaluation writes', async () => {
    grant({ kind: 'attempt', id: 'a' }, 'evaluate'); const f = await fixture();
    for (const dispatch of [{ ...f.dispatch, owner: 'worker-self-report' }, { ...f.dispatch, profile: { ...f.dispatch.profile, adapterId: 'other' } },
      { ...f.dispatch, request: { ...f.dispatch.request, identity: { ...binding.identity, generation: 2 } }, grant: { ...f.dispatch.grant!, generation: 2 } }]) {
      const reader = new Proxy(f.store, { get(target, property) {
        if (property === 'loadBoundDispatch') return async () => dispatch;
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await expect(f.app(reader).execute(f.command)).rejects.toThrow(dispatch.request.identity.generation === 1 ? 'TASK_EVIDENCE_UNLINKED' : 'TASK_EVALUATION_STALE');
    }
    expect(f.writes()).toBe(0);
  });
  it('rejects changed artifact bytes and enforces aggregate output/file budgets', async () => {
    const f = await fixture(), read = vi.fn(async (scope: string, receipt: typeof f.file) => receipt.digest === f.file.digest ? Buffer.from('tampered') : f.artifacts.read(scope, receipt));
    await expect(f.app(f.store, { read }).execute(f.command)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
    const boundedRead = vi.fn(f.artifacts.read.bind(f.artifacts));
    await expect(f.app(f.store, { read: boundedRead }, { ...evidenceLimits, maxTotalBytes: f.dispatch.output!.byteLength }).execute(f.command)).rejects.toThrow('TASK_EVIDENCE_UNLINKED');
    expect(boundedRead).toHaveBeenCalledTimes(1);
    expect(createHash('sha256').update(f.content).digest('hex')).toBe(f.file.digest);
  });
});

it('diagnostic references stay unique, bound to their branch and backed by a captured screen', () => {
  grant({ kind: 'beuser-transcript', id: 'transcript' }, 'inspect');
  const trace = [{ evidenceRef: 'screen', kind: 'screen', artifactRef: 'sha256:' + '1'.repeat(64) }];
  const finding = { schemaVersion: 1, binding, branch: 't', persona: 'buyer', code: 'persona-stuck', reason: 'loop', outcome: 'RED',
    screen: 'Permission question', screenRef: 'screen', screenDigest: '2'.repeat(64), evidenceRefs: [trace[0]!.artifactRef], controllerValidity: 'unknown' };
  const diagnostic = { schemaVersion: 1, trace, finding };
  expect(beuserDiagnosticSchema.parse(diagnostic).finding).toEqual(finding);
  expect(beuserDiagnosticSchema.parse({ ...diagnostic, finding: { ...finding, reason: 'observing' } }).finding?.reason).toBe('observing'); // Walk18.
  expect(beuserDiagnosticSchema.safeParse({ ...diagnostic, trace: [...trace, ...trace] }).success).toBe(false);
  expect(beuserDiagnosticSchema.safeParse({ ...diagnostic, finding: { ...finding, branch: 'foreign-task' } }).success).toBe(false);
  expect(beuserDiagnosticSchema.safeParse({ ...diagnostic, finding: { ...finding, screenRef: 'not-captured' } }).success).toBe(false);
  expect(beuserDiagnosticSchema.safeParse({ ...diagnostic, finding: { ...finding, evidenceRefs: ['sha256:' + '3'.repeat(64)] } }).success).toBe(false);
});
