import { expectRecordedEvaluation } from '../support/run-cost-observation.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun, inspectRun, evaluateTask, inspectMonitor, inspectConfiguredWorkerTranscript } from '../../../src/index.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { main } from '#surfaces/index.js';
import { createMcpServer } from '#surfaces/core/mcp/index.js';
// Exercise the production runtime operation map without opening a service or broadening its public API.
// eslint-disable-next-line no-restricted-imports
import { createConfiguredRuntimeOperations } from '#composition/core/runtime-service/internal/operations.js';
import { advanceConfiguredRunLifecycle, evaluateConfiguredTask } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, openSqliteAttemptStore, readMonitorRunResults } from '#adapters/index.js';
import { clearConfigCache, loadConfig, prepareProductDirectory } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(exitCode: number, acceptedExitCodes = [0], stdout = 'private output', twoTasks = false, unbound = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-configured-evaluation-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const configPath = join(project, '.deckent/config.json'); const registry = fixtureDockerRegistry(['purchase']);
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry } }));
  const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } }; const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const os = userInfo(); const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  const policy = async (evaluate: boolean, readOutput: boolean | readonly string[] = true, inspect: boolean | 'require-approval' = true) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: evaluate ? 'allow' : 'deny', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: inspect === true ? ['create', 'inspect'] : ['create'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    ...(inspect === 'require-approval' ? [{ id: 'inspect-approval', effect: 'require-approval', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } }] : []),
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    ...(evaluate ? [{ id: 'evaluation', effect: 'allow', actions: readOutput === true ? ['evaluate', 'read-output'] : ['evaluate'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: twoTasks ? ['a', 'a2'] : ['a'] } }] : []),
    ...(Array.isArray(readOutput) ? [{ id: 'selected-output', effect: 'allow', actions: ['read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: readOutput } }] : []),
  ] }), { mode: 0o600 });
  await policy(true);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'purchase', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept configured process exits', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes } }] };
  if (twoTasks) graph.tasks.push({ id: 't2', kind: 'purchase', dependencies: [], acceptanceCriteria: ['exit'] });
  if (unbound) graph.tasks.push({ id: 'unbound', kind: 'purchase', dependencies: [], acceptanceCriteria: ['exit'] });
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
  expect((await store.loadRun('s', 'r'))!.progress[0]!.eligibility).toEqual({ kind: 'immediate' });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
  const request = { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['private-task-command'] }; const claim = { owner: 'fixture-worker', request };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const artifactRoot = await prepareProductDirectory(opened.layout, 'artifacts'); const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 65536 });
  const envelope = { schemaVersion: 1, identity, completeness: 'complete', stdout, stderr: '' };
  const receipt = await artifacts.put('s', Buffer.from(JSON.stringify(envelope))); await store.retainDispatchOutput(claim, receipt);
  await store.finishDispatch(claim, { handle: 'fixture-handle', exitCode, interrupted: false }); store.close();
  const command = { schemaVersion: 1 as const, commandId: 'evaluation', identity, expectedRevision: 2 };
  const snapshot = async () => {
    const current = await openConfiguredAttemptStore(project, options);
    try { return { run: await current.store.loadRun('s', 'r'), receipt: await current.store.loadRunReceipt('s', command.commandId) }; }
    finally { current.store.close(); }
  };
  return { project, data, configPath, options, path: opened.path, command, policy, snapshot };
}

describe.skipIf(process.platform === 'win32')('configured evaluation reply authority', () => {
  it.each(['a', 'a2'])('filters every receipt by producer authority with only %s allowed, through inspect/evaluate/monitor/replay/revoke', async allowed => {
    const f = await fixture(0, [0], 'private first task claim', true, true);
    const first = await evaluateConfiguredTask(f.project, f.command, f.options);
    const identity = { ...f.command.identity, taskId: 't2', attemptId: 'a2' };
    const store = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' },
      { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try {
      await store.reserveRunTasks({ commandId: 'reserve-second', actor: { id: 'fixture', issuer: 'test', subject: 'service' },
        scopeId: 's', runId: 'r', expectedRevision: first.evaluation.run.revision, now: 0, identities: [identity] });
      const claim = { owner: 'fixture-worker', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['private-task-command'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
      const artifacts = new FileArtifactStore({ root: join(f.data, 'artifacts'), maxBytes: 65536 });
      const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: 'private second task claim', stderr: '' })));
      await store.retainDispatchOutput(claim, output);
      await store.finishDispatch(claim, { handle: 'fixture-second', exitCode: 0, interrupted: false });
    } finally { store.close(); }
    const command = { ...f.command, identity, commandId: 'evaluation-second', expectedRevision: first.evaluation.run.revision + 2 };
    // The first evaluation now exercises a new write with mixed output authority; repeats exercise receipt replay.
    const receipts = [f.command.identity, identity].map((producer, index) => ({ producer,
      commit: (index ? 'b' : 'a').repeat(40), targetRef: `refs/heads/private-${index ? 'second' : 'first'}`,
      delivery: `delivery-${index ? 'second' : 'first'}`, adoption: `adoption-${index ? 'second' : 'first'}`, integration: `integration-${index ? 'second' : 'first'}` }));
    const writer = new DatabaseSync(f.path);
    try {
      for (const value of receipts) {
        writer.prepare('INSERT INTO workspace_integrations(scope_id,command_id,intent,manifest) VALUES(?,?,?,?)').run('s', value.integration,
          JSON.stringify({ command: { identity: value.producer } }), 'retained-manifest');
        writer.prepare('INSERT INTO workspace_deliveries(scope_id,command_id,intent,delivered) VALUES(?,?,?,?)').run('s', value.delivery,
          JSON.stringify({ command: { identity: value.producer }, plan: { commit: value.commit, ref: value.targetRef } }), 1);
        writer.prepare('INSERT INTO workspace_adoptions(scope_id,command_id,repository,target_ref,sequence,kind,intent,settled) VALUES(?,?,\'pre-v58\',?,?,?,?,?)').run('s', value.adoption, value.targetRef, 1, 'adopt',
          JSON.stringify({ command: { identity: value.producer }, targetRef: value.targetRef, toCommit: value.commit }), 1);
      }
      writer.prepare('INSERT INTO workspace_deliveries(scope_id,command_id,intent,delivered) VALUES(?,?,?,?)').run('s', 'unattributed-secret',
        JSON.stringify({ command: { identity: { scopeId: 's', runId: 'r' } }, plan: { commit: 'f'.repeat(40), ref: 'refs/heads/unattributed-secret' } }), 1);
    } finally { writer.close(); }
    const setPolicy = async (ids: readonly string[] | boolean) => {
      await f.policy(true, ids);
      const path = join(f.data, 'policy.json'), document = JSON.parse(await readFile(path, 'utf8'));
      document.grants.push({ id: 'monitor-scope', effect: 'allow', actions: ['inspect'], scopes: ['s'],
        principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'scope', ids: ['s'] } });
      await writeFile(path, JSON.stringify(document), { mode: 0o600 });
    };
    const assertHidden = (value: unknown, denied: typeof receipts[number]) => {
      const json = JSON.stringify(value);
      for (const secret of [denied.commit, denied.targetRef, denied.delivery, denied.adoption, denied.integration,
        'unattributed-secret', 'f'.repeat(40)]) expect(json).not.toContain(secret);
    };
    await setPolicy([allowed]);
    const visible = receipts.find(value => value.producer.attemptId === allowed)!, hidden = receipts.find(value => value !== visible)!;
    const runtime = createConfiguredRuntimeOperations(f.project, f.options);
    const result = await evaluateTask(f.project, command, f.options);
    const before = await f.snapshot();
    for (const value of [result, await evaluateTask(f.project, command, f.options), await runtime.evaluateTask(command),
      await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options), await inspectMonitor(f.project, f.options)]) {
      assertHidden(value, hidden);
      expect(JSON.stringify(value)).toContain(visible.adoption);
      expect(JSON.stringify(value)).toContain(visible.delivery);
      expect(JSON.stringify(value)).toContain(visible.integration);
    }
    expect(result.evaluation.run.tasks.find(task => task.id === 'unbound')!.resultBrief).toMatchObject({ runDelivery: null });
    expect(result.evaluation.run.tasks.find(task => task.id === 'unbound')!.resultBrief).not.toHaveProperty('deliveryOutlook');
    expect(result.evaluation.run.tasks.find(task => task.id === hidden.producer.taskId)).not.toHaveProperty('resultBrief');
    // Revocation must filter an already produced result and its delivery summary, without rewriting the receipt.
    await setPolicy(false);
    for (const value of [await evaluateTask(f.project, command, f.options), await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options),
      await inspectMonitor(f.project, f.options)]) { assertHidden(value, hidden); assertHidden(value, visible); }
    expect(await f.snapshot()).toEqual(before);
    // Replay of an earlier Run snapshot must not acquire a later producer's delivery.
    await setPolicy(true);
    const earlier = await evaluateTask(f.project, f.command, f.options);
    for (const value of receipts) assertHidden(earlier, value);
    expect(earlier.evaluation.run.revision).toBe(first.evaluation.run.revision);
  });
  it('all surfaces require inspection before the first write and after revocation, with unchanged durable state', async () => {
    const f = await fixture(0, [0], 'private first task claim', true);
    const runtime = createConfiguredRuntimeOperations(f.project, f.options);
    const server = createMcpServer(runtime, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'evaluation-authority', version: '1' });
    const calls = [() => evaluateTask(f.project, f.command, f.options), () => runtime.evaluateTask(f.command),
      async () => {
        let stdout = '', stderr = '';
        const exit = await main(['task', 'evaluate', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a',
          '--generation', '1', '--layout-revision', f.command.identity.layoutRevision, '--command-id', f.command.commandId,
          '--expected-revision', String(f.command.expectedRevision), '--json'],
        { stdout: { write(value: string) { stdout += value; } }, stderr: { write(value: string) { stderr += value; } },
          evaluateTask: (_root, command) => evaluateTask(f.project, command, f.options) });
        if (exit !== 0) { expect(stdout).toBe(''); expect(stderr).toContain('POLICY_DENIED'); throw { code: 'POLICY_DENIED' }; }
        return JSON.parse(stdout);
      }, async () => {
        const response = await client.callTool({ name: 'evaluate_task', arguments: f.command });
        if (response.isError) { expect(JSON.stringify(response)).toContain('POLICY_DENIED');
          expect(response.structuredContent).toBeUndefined(); expect(JSON.stringify(response)).not.toContain('private first task claim');
          throw { code: 'POLICY_DENIED' }; }
        return response.structuredContent;
      }];
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const before = await f.snapshot();
      await f.policy(true, true, false); // Evaluate is granted; deny the same command solely at Run inspection.
      for (const call of calls) { await expect(call()).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(await f.snapshot()).toEqual(before); }
      await f.policy(true);
      const accepted = await calls[0]!();
      for (const call of calls) expect(expectRecordedEvaluation(await call() as Awaited<ReturnType<typeof evaluateTask>>)).toEqual(expectRecordedEvaluation(accepted));
      const after = await f.snapshot();
      expect(after.receipt).not.toBeNull(); expect(after.run!.progress[0]!.phase).toBe('accepted');
      await f.policy(true, true, false);
      for (const call of calls) { await expect(call()).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(await f.snapshot()).toEqual(after); }
    } finally { await client.close(); await server.close(); }
  });
  it('omits a nonempty delivery receipt and outlook when output authority is revoked, including the preprojected brief', async () => {
    const f = await fixture(0), accepted = await evaluateConfiguredTask(f.project, f.command, f.options);
    const delivery = { state: 'delivered', commit: 'c'.repeat(40), commandId: 'private-delivery', targetRef: 'refs/heads/private-target' };
    const writer = new DatabaseSync(f.path);
    try { writer.prepare('INSERT INTO workspace_deliveries(scope_id,command_id,intent,delivered) VALUES(?,?,?,?)').run('s', delivery.commandId,
      JSON.stringify({ schemaVersion: 1, command: { identity: f.command.identity }, plan: { commit: delivery.commit, ref: delivery.targetRef } }), 1); }
    finally { writer.close(); }
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options);
    expect(inspected.run!.tasks[0]!.resultBrief).toMatchObject({ runDelivery: { ...delivery, receipts: [delivery] } });
    const before = await f.snapshot();
    await f.policy(true, false);
    const hidden = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options);
    const replay = await evaluateConfiguredTask(f.project, f.command, f.options);
    for (const view of [hidden.run!, replay.evaluation.run]) {
      expect(view.tasks[0]).not.toHaveProperty('resultBrief');
      expect(JSON.stringify(view)).not.toContain(delivery.commandId); expect(JSON.stringify(view)).not.toContain(delivery.targetRef);
    }
    expect(replay.evaluation.run.revision).toBe(accepted.evaluation.run.revision);
    expect(await f.snapshot()).toEqual(before);
  });
});
describe.skipIf(process.platform === 'win32')('configured task evaluation', () => {
  it('returns both Tasks exactly as inspection including resultBrief, and replays the earlier revision', async () => {
    const report = (summary: string) => ({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported',
      report: { schemaVersion: 1, summary, changedFiles: [], checks: [], openIssues: [] } });
    const f = await fixture(0, [0], JSON.stringify(report('private first task claim')), true);
    const first = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(first.evaluation.run.tasks).toEqual((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks);
    const identity = { ...f.command.identity, taskId: 't2', attemptId: 'a2' };
    const opened = await openConfiguredAttemptStore(f.project, f.options); opened.store.close();
    const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' },
      { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try {
      await store.reserveRunTasks({ commandId: 'reserve-second', actor: { id: 'fixture', issuer: 'test', subject: 'service' },
        scopeId: 's', runId: 'r', expectedRevision: first.evaluation.run.revision, now: 0, identities: [identity] });
      const claim = { owner: 'fixture-worker', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['private-task-command'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
      const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
      const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: JSON.stringify(report('private second task claim')), stderr: '' })));
      await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: 'fixture-second', exitCode: 0, interrupted: false });
    } finally { store.close(); }
    const secondCommand = { ...f.command, commandId: 'evaluation-second', identity, expectedRevision: first.evaluation.run.revision + 2 };
    const second = await evaluateConfiguredTask(f.project, secondCommand, f.options);
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options);
    expect(second.evaluation.run.tasks).toEqual(inspected.run!.tasks);
    const { pool, costReport, ...inspectedRun } = inspected.run!; void pool;
    expect(expectRecordedEvaluation(second).evaluation.run).toEqual(inspectedRun);
    expect(second.evaluation.run.tasks.map(task => task.resultBrief)).toEqual(['a', 'a2'].map((attemptId, index) => ({
      schemaVersion: 1, attemptId, claimLabel: 'CLAIM', report: report(index ? 'private second task claim' : 'private first task claim'),
      evaluation: { verdict: 'accepted' }, openIssues: [], runDelivery: null, deliveryOutlook: 'none',
    })));
    expect(second.evaluation.run.tasks.map(task => task.acceptance!.evaluationId)).toEqual(['evaluation', 'evaluation-second']);
    expect(costReport).toMatchObject({ runRevision: second.evaluation.run.revision, withheld: 0,
      attempts: [{ identity: f.command.identity, acceptance: second.evaluation.run.tasks[0]!.acceptance },
        { identity, acceptance: second.evaluation.run.tasks[1]!.acceptance }],
      summary: { acceptedTasks: 2, measuredApiUsdNanos: null, measuredCpuSeconds: null } });
    expect(expectRecordedEvaluation(await evaluateConfiguredTask(f.project, secondCommand, f.options))).toEqual(expectRecordedEvaluation(second));
    expect(expectRecordedEvaluation(await evaluateConfiguredTask(f.project, f.command, f.options))).toEqual(expectRecordedEvaluation(first));
    expect(first.evaluation.run.tasks[1]!.acceptance!.evaluationId).toBeNull();
    await f.policy(true, ['a2']);
    const restricted = await evaluateConfiguredTask(f.project, secondCommand, f.options);
    const restrictedInspect = (await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!;
    expect(restricted.evaluation.run.tasks).toEqual(restrictedInspect.tasks);
    expectRecordedEvaluation(restricted);
    expect(restricted.evaluation.run.tasks[0]).not.toHaveProperty('resultBrief');
    expect(restrictedInspect.costReport).toMatchObject({ withheld: 1, attempts: [{ identity }],
      summary: { acceptedTasks: 1, measuredApiUsdNanos: null, measuredCpuSeconds: null, sampledCpuSecondsPerAcceptedTask: null } });
    expect(restricted.evaluation.run.tasks[1]!.resultBrief!.report).toEqual(report('private second task claim'));
    expect(restricted.evaluation.run.tasks[1]!.resultBrief).not.toHaveProperty('deliveryOutlook');
    expect(JSON.stringify(restricted)).not.toContain('private first task claim');
    await f.policy(true, true, false);
    await expect(evaluateConfiguredTask(f.project, secondCommand, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.policy(true, ['a']);
    const hidden = await evaluateConfiguredTask(f.project, secondCommand, f.options);
    expect(hidden.evaluation.run.tasks[1]).not.toHaveProperty('resultBrief');
    expect(JSON.stringify(hidden)).not.toContain('private second task claim');
    const runtime = createConfiguredRuntimeOperations(f.project, f.options);
    expect(expectRecordedEvaluation(await runtime.evaluateTask(secondCommand))).toEqual(expectRecordedEvaluation(hidden));
    expect(expectRecordedEvaluation(await evaluateTask(f.project, secondCommand, f.options))).toEqual(expectRecordedEvaluation(hidden));
    let cliText = '';
    expect(await main(['task', 'evaluate', '--scope', 's', '--run', 'r', '--task', 't2', '--attempt', 'a2',
      '--generation', '1', '--layout-revision', identity.layoutRevision, '--command-id', secondCommand.commandId,
      '--expected-revision', String(secondCommand.expectedRevision), '--json'],
    { stdout: { write(value: string) { cliText += value; } }, evaluateTask: (_root, command) => evaluateTask(f.project, command, f.options) })).toBe(0);
    expect(expectRecordedEvaluation(JSON.parse(cliText))).toEqual(expectRecordedEvaluation(hidden));
    const server = createMcpServer(runtime, { maxConcurrentCalls: 2, responseMaxBytes: 65536 }, 'en');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'evaluation-security', version: '1' });
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const response = await client.callTool({ name: 'evaluate_task', arguments: secondCommand });
      expect(response.isError).not.toBe(true); expect(expectRecordedEvaluation(response.structuredContent as typeof hidden)).toEqual(expectRecordedEvaluation(hidden));
      expect(JSON.stringify(response)).not.toContain('private second task claim');
      await f.policy(true, true, false);
      const denied = await client.callTool({ name: 'evaluate_task', arguments: secondCommand });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain('POLICY_DENIED');
      expect(JSON.stringify(denied)).not.toContain('private second task claim');
      await expect(runtime.evaluateTask(secondCommand)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(evaluateTask(f.project, secondCommand, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      cliText = ''; let errorText = '';
      expect(await main(['task', 'evaluate', '--scope', 's', '--run', 'r', '--task', 't2', '--attempt', 'a2',
        '--generation', '1', '--layout-revision', identity.layoutRevision, '--command-id', secondCommand.commandId,
        '--expected-revision', String(secondCommand.expectedRevision), '--json'],
      { stdout: { write(value: string) { cliText += value; } }, stderr: { write(value: string) { errorText += value; } },
        evaluateTask: (_root, command) => evaluateTask(f.project, command, f.options) })).not.toBe(0);
      expect(cliText).toBe(''); expect(errorText).toContain('POLICY_DENIED');
    } finally { await client.close(); await server.close(); }

  });
  it.each([[0, 'accepted', [0]], [7, 'failed', [0]], [7, 'accepted', [7]]] as const)(
    'derives exit %s from the pinned evaluator and projects %s for accepted codes %j', async (exitCode, phase, acceptedExitCodes) => {
    const f = await fixture(exitCode, [...acceptedExitCodes]); const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.admission = null;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const result = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(result.evaluation.run.tasks[0]!.phase).toBe(phase);
    expect(result.evaluation.run.registryRevision).toBe('fixture-docker-registry');
    expect(JSON.stringify(result)).not.toContain('private-task-command'); expect(JSON.stringify(result)).not.toContain('parameters');
    expect(JSON.stringify(result)).not.toContain('/private/workspace');
  });

});
describe.skipIf(process.platform === 'win32')('configured task evaluation', () => {
  it('checks current evaluate policy before mutation and replay while ignoring changed admission registry', async () => {
    const f = await fixture(0); const beforeStore = await openSqliteAttemptStore(f.path,
      { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    const before = await beforeStore.loadRun('s', 'r'); beforeStore.close();
    await f.policy(false); await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const deniedStore = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    expect(await deniedStore.loadRun('s', 'r')).toEqual(before); deniedStore.close();
    await f.policy(true); const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    config.admission.registry.revision = 'current-registry-changed'; config.admission.registry.evaluators[0].implementation.version = 99;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const first = await evaluateConfiguredTask(f.project, f.command, f.options); expect(first.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(expectRecordedEvaluation(await evaluateConfiguredTask(f.project, f.command, f.options))).toEqual(expectRecordedEvaluation(first));
    await f.policy(false); await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it.each([false, 'require-approval'] as const)('requires Run inspect %s before mutation and replay, preserving durable state', async inspect => {
    const f = await fixture(0, [0], 'Private worker claim', true);
    const snapshot = async () => { const store = await openConfiguredAttemptStore(f.project, f.options);
      try { return { run: await store.store.loadRun('s', 'r'), receipt: await store.store.loadRunReceipt('s', f.command.commandId) }; }
      finally { store.store.close(); } };
    const before = await snapshot();
    // Explicit evaluate/read-output grant; only Run inspection is withheld. Keep the same command on denial.
    await f.policy(true, true, inspect);
    const rejection = { code: inspect === false ? 'POLICY_DENIED' : 'POLICY_APPROVAL_UNSUPPORTED' };
    await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject(rejection);
    expect(await snapshot()).toEqual(before);
    await f.policy(true);
    const first = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(first.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(expectRecordedEvaluation(await evaluateConfiguredTask(f.project, f.command, f.options))).toEqual(expectRecordedEvaluation(first));
    const accepted = await snapshot();
    await f.policy(true, true, inspect);
    await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject(rejection);
    expect(await snapshot()).toEqual(accepted);
    await f.policy(false);
    await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await snapshot()).toEqual(accepted);
    await f.policy(true, false);
    const replay = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(replay.evaluation.run.tasks[0]).not.toHaveProperty('resultBrief');
    const opened = await openConfiguredAttemptStore(f.project, f.options);
    const retained = (await opened.store.loadRun('s', 'r'))!; opened.store.close();
    const config = await loadConfig(f.project, { ...f.options, heal: false });
    const briefs = await readMonitorRunResults(config, f.options.env, { scopeId: 's', runId: 'r' }, replay.evaluation.run, async () => false, retained);
    expect(briefs.has('t')).toBe(false);
    expect(JSON.stringify(replay)).not.toContain('Private worker claim');
    expect(replay.evaluation.run.tasks).toEqual((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks);
  });
  it('refuses a foreign retained scope and ignores a future snapshot before any output read', async () => {
    const f = await fixture(0), result = await evaluateConfiguredTask(f.project, f.command, f.options);
    const opened = await openConfiguredAttemptStore(f.project, f.options);
    const snapshot = (await opened.store.loadRun('s', 'r'))!; opened.store.close();
    const config = await loadConfig(f.project, { ...f.options, heal: false });
    const readOutput = async () => { throw new Error('output read before snapshot validation'); };
    await expect(readMonitorRunResults(config, f.options.env, { scopeId: 'foreign', runId: 'r' }, result.evaluation.run, readOutput, snapshot))
      .rejects.toMatchObject({ code: 'ATTEMPT_STORE_OPTIONS' });
    expect(await readMonitorRunResults(config, f.options.env, { scopeId: 's', runId: 'r' },
      { revision: snapshot.revision + 1, layoutRevision: snapshot.identity.layoutRevision }, readOutput, { ...snapshot, revision: snapshot.revision + 1 })).toEqual(new Map());
  });
});


it.skipIf(process.platform === 'win32')('requires POSIX managed storage: shows a sealed final report through configured custody while task acceptance still rejects a failed process', async () => {
  const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1,
    summary: 'All done according to the worker', changedFiles: ['note.txt'], checks: [{ command: 'npm test', outcome: 'passed' }], openIssues: [] } };
  const f = await fixture(7, [0], JSON.stringify(report) + '\n');
  const transcript = await inspectConfiguredWorkerTranscript(f.project, f.command.identity, f.options);
  expect(transcript).toMatchObject({ schemaVersion: 2, finalReport: report });
  const result = await evaluateConfiguredTask(f.project, f.command, f.options);
  expect(result.evaluation.run.tasks[0]!.phase).toBe('failed');
  expect(result.evaluation.run.tasks[0]!.resultBrief).toMatchObject({ report, evaluation: { verdict: 'rejected' } });
  expect(result.evaluation.run.tasks).toEqual((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks);
  await f.policy(false);
  await expect(inspectConfiguredWorkerTranscript(f.project, f.command.identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it.skipIf(process.platform === 'win32')('maintenance with no due deadline never opens a writer under another ledger write lock', async () => {
  const f = await fixture(0);
  await evaluateConfiguredTask(f.project, f.command, f.options);
  const writer = new DatabaseSync(f.path); writer.exec('BEGIN IMMEDIATE');
  try { expect(await advanceConfiguredRunLifecycle(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).toBeNull(); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
});
