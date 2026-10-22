import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateTask, prepareConfiguredWorkspacePatch } from '../../../src/index.js';
import { configuredTargetQueueTerminal } from '../../../src/composition/core/runtime-service/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor, GitIntegrationAdoption } from '#adapters/index.js';
import { adoptionFenceRef, adoptionFenceText, queueCommandIds, queueGenerationRef, targetQueueKey, TargetBatchExecutor, WorkspaceAdoptionApplication, type TargetQueueView } from '#engine/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, ErrorRegistry, productResourcePath } from '#platform/index.js';
import { exec, git, TARGET, SCOPE, graph, cliInPty, queueProject } from '../support/delivery-queue-fixture.js';
import type { Step } from '../support/pty-steps.js';
import { DOWNGRADE_TO_V57_LEDGER_SQL } from '../../fixtures/ledger-previous.js';
import { startTestRuntimeService, stopTestRuntimeService, stopTestRuntimeServices } from '../support/runtime-service.js';

// TESLIM-KUYRUGU phase 2 proof at the real boundary: a live project repository runs the installation; its registered work target is an
// independent clone whose base branch is the (unprotected) queue target. Four coding Runs execute in Docker from the same base H0 and each
// leaves an accepted Attempt with a stored patch. Three with disjoint paths are queued through the real runtime service; the service prepares
// C1 = H0 + P1, C2 = C1 + P2, C3 = C2 + P3 and admits a normal verification Run on each exact candidate, which this test executes and
// evaluates through the ordinary Run applications. The batch is then confirmed by the shipped CLI on its own controlling PTY (the product's
// terminal confirmation port: one publication card and one adoption card for the whole batch), after a first answer of n that writes
// nothing. A fourth Attempt whose path overlaps the adopted prefix ends as conflict-needs-reattempt with nothing written to the target.
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await stopTestRuntimeServices();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
/** The adoption card asks whether the branch moves (QUEUE-SMALL 5); the publication card keeps its reference-write question. */
const ADOPT_PROMPT = `Move ${TARGET} to the verified commit? y/N: `;
/** Each coding kind writes one file; `overlap` writes a.txt again, the path the first delivery added. `verify` reads every queued path it can. */
const WORKERS: Readonly<Record<string, string>> = {
  'write-a': "require('node:fs').writeFileSync('a.txt','first\\n')",
  'write-b': "require('node:fs').writeFileSync('b.txt','second\\n')",
  'write-c': "require('node:fs').writeFileSync('c.txt','third\\n')",
  overlap: "require('node:fs').writeFileSync('a.txt','overlapping\\n')",
  verify: "require('node:fs').accessSync('a.txt')",
};

/** Every reference, HEAD, index and config of a repository: equal digests mean nothing Deckent writes reached it. */
async function repositoryDigest(repository: string) {
  const refs = await git(repository, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)');
  const head = await git(repository, 'rev-parse', 'HEAD'), worktrees = await git(repository, 'worktree', 'list', '--porcelain');
  const files = await Promise.all(['index', 'config'].map(name => readFile(join(repository, '.git', name))));
  return createHash('sha256').update(JSON.stringify({ refs, head, worktrees })).update(files[0]!).update(files[1]!).digest('hex');
}

async function fixture() {
  const { root, project, target, data, base, options, layout } = await queueProject({ roots, prefix: 'dn-queue-e2e-', workers: WORKERS, revision: 'queue-e2e' });
  const runRevision = async (runId: string) => {
    const store = await openConfiguredAttemptStore(project, options);
    try { return (await store.store.loadRun(SCOPE, runId))?.revision ?? null; } finally { store.store.close(); }
  };
  /** The normal Run path: reserve, execute in Docker, evaluate. Returns the accepted Attempt identity. */
  const execute = async (runId: string) => {
    const identity = (await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: SCOPE, runId, commandId: `reserve-${runId}`, expectedRevision: 0 }, options)).reservation.identities[0]!;
    cleanup.push(async () => {
      const store = await openConfiguredAttemptStore(project, options);
      try { const record = await store.store.loadBoundDispatch(identity);
        if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); } }
      finally { store.store.close(); }
    });
    expect((await executeConfiguredTask(project, identity, options)).execution.terminal?.exitCode).toBe(0);
    return identity;
  };
  const evaluate = async (runId: string, identity: AttemptIdentity) => {
    const evaluated = await evaluateTask(project, { schemaVersion: 1, commandId: `evaluation-${runId}`, identity, expectedRevision: (await runRevision(runId))! }, options);
    expect(evaluated.evaluation.run.tasks[0]!.phase).toBe('accepted');
  };
  /** A coding Run on H0 whose accepted Attempt carries a prepared patch (the queue's admission input). */
  const coding = async (runId: string, kind: string) => {
    await createConfiguredRun(project, { schemaVersion: 1, scopeId: SCOPE, runId, commandId: `create-${runId}`, graph: graph(kind) }, options);
    const identity = await execute(runId);
    await prepareConfiguredWorkspacePatch(project, identity, options);
    await evaluate(runId, identity);
    return identity;
  };
  const ledger = productResourcePath(layout, 'ledger');
  return { root, project, target, data, base, options, ledger, coding, execute, evaluate, runRevision };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const actor = { id: `local-os:${userInfo().uid}`, issuer: 'local-os', subject: String(userInfo().uid) };
/** Writes an adoption fence blob (the shipped format) at TARGET's fence reference of `repository`. */
function writeFence(repository: string, fence: { sequence: number; scopeId: string; commandId: string }) {
  const blob = execFileSync('/usr/bin/git', ['-C', repository, 'hash-object', '-w', '--stdin'], { input: adoptionFenceText(TARGET, fence), encoding: 'utf8' }).trim();
  execFileSync('/usr/bin/git', ['-C', repository, 'update-ref', adoptionFenceRef(TARGET), blob]);
}
/** The live/N1 shape before the work target was switched: `n` settled adoptions of TARGET made in the project repository (the old
 * target), recorded in the ledger before repository identity existed (v58 stamps such rows `pre-v58`), and that repository's fence naming
 * the last one. `git clone` never copies refs/deckent/*, so the registered clone has no fence at all. */
function seedChain(f: Fixture, n: number) {
  const db = new DatabaseSync(f.ledger);
  try {
    const stamped = db.prepare("SELECT 1 AS present FROM pragma_table_info('workspace_adoptions') WHERE name='repository'").get() !== undefined;
    const insert = db.prepare(`INSERT INTO workspace_adoptions(scope_id,command_id,${stamped ? 'repository,' : ''}target_ref,sequence,kind,intent,settled) VALUES(?,?,${stamped ? "'pre-v58'," : ''}?,?,?,?,1)`);
    for (let sequence = 1; sequence <= n; sequence++) {
      const commandId = `legacy-${sequence}`, identity = { scopeId: SCOPE, runId: `legacy-${sequence}`, taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
      insert.run(SCOPE, commandId, TARGET, sequence, 'adopt', JSON.stringify({ schemaVersion: 2, kind: 'adopt',
        command: { schemaVersion: 2, commandId, identity, deliveryCommandId: `legacy-delivery-${sequence}`, targetRef: TARGET }, targetRef: TARGET,
        fromCommit: f.base, toCommit: f.base, deliveryRef: `refs/deckent/deliveries/${'c'.repeat(64)}`, basis: 'task-acceptance',
        acceptance: { runRevision: 1 }, verification: null, actor }));
    }
  } finally { db.close(); }
  writeFence(f.project, { sequence: n, scopeId: SCOPE, commandId: `legacy-${n}` });
}
const journal = (f: Fixture, commandId: string) => {
  const db = new DatabaseSync(f.ledger, { readOnly: true });
  try { return db.prepare('SELECT * FROM workspace_adoptions WHERE command_id=?').get(commandId) as Record<string, unknown> | undefined; } finally { db.close(); }
};
/** Rebinds a ticket the way a build before QUEUE-SMALL 2 recorded it (resourceBinding = sha256 of the common directory's path, st_dev and
 * inode) and rewrites the target's queue generation to that key, which is how N1's teslim-n1 ticket and generation ref look today. */
async function bindLegacy(f: Fixture, commandId: string) {
  const path = await realpath(join(f.target, '.git')), stat = await lstat(path);
  const resourceBinding = createHash('sha256').update(JSON.stringify({ path, device: stat.dev, inode: stat.ino })).digest('hex');
  const db = new DatabaseSync(f.ledger);
  try {
    const record = JSON.parse(String(db.prepare('SELECT record FROM target_queue WHERE command_id=?').get(commandId)!.record)) as { key: string; request: { target: Parameters<typeof targetQueueKey>[0] } };
    expect(record.request.target.resourceBinding).not.toBe(resourceBinding);
    record.request.target = { ...record.request.target, resourceBinding }; record.key = targetQueueKey(record.request.target);
    db.prepare('UPDATE target_queue SET record=?,target_key=? WHERE command_id=?').run(JSON.stringify(record), record.key, commandId);
    const ref = queueGenerationRef(TARGET), generation = JSON.parse(await git(f.target, 'cat-file', 'blob', ref)) as Record<string, unknown>;
    const blob = execFileSync('/usr/bin/git', ['-C', f.target, 'hash-object', '-w', '--stdin'], { input: JSON.stringify({ ...generation, key: record.key }) + '\n', encoding: 'utf8' }).trim();
    await git(f.target, 'update-ref', ref, blob);
  } finally { db.close(); }
}
/** Points the registered work target at another repository (the operator re-registers a clone). */
async function registerTarget(f: Fixture, path: string) {
  const file = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(file, 'utf8'));
  config.execution.workTargets.targets[0].path = path; await writeFile(file, JSON.stringify(config)); clearConfigCache();
}
const fenceOf = async (repository: string) => {
  const oid = await git(repository, 'for-each-ref', '--format=%(objectname)', adoptionFenceRef(TARGET));
  return oid ? JSON.parse(await git(repository, 'cat-file', 'blob', oid)) as Record<string, unknown> : null;
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('delivery queue end to end: real Git, Docker Runs, runtime service and terminal', () => {
  it('three disjoint deliveries are re-prepared on the advancing head and adopted after one publication and one adoption card; an overlapping fourth is conflict-needs-reattempt with nothing written', { timeout: 900_000 }, async () => {
    const f = await fixture();
    const liveBefore = await repositoryDigest(f.project), targetHead = await git(f.target, 'rev-parse', 'HEAD');
    // Four accepted Attempts, all made on H0 (the base branch tip before anything is adopted).
    const attempts = [await f.coding('r1', 'write-a'), await f.coding('r2', 'write-b'), await f.coding('r3', 'write-c'), await f.coding('r4', 'overlap')];
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base);

    const service = await startTestRuntimeService(f.project, f.options.env);
    cleanup.push(() => stopTestRuntimeService(service));
    const client = configuredTargetQueueTerminal(f.project, f.options).deliveryQueue;
    const view = async (commandId: string) => (await client.inspectTargetQueue({ schemaVersion: 1, scopeId: SCOPE, commandId })).record;
    const enqueue = (commandId: string, identity: AttemptIdentity) => client.enqueueTargetQueue({ schemaVersion: 1, commandId, identity, target: { kind: 'git-ref', id: TARGET } });
    // Every reference (branches, deliveries, the queue generation fence), the object store, HEAD and the checkout.
    const written = async () => ({ refs: await git(f.target, 'for-each-ref', '--format=%(refname) %(objectname)'), objects: await git(f.target, 'count-objects', '-v'),
      head: await git(f.target, 'rev-parse', 'HEAD'), status: await git(f.target, 'status', '--porcelain') });
    const quiet = await written(); // first activation: no queue generation exists yet
    const tickets = ['q1', 'q2', 'q3'];
    for (const [index, ticket] of tickets.entries()) expect(await enqueue(ticket, attempts[index]!)).toMatchObject({ commandId: ticket, state: 'queued' });

    // Each candidate gets its own normal verification Run on the exact candidate commit; it is executed and evaluated like any Run.
    for (const ticket of tickets) {
      const runId = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: ticket } } as never).verificationRun;
      await until(() => f.runRevision(runId), revision => revision !== null, `${ticket} verification Run admitted`);
      expect((await view(ticket))?.state).toBe('verifying');
      await f.evaluate(runId, await f.execute(runId));
      await until(() => view(ticket), record => record?.state === 'awaiting-confirmation', `${ticket} awaiting confirmation`);
    }
    // Admission, real re-preparation and the verification Runs wrote nothing to the target before the human answered (Astra 2607 F2).
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base); expect(await written()).toEqual(quiet);

    // The human declines the publication card on the real terminal: no consent, no write, the tickets keep waiting for a fresh card.
    const declined = await cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', 'q1'],
      [['y/N: ', 'n\r'], ['No valid consent covers this exact batch', '']]);
    expect(declined.status).not.toBe(0);
    expect(await written()).toEqual(quiet);
    for (const ticket of tickets) expect((await view(ticket))?.state).toBe('awaiting-confirmation');

    // The shipped CLI on a real controlling terminal: one exact publication card, then one exact adoption card, for the whole batch.
    const confirmed = await cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', 'q1'],
      [['y/N: ', 'y\r'], [ADOPT_PROMPT, 'y\r', 'fresh'], ['Confirmed batch', '']]);
    expect(confirmed.status).toBe(0);
    expect(confirmed.output).toContain('Publish delivery references');
    expect(confirmed.output).toContain('Adopt the verified prefix');
    expect(confirmed.output.match(/Write this reference\? y\/N: /gu)).toHaveLength(1); expect(confirmed.output.match(/to the verified commit\? y\/N: /gu)).toHaveLength(1);
    expect(confirmed.output.match(/Exact batch: [a-f0-9]{64}/gu)).toHaveLength(2);
    expect(confirmed.output.match(/Items: 3/gu)).toHaveLength(2);
    for (const ticket of tickets) expect(confirmed.output).toContain(`Ticket ${ticket}`);
    expect(confirmed.output).toContain('"settledPrefix":3');

    // Outcomes: the first candidate sat on H0; the second and third were prepared on the head the prefix advanced to.
    const settled = await Promise.all(tickets.map(view)) as TargetQueueView[];
    expect(settled.map(record => [record.state, record.outcome])).toEqual([['settled', 'adopted'], ['settled', 're-prepared+adopted'], ['settled', 're-prepared+adopted']]);
    const c3 = await git(f.target, 'rev-parse', TARGET), c2 = await git(f.target, 'rev-parse', `${c3}^`), c1 = await git(f.target, 'rev-parse', `${c2}^`);
    expect(await git(f.target, 'rev-parse', `${c1}^`)).toBe(f.base);
    expect(await git(f.target, 'rev-list', '--count', `${f.base}..${c3}`)).toBe('3');
    for (const [commit, files] of [[c1, ['a.txt', 'note.txt']], [c2, ['a.txt', 'b.txt', 'note.txt']], [c3, ['a.txt', 'b.txt', 'c.txt', 'note.txt']]] as const)
      expect((await git(f.target, 'ls-tree', '--name-only', commit)).split('\n').sort()).toEqual(files);
    // Each adopted commit was published first at its own create-only delivery reference.
    const deliveries = (await git(f.target, 'for-each-ref', '--format=%(objectname)', 'refs/deckent/deliveries/')).split('\n').filter(Boolean).sort();
    expect(deliveries).toEqual([c1, c2, c3].sort());
    // The live project and the target checkout are untouched; only the registered base branch moved.
    expect(await repositoryDigest(f.project)).toBe(liveBefore);
    expect(await git(f.target, 'rev-parse', 'HEAD')).toBe(targetHead);

    // The fourth Attempt (made on H0) writes a.txt, which the adopted prefix added: no automatic merge, a typed reattempt outcome.
    const before = await written();
    expect(await enqueue('q4', attempts[3]!)).toMatchObject({ commandId: 'q4', state: 'queued' });
    const fourth = await until(() => view('q4'), record => record?.state === 'settled', 'q4 settled');
    expect(fourth?.outcome).toBe('conflict-needs-reattempt');
    const q4Ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q4' } } as never);
    expect(await f.runRevision(q4Ids.verificationRun)).toBeNull();
    expect(fourth?.nextAction).toBe('new-attempt');
    expect(await written()).toEqual(before); expect(await git(f.target, 'rev-parse', TARGET)).toBe(c3);
    expect(await repositoryDigest(f.project)).toBe(liveBefore);
  });
});

/** The runtime service, the queue client and the shipped confirmation CLI on a PTY, for one fixture. */
async function queueSession(f: Fixture) {
  const service = await startTestRuntimeService(f.project, f.options.env);
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await stopTestRuntimeService(service); } };
  cleanup.push(stop);
  const client = configuredTargetQueueTerminal(f.project, f.options).deliveryQueue;
  const view = async (commandId: string) => (await client.inspectTargetQueue({ schemaVersion: 1, scopeId: SCOPE, commandId })).record;
  /** Enqueue an accepted Attempt and run its verification Run through the ordinary Run applications, up to the human's card. */
  const toConfirmation = async (ticket: string, identity: AttemptIdentity) => {
    expect(await client.enqueueTargetQueue({ schemaVersion: 1, commandId: ticket, identity, target: { kind: 'git-ref', id: TARGET } })).toMatchObject({ state: 'queued' });
    const runId = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: ticket } } as never).verificationRun;
    await until(() => f.runRevision(runId), revision => revision !== null, `${ticket} verification Run admitted`);
    await f.evaluate(runId, await f.execute(runId));
    await until(() => view(ticket), record => record?.state === 'awaiting-confirmation', `${ticket} awaiting confirmation`);
  };
  const confirm = (ticket: string, steps: readonly Step[] = [['y/N: ', 'y\r'], [ADOPT_PROMPT, 'y\r', 'fresh'], ['Confirmed batch', '']]) =>
    cliInPty(f.project, f.options.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', ticket], steps);
  const written = async () => ({ refs: await git(f.target, 'for-each-ref', '--format=%(refname) %(objectname)'), objects: await git(f.target, 'count-objects', '-v'),
    head: await git(f.target, 'rev-parse', 'HEAD'), status: await git(f.target, 'status', '--porcelain') });
  /** The human list through the built CLI (owner CLI review 2026-10-19, C-PRIO): a table, not the JSON page. */
  const list = () => cliInPty(f.project, f.options.env, ['task', 'integration-queue-list', '--scope', SCOPE, '--lang', 'en'], []);
  return { stop, view, toConfirmation, confirm, written, list };
}

// BENIMSEME-DEPO-KIMLIGI (ADOPT-UNKNOWN 2026-10-17): the adoption journal numbered sequences per ref name across every repository while
// the fence lives in each repository. After the work target was switched to a fresh clone, the first queue adoption published, was
// refused at the fence (sequence N+1 against no fence), the bare catch reported `unknown` and the ticket stayed reconciling for good.
describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('delivery queue adoption: repository identity, fence agreement and recovery', () => {
  it('a work target switched to a fresh clone adopts as sequence 1 of its own repository; the old repository keeps its chain', { timeout: 600_000 }, async () => {
    const f = await fixture();
    seedChain(f, 3);
    const attempt = await f.coding('r1', 'write-a');
    const s = await queueSession(f);
    await s.toConfirmation('q1', attempt);
    const confirmed = await s.confirm('q1');
    const ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q1' } } as never);
    expect({ settled: confirmed.output.includes('"settledPrefix":1'), ticket: (await s.view('q1'))?.state, row: journal(f, ids.adoption) })
      .toMatchObject({ settled: true, ticket: 'settled', row: { sequence: 1, settled: 1 } });
    expect(confirmed.status).toBe(0);
    const adopted = await git(f.target, 'rev-parse', TARGET);
    expect(adopted).not.toBe(f.base); expect(await git(f.target, 'rev-parse', `${adopted}^`)).toBe(f.base);
    expect(await fenceOf(f.target)).toMatchObject({ sequence: 1, scopeId: SCOPE, commandId: ids.adoption });
    // The clone's repository identity is its own; the old repository's chain and fence are untouched.
    expect(journal(f, ids.adoption)?.repository).toMatch(/^[a-f0-9]{64}$/u);
    expect(journal(f, 'legacy-3')).toMatchObject({ sequence: 3, settled: 1, repository: 'pre-v58' });
    expect(await fenceOf(f.project)).toMatchObject({ sequence: 3, commandId: 'legacy-3' });
  });

  it('a fence that disagrees with the journal is refused before publication: no delivery reference, journal row or other target write', { timeout: 600_000 }, async () => {
    const f = await fixture();
    // The registered repository carries a fence no journal record of it names (a foreign copy, a restore, a manual write).
    writeFence(f.target, { sequence: 5, scopeId: SCOPE, commandId: 'elsewhere' });
    const attempt = await f.coding('r1', 'write-a');
    const s = await queueSession(f);
    await s.toConfirmation('q1', attempt);
    const before = await s.written();
    const refused = await s.confirm('q1', [['y/N: ', 'y\r'], [ADOPT_PROMPT, 'y\r', 'fresh'], ['does not agree', '']]);
    const ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q1' } } as never);
    expect({ status: refused.status === 0, ticket: (await s.view('q1'))?.state, row: journal(f, ids.adoption) ?? null })
      .toEqual({ status: false, ticket: 'awaiting-confirmation', row: null });
    expect(await s.written()).toEqual(before);
    expect(await git(f.target, 'for-each-ref', 'refs/deckent/deliveries/')).toBe('');
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base);
  });

  it('an adoption whose ref move fails is proven not applied after fencing: the row is released, the ticket parks for a new attempt, the next ticket adopts', { timeout: 900_000 }, async () => {
    const f = await fixture();
    // Both Attempts write a.txt on H0 (the fixture's `verify` kind reads it); only one of them is ever adopted.
    const first = await f.coding('r1', 'write-a'), second = await f.coding('r2', 'write-a');
    const s = await queueSession(f);
    await s.toConfirmation('q1', first);
    // The Git transaction dies without committing (a genuinely uncertain failure from the move onwards): only a fenced observation decides.
    vi.spyOn(GitIntegrationAdoption.prototype, 'move').mockRejectedValueOnce(new Error('update-ref killed'));
    const failed = await s.confirm('q1');
    const ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q1' } } as never);
    const parked = await s.view('q1');
    expect({ ticket: parked?.state, next: parked?.nextAction, row: journal(f, ids.adoption) })
      .toMatchObject({ ticket: 'parked', next: 'new-attempt', row: { sequence: 1, settled: 2 } });
    expect(failed.output).toContain('"state":"refused"');
    expect(parked?.reason).toBe('ADOPTION_NOT_APPLIED');
    // C-PRIO: the parked delivery is visible in the human list with its typed reason and next step; no raw JSON reaches the human.
    const listed = await s.list();
    expect(listed.status).toBe(0);
    expect(listed.output).toMatch(/refs\/heads\/\S+\s+Parked\s+Create a new attempt\s+q1/u);
    expect(listed.output).toContain(`Reason: ${ErrorRegistry.createError('ADOPTION_NOT_APPLIED', { locale: 'en' }).message}`);
    expect(listed.output).not.toContain('schemaVersion');
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base); expect(await fenceOf(f.target)).toBeNull();
    // The released row no longer blocks the target: the next ticket adopts as sequence 1 of this repository.
    await s.toConfirmation('q2', second);
    expect((await s.confirm('q2')).output).toContain('"settledPrefix":1');
    const q2 = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q2' } } as never);
    expect(journal(f, q2.adoption)).toMatchObject({ sequence: 1, settled: 1 });
    expect(await fenceOf(f.target)).toMatchObject({ sequence: 1, commandId: q2.adoption });
  });

  it('a ticket that published but never claimed its adoption parks for a new attempt even after a foreign writer moved the branch', { timeout: 900_000 }, async () => {
    const f = await fixture();
    const attempt = await f.coding('r1', 'write-a');
    const ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q1' } } as never);
    let s = await queueSession(f);
    await s.toConfirmation('q1', attempt);
    // The process dies after publication and before the adoption claimed its journal row; reconciliation dies with it.
    vi.spyOn(WorkspaceAdoptionApplication.prototype, 'adopt').mockRejectedValue(new Error('process died'));
    vi.spyOn(TargetBatchExecutor.prototype, 'reconcile').mockRejectedValue(new Error('process died'));
    await s.confirm('q1');
    expect({ ticket: (await s.view('q1'))?.state, row: journal(f, ids.adoption) ?? null }).toEqual({ ticket: 'reconciling', row: null });
    await s.stop(); vi.restoreAllMocks();
    // Meanwhile a writer outside Deckent moves the branch: the tip no longer names the ticket's base.
    const foreign = await git(f.target, 'commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'foreign');
    await git(f.target, 'update-ref', TARGET, foreign, f.base);
    // No journal row: no Deckent move was possible, so the restart parks the ticket instead of reconciling it forever.
    s = await queueSession(f);
    const parked = await s.view('q1');
    expect({ ticket: parked?.state, reason: parked?.reason, next: parked?.nextAction, row: journal(f, ids.adoption) ?? null })
      .toEqual({ ticket: 'parked', reason: 'ADOPTION_NOT_APPLIED', next: 'new-attempt', row: null });
    // Nothing was reverted or adopted on the foreign move.
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(foreign); expect(await fenceOf(f.target)).toBeNull();
  });

  it('the N1 ledger of 2026-10-17 (stuck reconciling ticket, unsettled sequence N+1, clone without fence) recovers on the first start after the v58 upgrade', { timeout: 900_000 }, async () => {
    const f = await fixture();
    seedChain(f, 3);
    // Both Attempts write a.txt on H0 (the fixture's `verify` kind reads it); only one of them is ever adopted.
    const first = await f.coding('r1', 'write-a'), second = await f.coding('r2', 'write-a');
    const ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q1' } } as never);
    let s = await queueSession(f);
    await s.toConfirmation('q1', first);
    // The process dies after publication and the journal claim, before any move or reconciliation (the shape the bare catch left on N1).
    vi.spyOn(GitIntegrationAdoption.prototype, 'move').mockRejectedValue(new Error('process died'));
    vi.spyOn(TargetBatchExecutor.prototype, 'reconcile').mockRejectedValue(new Error('process died'));
    await s.confirm('q1', [['y/N: ', 'y\r'], [ADOPT_PROMPT, 'y\r', 'fresh'], ['Confirmed batch', '']]);
    expect((await s.view('q1'))?.state).toBe('reconciling');
    await s.stop(); vi.restoreAllMocks();
    // Rewrite that ledger into the exact v57 N1 shape: the queue adoption numbered N+1 in the ref-name-wide sequence, no reason on the ticket.
    const db = new DatabaseSync(f.ledger);
    try {
      db.prepare('UPDATE workspace_adoptions SET sequence=4 WHERE command_id=?').run(ids.adoption);
      db.exec(DOWNGRADE_TO_V57_LEDGER_SQL);
      db.prepare("UPDATE target_queue SET record=json_remove(record,'$.reason') WHERE command_id='q1'").run();
      expect(db.prepare('SELECT sequence,settled FROM workspace_adoptions WHERE command_id=?').get(ids.adoption)).toEqual({ sequence: 4, settled: 0 });
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 57 });
    } finally { db.close(); }
    // N1's ticket was bound by the build before QUEUE-SMALL 2 (binding with the device number). That recorded binding is the evidence that
    // the clone observed now is the repository the pre-v58 row was claimed in (Astra 2616 F1): the executor revalidates it before adopting.
    await bindLegacy(f, 'q1');
    expect(await git(f.target, 'for-each-ref', '--format=%(refname)', 'refs/deckent/deliveries/')).not.toBe('');
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base); expect(await fenceOf(f.target)).toBeNull();

    // First start of the new build: the service upgrades the ledger to v58, then its queue recovery reconciles the ticket — no manual Git or ledger edit.
    s = await queueSession(f);
    const parked = await s.view('q1');
    expect({ ticket: parked?.state, reason: parked?.reason, next: parked?.nextAction, row: journal(f, ids.adoption) })
      .toMatchObject({ ticket: 'parked', reason: 'ADOPTION_NOT_APPLIED', next: 'new-attempt', row: { sequence: 4, settled: 2, repository: 'pre-v58' } });
    expect(journal(f, 'legacy-3')).toMatchObject({ sequence: 3, settled: 1, repository: 'pre-v58' });
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base); expect(await fenceOf(f.target)).toBeNull();
    expect(await fenceOf(f.project)).toMatchObject({ sequence: 3, commandId: 'legacy-3' });
    // QUEUE-SMALL 2's documented one-time operator step: with the target's queue terminal, delete the generation written under the old key.
    await git(f.target, 'update-ref', '-d', queueGenerationRef(TARGET));
    // The target is no longer frozen: the next ticket adopts as sequence 1 of the clone.
    await s.toConfirmation('q2', second);
    expect((await s.confirm('q2')).output).toContain('"settledPrefix":1');
    const q2 = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q2' } } as never);
    expect(journal(f, q2.adoption)).toMatchObject({ sequence: 1, settled: 1 });
    expect(await fenceOf(f.target)).toMatchObject({ sequence: 1, commandId: q2.adoption });
  });

  it('an adoption committed in the old repository is never released through a re-registered clone, at v58 or as a pre-v58 row (Astra 2616 F1)', { timeout: 900_000 }, async () => {
    const f = await fixture();
    const attempt = await f.coding('r1', 'write-a');
    const ids = queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: 'q1' } } as never);
    let s = await queueSession(f);
    await s.toConfirmation('q1', attempt);
    // The Git move commits in A (branch and fence), then the process dies before the journal records it and before any reconciliation.
    const commit = GitIntegrationAdoption.prototype.move;
    vi.spyOn(GitIntegrationAdoption.prototype, 'move').mockImplementation(async function (this: GitIntegrationAdoption, ...args: Parameters<typeof commit>) {
      await commit.apply(this, args); throw new Error('process died'); });
    vi.spyOn(TargetBatchExecutor.prototype, 'reconcile').mockRejectedValue(new Error('process died'));
    await s.confirm('q1');
    await s.stop(); vi.restoreAllMocks();
    const moved = await git(f.target, 'rev-parse', TARGET);
    expect(moved).not.toBe(f.base); expect(await fenceOf(f.target)).toMatchObject({ sequence: 1, commandId: ids.adoption });
    expect(journal(f, ids.adoption)).toMatchObject({ sequence: 1, settled: 0 });
    // The operator re-registers a fresh clone B at the base: no adoption fence, no queue generation, the branch at the base.
    const clone = join(f.root, 'clone');
    await exec('/usr/bin/git', ['clone', '-q', f.project, clone]); await git(clone, 'branch', 'dogfood/adopted', f.base); await git(clone, 'checkout', '-q', '--detach', f.base);
    await registerTarget(f, clone);
    const unresolved = async () => {
      expect((await s.view('q1'))?.state).toBe('reconciling');
      expect(journal(f, ids.adoption)).toMatchObject({ sequence: 1, settled: 0 });
      expect(await git(f.target, 'rev-parse', TARGET)).toBe(moved); expect(await git(clone, 'rev-parse', TARGET)).toBe(f.base); expect(await fenceOf(clone)).toBeNull();
    };
    // v58 row: it names A; B's observation proves nothing about A, so recovery leaves it open.
    s = await queueSession(f); await unresolved(); await s.stop();
    // The same row as a pre-v58 ledger left it (no repository): B is not the repository the ticket was bound to, so it stays open too.
    const db = new DatabaseSync(f.ledger);
    try { db.exec(DOWNGRADE_TO_V57_LEDGER_SQL); db.prepare("UPDATE target_queue SET record=json_remove(record,'$.reason') WHERE command_id='q1'").run(); } finally { db.close(); }
    s = await queueSession(f); await unresolved(); await s.stop();
    // Re-registering A, where the move happened, lets the exact fence lookup settle it as adopted.
    await registerTarget(f, f.target);
    s = await queueSession(f);
    expect(await s.view('q1')).toMatchObject({ state: 'settled', outcome: 'adopted' });
    expect(journal(f, ids.adoption)).toMatchObject({ sequence: 1, settled: 1, repository: 'pre-v58' });
  });
});
