import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorklineLedgerPorts } from '#surfaces/core/cli/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { inspectConfiguredRun } from '#composition/core/runs/index.js';
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { followLedgerSurface, inspectSurfaceAccess, inspectSurfaceRunIds } from '#composition/core/monitor/index.js';
import { FileArtifactStore, openLocalIntegrityAuthority, openSqliteApprovalStore, openSqliteAttemptStore, startWorkerObservation, openWorkerEventSink } from '#adapters/index.js';
import { requestTaskApproval, type WorkerActivity } from '#engine/index.js';
import { prepareProductDirectory, productResourcePath } from '#platform/index.js';
import { fixtureExecution } from './execution-registry.js';
import { custodyProfiles, dispatchAdmission } from './custody.js';

const sqlite = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'snapshot-task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };

/** Real ledger records and real read composition. No runtime service, worker process, Docker or Git. */
export async function surfaceSnapshotFixture(initialWorker = true) {
  const root = await mkdtemp(join(tmpdir(), 'b36-snapshot-')), folder = join(root, 'project');
  await mkdir(join(folder, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } };
  await writeFile(join(folder, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { heartbeatMs: 100 } } }));
  const opened = await openConfiguredAttemptStore(folder, options); opened.store.close();
  const policy = productResourcePath(opened.layout, 'policy');
  const principal = { issuer: hostname(), subject: String(userInfo().uid) };
  const grants = [
    { id: 'scope', actions: ['inspect'], resource: { kind: 'scope', ids: ['s'] } },
    { id: 'run', actions: ['inspect'], resource: { kind: 'run', ids: 'all' } },
    { id: 'output', actions: ['read-output'], resource: { kind: 'attempt', ids: 'all' } },
    { id: 'approval', actions: ['inspect'], resource: { kind: 'approval', ids: ['s'] } },
  ];
  const setGrants = async (ids = grants.map(grant => grant.id), foreign = false) => writeFile(policy, JSON.stringify({ schemaVersion: 1, revision: 'unchanged', restrictions: [],
    grants: grants.filter(grant => ids.includes(grant.id)).map(grant => ({ ...grant, effect: 'allow', scopes: ['s'], principals: [foreign ? { issuer: 'foreign', subject: 'foreign' } : principal] })) }), { mode: 0o600 });
  await setGrants();
  const store = await openSqliteAttemptStore(opened.path, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const identity = { scopeId: 's', runId: 'snapshot-run', taskId: 'snapshot-task', attemptId: 'snapshot-attempt', generation: 1, layoutRevision: opened.layout.revision };
  const claimWorker = async () => {
    const journal = await openSqliteAttemptStore(opened.path, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try {
      await journal.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: identity.runId, expectedRevision: 0, now: Date.now(), identities: [identity] });
      await journal.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: join(root, 'worker/workspace'), argv: ['x'] } }));
    } finally { journal.close(); }
  };
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } });
    for (const [scopeId, runId] of [['s', 'snapshot-run'], ['s', 'never-dispatched-run'], ['other', 'foreign-run']] as const) {
      await store.createRun({ commandId: `create-${runId}`, actor, identity: { scopeId, runId, layoutRevision: opened.layout.revision }, graph, execution: fixtureExecution(graph), now: Date.now(),
        policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['snapshot-task'] } });
    }
    await mkdir(join(root, 'worker/workspace'), { recursive: true, mode: 0o700 });
  } finally { store.close(); }
  if (initialWorker) await claimWorker();
  const integrity = await openLocalIntegrityAuthority(opened.layout, 'authority.key', true);
  const addApproval = (taskId: string, scopeId = 's') => {
    const journal = openSqliteApprovalStore(opened.path, sqlite), now = Date.now();
    try { return requestTaskApproval(journal.store, integrity, { scopeId, runId: identity.runId, taskId,
      requester: { id: 'owner', ...principal }, actionDigest: 'a'.repeat(64), policyRevision: 'unchanged', summary: taskId, createdAt: now, expiresAt: now + 600000 }); }
    finally { journal.close(); }
  };
  const approval = addApproval('pending-at-open'); addApproval('foreign-approval', 'other');
  const follow = (signal: AbortSignal) => followLedgerSurface(folder, 's', options, signal);
  const ports = createWorklineLedgerPorts({ root: folder, scopeId: 's', options, workerHeartbeatMs: 100, inspectWorkers: inspectConfiguredWorkers, inspectRun: inspectConfiguredRun,
    inspectSurfaceAccess: () => inspectSurfaceAccess(folder, 's', options), inspectSurfaceRunIds: () => inspectSurfaceRunIds(folder, 's', options),
    listApprovals: input => configuredApproval(folder, 'list', input, options), decideApproval: async () => { throw new Error('observation only'); }, followEvents: follow })!;
  // Advance the durable revision and its snapshot atomically, like multiple commits between tail reads; no fabricated stream sequence.
  const advanceRun = (revision: number) => {
    const db = new DatabaseSync(opened.path);
    try { db.prepare("UPDATE runs SET revision=?,snapshot=json_set(snapshot,'$.revision',?) WHERE scope_id=? AND run_id=?").run(revision, revision, 's', identity.runId); }
    finally { db.close(); }
  };
  const publishWorker = async (attemptId = identity.attemptId) => {
    const events = [
      { schemaVersion: 1, sequence: 1, atMs: 1, kind: 'session.started', provider: 'codex', model: null, cliVersion: null },
      { schemaVersion: 1, sequence: 2, atMs: 2, kind: 'usage', tokens: { input: 123, output: 123, cacheRead: 0, cacheWrite: 0, thinking: null } },
    ];
    await writeFile(join(root, 'worker/worker.events'), events.map(event => JSON.stringify({ receivedAt: Date.now(), event })).join('\n') + '\n', { mode: 0o600 });
    // Only finished attempts publish a sealed log. Live workers below use the production sidecar writers.
    await writeFile(join(root, 'worker/worker.hb'), JSON.stringify({ identity, provider: 'codex', process: 'exited' }), { mode: 0o600 });
    const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 1048576 });
    const journal = await openSqliteAttemptStore(opened.path, sqlite, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try { await journal.saveWorkerEventLog({ schemaVersion: 1, identity: { ...identity, attemptId }, events: await artifacts.put('s', Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')),
      eventCount: events.length, sealedAt: Date.now() }); } finally { journal.close(); }
  };
  let close = async () => {};
  const startLiveWorker = async (beforeHeartbeat?: () => Promise<void>) => {
    // Production reserves and claims before starting its sidecar writer. The hook exposes that startup race.
    if (!initialWorker) await claimWorker();
    await beforeHeartbeat?.();
    let process: WorkerActivity['process'] = 'running', sequence = 1;
    const sink = await openWorkerEventSink(join(root, 'worker'));
    sink.accept([{ schemaVersion: 1, sequence, atMs: 1, kind: 'session.started', provider: 'codex', model: null, cliVersion: null }]);
    const observation = await startWorkerObservation(join(root, 'worker'), 100, 1048576, async () => ({ schemaVersion: 1, identity, backend: 'docker',
      provider: 'codex', workspace: join(root, 'worker/workspace'), observedAt: Date.now(), process, handle: null, terminal: null, outputRecorded: false }));
    let closed = false;
    close = async () => { if (closed) return; closed = true; await observation.close(); await sink.close(); };
    return {
      usage(tokens: number) { sink.accept([{ schemaVersion: 1, sequence: ++sequence, atMs: sequence, kind: 'usage',
        tokens: { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0, thinking: null } }]); },
      async finish() {
        sink.accept([{ schemaVersion: 1, sequence: ++sequence, atMs: sequence, kind: 'session.ended', outcome: 'success', turns: 1,
          durationMs: 1, apiDurationMs: null, costUsd: null, costBasis: null, tokens: null, permissionDenials: 0 }]);
        process = 'exited'; await close();
      },
    };
  };
  return { root, folder, options, ledger: opened.path, identity, ports, follow, approval, setGrants, addApproval, advanceRun, publishWorker, startLiveWorker, close: () => close() };
}
