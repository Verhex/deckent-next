import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { DispatchApplication, requestTaskApproval, type ExecutionSupervisor } from '#engine/index.js';
import { openSqliteAttemptStore, openSqliteApprovalStore } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { createHmacIntegrity } from '../../src/platform/core/integrity/index.js';
import { SQLITE_STORAGE_OPTIONS } from '../../src/platform/core/config-fields/index.js';
import { followLedgerSurface } from '../../src/composition/core/monitor/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../src/composition/core/storage/index.js';
import { ensureConfiguredTerminalIdentity } from '#composition/core/scoped-request/index.js';
import { acceptSurfaceEvent, openSurfacePush, releaseSurfacePush, type SurfacePushEvent } from '#surfaces/core/terminal-kit/index.js';
import { fixtureDockerRegistry } from '../contracts/support/execution-registry.js';
import { custodyOrDockerProfiles, custodyProfile } from '../contracts/support/custody.js';
import { latencySample, readLatencyClock, type LatencySample } from '../contracts/support/latency-metrics.js';

const SCOPE = 's';
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const now = () => performance.now();

/** Isolated temp project and ledger with the real policy/identity path. Product defaults are kept (follow heartbeat 2000 ms); no Docker, provider or live install. */
export async function latencyProject() {
  const root = await mkdtemp(join(tmpdir(), 'dk-perf-lat-'));
  const folder = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(folder, '.deckent'), { recursive: true });
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') };
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(folder, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: {
    poolId: 'p', executionSlots: 1000, inFlightSlots: 1000, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']) } }));
  const opened = await openConfiguredAttemptStore(folder, { env });
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1000, inFlightSlots: 1000 } });
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: [SCOPE], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: [SCOPE], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'output', effect: 'allow', actions: ['read-output'], scopes: [SCOPE], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'approval', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals, resource: { kind: 'approval', ids: [SCOPE] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals, resource: { kind: 'scope', ids: [SCOPE] } },
  ] }), { mode: 0o600 });
  const ledger = opened.path;
  opened.store.close();
  await ensureConfiguredTerminalIdentity(folder, SCOPE, { env });
  return { root, folder, env, ledger, async dispose() { clearConfigCache(); await rm(root, { recursive: true, force: true }); } };
}
type Project = Awaited<ReturnType<typeof latencyProject>>;
export type Workload = Readonly<{ warmup: number; samples: number; consumerDelayMs?: number }>;

const createRun = (f: Project, n: string) => createConfiguredRun(f.folder, { schemaVersion: 1, commandId: `c-${n}`, scopeId: SCOPE, runId: `r-${n}`, graph }, { env: f.env });

/** Open the production ledger follow (policy-authorized, same code the terminal uses) and wait for its start control and ready notification. */
async function openFollow(f: Project) {
  const controller = new AbortController();
  let ready!: () => void;
  const opened = new Promise<void>(resolve => { ready = resolve; });
  const iterator = followLedgerSurface(f.folder, SCOPE, { env: f.env }, controller.signal, ready)[Symbol.asyncIterator]();
  const start = await iterator.next();
  if ((start.value as { control?: string }).control !== 'start') throw new Error('LATENCY_FOLLOW_NOT_STARTED');
  await opened;
  return { iterator, async close() { controller.abort(); await iterator.return?.(); } };
}

/** Timed window: producer call -> the surface reducer (`acceptSurfaceEvent`) applied the matching event. A consumer delay is the deliberate slowdown used by the negative proof. */
async function followSamples(f: Project, w: Workload, kind: 'run' | 'approval', produce: (n: string) => Promise<unknown>, idOf: (n: string) => string) {
  const follow = await openFollow(f);
  const samples: LatencySample[] = [];
  let state = openSurfacePush();
  try {
    for (let i = 1; i <= w.warmup + w.samples; i++) {
      const n = `${kind}-${i}`;
      const start = readLatencyClock(now);
      await produce(n);
      const expected = idOf(n);
      let event: SurfacePushEvent | undefined;
      while (!event) {
        const next = await follow.iterator.next();
        if (next.done) throw new Error('LATENCY_FOLLOW_ENDED');
        const value = next.value as SurfacePushEvent;
        if (value.kind === kind && value.id === expected) event = value;
      }
      if (w.consumerDelayMs) await sleep(w.consumerDelayMs);
      const step = acceptSurfaceEvent(state, event, SCOPE, 5);
      if (step.status !== 'applied') throw new Error(`LATENCY_SURFACE_${step.status}`);
      state = releaseSurfacePush(step.state);
      const sample = latencySample(start, readLatencyClock(now));
      if (i > w.warmup) samples.push(sample);
    }
  } finally { await follow.close(); }
  return samples;
}

/** (a) Real Run creation commits a ledger row -> production follow -> terminal surface reducer. */
export const measureLedgerRunEvent = (f: Project, w: Workload) => followSamples(f, w, 'run', n => createRun(f, n), n => `r-${n}`);

/** (c) Real approval producer (requestTaskApproval -> approval_outbox) -> follow announcement -> surface reducer. */
export async function measureApprovalAnnounce(f: Project, w: Workload) {
  const journal = openSqliteApprovalStore(f.ledger, SQLITE_STORAGE_OPTIONS.parse({ busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }), 'allow');
  const integrity = createHmacIntegrity('key', randomBytes(32));
  const requester = { id: 'perf-requester', issuer: hostname(), subject: String(userInfo().uid) };
  const created = new Map<string, string>();
  try {
    return await followSamples(f, w, 'approval', async n => {
      const record = requestTaskApproval(journal.store, integrity, { scopeId: SCOPE, runId: `run-${n}`, taskId: 'task', requester,
        actionDigest: randomBytes(32).toString('hex'), policyRevision: 'allow', summary: 'Perf approval', createdAt: Date.now(), expiresAt: Date.now() + 600_000 });
      created.set(n, record.request.approvalId);
    }, n => created.get(n) ?? ''); // approvalId is random: resolved after the producer returns, then matched by id
  } finally { journal.close(); }
}

/** (b) Run creation + task reservation through the real application, then the real DispatchApplication claims and grants the launch;
 * the timed window ends when the (fake) supervisor port receives `execute`, i.e. the instant a real worker launch would be requested. No Docker. */
export async function measureRunCreateToWorkerStart(f: Project, w: Workload) {
  const store = await openSqliteAttemptStore(f.ledger, SQLITE_STORAGE_OPTIONS.parse({ busyTimeoutMs: 2000, journalMode: 'wal', durability: 'full' }), { now: Date.now, timeoutMs: 86_400_000 }, 'allow', custodyOrDockerProfiles);
  const verifier = { async verify() { return { id: 'perf-launcher', issuer: 'test', subject: 'perf', assurance: 'os-user' as const, scopeIds: [SCOPE] }; } };
  const samples: LatencySample[] = [];
  try {
    for (let i = 1; i <= w.warmup + w.samples; i++) {
      let stamp: number | null = null;
      const supervisor: ExecutionSupervisor & { captureProfile(): Promise<typeof custodyProfile> } = {
        async captureProfile() { return custodyProfile; },
        async execute() { if (w.consumerDelayMs) await sleep(w.consumerDelayMs); stamp = readLatencyClock(now); throw new Error('perf fake worker: no process'); },
        async cancel() { throw new Error('unused'); }, async recoverOutput() { throw new Error('unused'); }, async observe() { throw new Error('unused'); }, async release() { throw new Error('unused'); },
      };
      const app = new DispatchApplication(store, supervisor, verifier, { async authorize() {} }, 'perf-owner', { async put() { throw new Error('unused'); } } as never);
      const start = readLatencyClock(now);
      await createRun(f, `w${i}`);
      const identity = (await reserveConfiguredRunTasks(f.folder, { schemaVersion: 1, scopeId: SCOPE, runId: `r-w${i}`, commandId: `reserve-${i}`, expectedRevision: 0 }, { env: f.env })).reservation.identities[0]!;
      await app.execute({ protocolVersion: 1, identity, workspace: f.root, argv: ['true'] }).then(() => undefined, () => undefined);
      const sample = latencySample(start, stamp);
      if (i > w.warmup) samples.push(sample);
    }
  } finally { store.close(); }
  return samples;
}
