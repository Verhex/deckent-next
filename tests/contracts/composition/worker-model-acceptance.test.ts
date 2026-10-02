import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelCatalog, applyRunLifecycle, createRun, inspectConfiguredWorkerTranscript, inspectConfiguredWorkers, inspectRun } from '../../../src/index.js';
import { evaluateConfiguredTask } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, compileNativeCodingDockerProfile, openSqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import { seedCatalog, SEED_CHANNEL } from '../support/model-catalog.js';

/**
 * WORKER-CURRENCY-2 acceptance (owner rule A 2026-09-30; Jev 933e43f2 + 58ffe1c9): the existing Task evaluation owner reads the host-sealed
 * model verdict of a pinned worker attempt. Undeclared model => not accepted (failed, typed, recorded); declared auxiliary => accepted and
 * visible; a pinned Claude attempt without a sealed 'verified' verdict is parked (awaiting-decision); Codex stays visibly unverified and is accepted.
 */
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const HAIKU = 'claude-haiku-4-5-20251001', SONNET = 'claude-sonnet-5-5', CODEX_CHANNEL = 'codex-cli-test';
const template = { id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: { argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64),
  memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } };
const claude = { ...compileNativeCodingDockerProfile(template, { schemaVersion: 4, provider: 'claude', cliVersion: '2.1.285 (Claude Code)',
  discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended', model: { channelId: SEED_CHANNEL, modelId: SONNET, auxiliaryModelIds: [HAIKU] },
  prompt: 'Edit note.txt.' }), id: 'claude' };
const codex = { ...compileNativeCodingDockerProfile(template, { schemaVersion: 4, provider: 'codex', cliVersion: 'codex-cli 0.159.2',
  discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended', model: { channelId: CODEX_CHANNEL, modelId: 'gpt-exact-1', auxiliaryModelIds: [] },
  prompt: 'Edit note.txt.' }), id: 'codex' };
const profiles = [claude, codex];
const registry = { schemaVersion: 1 as const, revision: 'worker-currency-2', profiles,
  kinds: profiles.map(profile => ({ kind: profile.id, profile: { id: profile.id, version: 1 } })),
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
const codexCatalog = { schemaVersion: 2, revision: 'codex-test', providers: [{ id: CODEX_CHANNEL, version: 1, channel: { kind: 'native-cli', cli: 'codex', aliases: [] },
  models: [{ id: 'gpt-exact-1', version: 1, nativeId: 'gpt-exact-1', protocols: [{ family: 'codex-exec-json', version: 'v1', capabilities: [] }],
    lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, efforts: [], aliases: [] }] }] };

type Event = Record<string, unknown>;
const started = (model: string | null, provider = 'claude'): Event => ({ kind: 'session.started', provider, model, cliVersion: null });
const ended = (models?: string[]): Event => ({ kind: 'session.ended', outcome: 'success', turns: 3, durationMs: 1000, apiDurationMs: null, costUsd: null,
  costBasis: null, tokens: null, permissionDenials: 0, ...(models ? { models } : {}) });
const verdict = (status: string, observed: string[], unexpected: string[] = [], admitted: string | null = SONNET): Event =>
  ({ kind: 'model.verification', status, admitted, observed, unexpected });

async function fixture(kind: 'claude' | 'codex' = 'claude', retainOutput = true) {
  const project = await mkdtemp(join(tmpdir(), 'dn-model-accept-')); roots.push(project); const data = join(project, 'd');
  await mkdir(join(project, '.deckent'), { recursive: true }); const options = { env: { HOME: join(project, 'h') } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry } }));
  const opened = await openConfiguredAttemptStore(project, options);
  try { await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); } finally { opened.store.close(); }
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'attempt', effect: 'allow', actions: ['evaluate', 'read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'catalog', effect: 'allow', actions: ['activate', 'deactivate', 'inspect'], scopes: 'all', principals, resource: { kind: 'model-activation', ids: 'all' } },
  ] }), { mode: 0o600 });
  let sequence = 0;
  const catalog = (command: Record<string, unknown>) => applyModelCatalog(project, { schemaVersion: 1, commandId: `catalog-${++sequence}`, scopeId: 's', ...command }, options);
  await catalog({ action: 'register', catalog: await seedCatalog() }); await catalog({ action: 'register', catalog: codexCatalog });
  for (const [channelId, modelId] of [[SEED_CHANNEL, null], [SEED_CHANNEL, SONNET], [SEED_CHANNEL, HAIKU], [CODEX_CHANNEL, null], [CODEX_CHANNEL, 'gpt-exact-1']] as const) {
    await catalog({ action: 'activate', channelId, modelId, expectedRevision: 0 });
  }
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
  try {
    await store.reserveRunTasks({ commandId: 'reserve', actor: { id: 'fixture', issuer: 'test', subject: 'service' }, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
    const request = { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['private-task-command'] }; const claim = { owner: 'fixture-worker', request };
    await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
    const envelope = { schemaVersion: 1, identity, completeness: 'complete', stdout: 'done', stderr: '' };
    if (retainOutput) await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify(envelope))));
    await store.finishDispatch(claim, { handle: 'fixture-handle', exitCode: 0, interrupted: false });
  } finally { store.close(); }
  /** Seal a worker event log the way execution does after the gateway closed (host verdict last). */
  const seal = async (events: readonly Event[] | string) => {
    const lines = typeof events === 'string' ? events : events.map((event, index) => JSON.stringify({ schemaVersion: 1, sequence: index + 1, atMs: index, ...event }) + '\n').join('');
    const writer = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try { await writer.saveWorkerEventLog({ schemaVersion: 1, identity, events: await artifacts.put('s', Buffer.from(lines)), eventCount: events.length, sealedAt: 1, projection: 'complete' }); }
    finally { writer.close(); }
  };
  const evaluate = (commandId = 'evaluation', expectedRevision = 2) => evaluateConfiguredTask(project, { schemaVersion: 1, commandId, identity, expectedRevision }, options);
  const open = () => openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const recover = async () => {
    const writer = await open();
    try { await writer.retainDispatchOutput({ owner: 'fixture-worker', request: { protocolVersion: 1, identity, workspace: '/private/workspace', argv: ['private-task-command'] } },
      await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: 'done', stderr: '' })))); }
    finally { writer.close(); }
  };
  return { project, options, identity, seal, evaluate, recover, path: opened.path, open };
}

describe.skipIf(process.platform === 'win32')('worker model acceptance through the Task evaluation owner (WORKER-CURRENCY-2)', () => {
  it('does not accept an attempt whose sealed usage names an undeclared model: failed, typed and recorded, replay-stable', async () => {
    const f = await fixture();
    await f.seal([started(SONNET), ended([SONNET, 'claude-opus-5-5']), verdict('substituted', ['claude-opus-5-5', SONNET], ['claude-opus-5-5'])]);
    const result = await f.evaluate();
    expect(result.evaluation.run.tasks[0]!.phase).toBe('failed');
    expect(result.evaluation.model).toEqual({ provider: 'claude', requested: { channelId: SEED_CHANNEL, modelId: SONNET, auxiliaryModelIds: [HAIKU] },
      init: SONNET, usage: [SONNET, 'claude-opus-5-5'], verdict: 'substituted', unexpected: ['claude-opus-5-5'], evidence: 'sealed' });
    expect(await f.evaluate()).toEqual(result);
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options);
    expect(inspected.run!.tasks[0]!.phase).toBe('failed');
    expect(inspected.models).toEqual([expect.objectContaining({ taskId: 't', attemptId: 'a', verdict: 'substituted', unexpected: ['claude-opus-5-5'], evidence: 'sealed' })]);
  });
  it('accepts a declared auxiliary model and shows requested -> init -> usage -> verdict on run inspect, workers and the transcript', async () => {
    const f = await fixture();
    await f.seal([started(SONNET), ended([SONNET, HAIKU]), verdict('verified', [HAIKU, SONNET])]);
    const result = await f.evaluate();
    expect(result.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(result.evaluation.model).toMatchObject({ verdict: 'verified', init: SONNET, usage: [SONNET, HAIKU], unexpected: [] });
    const row = { taskId: 't', attemptId: 'a', provider: 'claude', requested: { channelId: SEED_CHANNEL, modelId: SONNET, auxiliaryModelIds: [HAIKU] },
      init: SONNET, usage: [SONNET, HAIKU], verdict: 'verified', unexpected: [], evidence: 'sealed' };
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).models).toEqual([row]);
    const workers = await inspectConfiguredWorkers(f.project, { schemaVersion: 1, scopeId: 's' }, f.options);
    expect(workers.sources[0]!.workers[0]!.model).toMatchObject({ requested: row.requested, init: SONNET, usage: [SONNET, HAIKU], verdict: 'verified', evidence: 'sealed' });
    expect((await inspectConfiguredWorkerTranscript(f.project, f.identity, f.options)).model).toMatchObject({ verdict: 'verified', usage: [SONNET, HAIKU] });
  });
  it.each([
    ['no sealed log', null],
    ['a sealed log without a host verdict (no session end)', [started(SONNET)]],
    ['a sealed unverified verdict (usage without the pinned model)', [started(SONNET), ended(), verdict('unverified', [SONNET])]],
  ] as const)('parks a pinned Claude attempt with %s for a human decision, never plain verified acceptance', async (_label, events) => {
    const f = await fixture();
    if (events) await f.seal(events);
    const result = await f.evaluate();
    expect(result.evaluation.run.tasks[0]!.phase).toBe('awaiting-decision');
    expect(result.evaluation.model).toMatchObject({ verdict: events ? 'unverified' : 'unverified', evidence: events ? 'sealed' : 'absent' });
  });
  it('refuses real evidence-less reevaluation and records a human SDK decision with visible unverified acceptance', async () => {
    const f = await fixture();
    expect((await f.evaluate('early', 2)).evaluation.run.tasks[0]!.phase).toBe('awaiting-decision');
    await expect(f.evaluate('later', 3)).rejects.toMatchObject({ code: 'TASK_EVALUATION_NOT_READY' });
    const command = { schemaVersion: 1 as const, commandId: 'human-accept', scopeId: 's', runId: 'r', taskId: 't', action: 'accept' as const, expectedRevision: 3 };
    const accepted = await applyRunLifecycle(f.project, command, f.options);
    expect(accepted!.lifecycle.run.tasks[0]).toMatchObject({ phase: 'accepted', acceptedEvidence: 'model-unverified' });
    expect(accepted!.lifecycle.run.state).toMatchObject({ kind: 'terminal', outcome: 'completed' });
    expect(await applyRunLifecycle(f.project, command, f.options)).toEqual(accepted);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      const events = db.prepare('SELECT record FROM audit_events').all().map(row => JSON.parse(String(row.record)).event);
      const decision = events.filter(event => event.subject.kind === 'run-lifecycle');
      expect(decision).toHaveLength(1);
      expect(decision[0]).toMatchObject({ principal: { issuer: hostname(), subject: String(userInfo().uid) },
        subject: { action: 'accept', evidence: 'model-unverified', commandId: 'human-accept' } });
    } finally { db.close(); }

    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks[0])
      .toMatchObject({ phase: 'accepted', acceptedEvidence: 'model-unverified' });
  });
  it('a held attempt is accepted by a later evaluation once the host sealed a verified verdict (HOLD is recoverable)', async () => {
    const f = await fixture();
    const parked = await f.evaluate('early', 2);
    expect(parked.evaluation.run.tasks[0]!.phase).toBe('awaiting-decision');
    await f.seal([started(SONNET), ended([SONNET]), verdict('verified', [SONNET])]);
    const accepted = await f.evaluate('later', 3);
    expect(accepted.evaluation.run.tasks[0]).toMatchObject({ phase: 'accepted' });
    expect(accepted.evaluation.run.tasks[0]!.acceptedEvidence).toBeUndefined();
    expect(accepted.evaluation.model).toMatchObject({ verdict: 'verified', evidence: 'sealed' });
    const store = await f.open();
    try {
      const receipt = JSON.parse((await store.loadRunReceipt('s', 'later'))!.command);
      const seal = await store.loadWorkerEventLog('s', 'a');
      expect(receipt.evaluation.returnEvidence).toEqual({ kind: 'model-seal', digest: seal!.events.digest });
    } finally { store.close(); }
    expect(await f.evaluate('later', 3)).toEqual(accepted);
  });
  it('new recovered output never bypasses rule A substitution after park', async () => {
    const f = await fixture('claude', false);
    const parked = await f.evaluate('no-output', 2);
    expect(parked.evaluation.run.tasks[0]).toMatchObject({ phase: 'awaiting-decision', decision: { reason: 'evaluation-not-ready' } });
    await f.seal([started(SONNET), ended([SONNET, 'claude-opus-5-5']), verdict('substituted', [SONNET, 'claude-opus-5-5'], ['claude-opus-5-5'])]);
    await f.recover();
    const failed = await f.evaluate('recovered-substitution', 3);
    expect(failed.evaluation.run.tasks[0]!.phase).toBe('failed');
    expect(failed.evaluation.model).toMatchObject({ verdict: 'substituted' });
  });
  it('keeps Codex visibly unverified and accepted by its criteria', async () => {
    const f = await fixture('codex');
    await f.seal([started(null, 'codex'), ended(), verdict('unverified', [], [], 'gpt-exact-1')]);
    const result = await f.evaluate();
    expect(result.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(result.evaluation.model).toMatchObject({ provider: 'codex', verdict: 'unverified', evidence: 'sealed' });
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).models)
      .toEqual([expect.objectContaining({ provider: 'codex', verdict: 'unverified' })]);
  });
  it('refuses to evaluate a pinned attempt whose sealed log is present but invalid (no silent acceptance, nothing recorded)', async () => {
    const f = await fixture();
    await f.seal('{"kind":"model.verification","status":"verified"}\n');
    await expect(f.evaluate()).rejects.toMatchObject({ code: 'TASK_EVIDENCE_INVALID' });
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options);
    expect(inspected.run).toMatchObject({ revision: 2, tasks: [expect.objectContaining({ phase: 'evaluating' })] });
    expect(inspected.models).toEqual([expect.objectContaining({ verdict: 'unverified', evidence: 'invalid', init: null })]);
  });
  it('the ledger commit refuses a pinned Task evaluation without model evidence, or with evidence for another pin (no bypass of the gate)', async () => {
    const f = await fixture();
    const store = await f.open();
    try {
      const dispatch = (await store.loadBoundDispatch(f.identity))!;
      const base = { schemaVersion: 1 as const, evaluationId: 'forged', identity: f.identity, graphRevision: 1, attemptRevision: (await store.load('s', 'a'))!.revision,
        criteria: [{ criterionId: 'exit', verdict: 'pass' as const, evidenceIds: ['dispatch-output'] }] };
      const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
      const model = { provider: 'claude' as const, requested: { channelId: SEED_CHANNEL, modelId: SONNET, auxiliaryModelIds: [HAIKU] }, init: SONNET, usage: [SONNET],
        verdict: 'verified' as const, unexpected: [], evidence: 'sealed' as const };
      for (const evaluation of [base, { ...base, model: { ...model, requested: { ...model.requested, modelId: 'claude-opus-5-5' } } }, { ...base, model: { ...model, provider: 'codex' as const } }]) {
        await expect(store.commitTaskEvaluation({ commandId: 'forged', actor, expectedRevision: 2, evaluation, dispatch })).rejects.toMatchObject({ code: 'TASK_EVALUATION_INVALID' });
      }
      expect((await store.loadRun('s', 'r'))!.revision).toBe(2);
    } finally { store.close(); }
  });
});
