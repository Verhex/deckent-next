import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GitQueueTarget, type GitWorkspaceOptions } from '#adapters/index.js';
import { SqliteTargetQueue } from '#adapters/core/target-queue-store/index.js';
import { migrateLedger } from '#adapters/core/sqlite-ledger/index.js';
import { createTargetQueueService, targetQueueKey, RUNTIME_SERVICE_SCHEMA_VERSION, TargetQueueApplication, GitQueueTargetApplication, adoptionRepositoryIdentity,
  queueGenerationRef, type QueueServiceContext, type TargetBatchEffects, type TargetQueuePreparation } from '#engine/index.js';
import { candidateBindingSchema, candidateEvidenceSchema, type TargetQueueRecord } from '#domain/index.js';

// Astra 2607 F1/F2 at the real boundary: a real Git target repository with the shipped generation producer (GitQueueTarget) and a
// file-backed ledger that survives a service restart. Preparation and verification are ports here (their Git/Run proofs live elsewhere);
// what is measured is which writes the queue service itself makes to the target, and whether ownership survives a restart.
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const TARGET = 'refs/heads/integration', SCOPE = 's';
const principal = { id: 'human', issuer: 'os', subject: '1000', assurance: 'os-user', scopeIds: [SCOPE] } as const;
const bounds = { capacity: 8, perTarget: 4, activeTargets: 2, batchSize: 2, batchWindowMs: 1, leaseMs: 60_000, verificationTimeoutMs: 60_000, revalidations: 2 };
const peer = { pid: process.pid, uid: process.getuid!() };
const delivery = { maxResultBytes: 65_536 };
const identity = (n: number) => ({ scopeId: SCOPE, runId: `r${n}`, taskId: 't', attemptId: `a${n}`, generation: 1, layoutRevision: 'l' });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-queue-generation-')); roots.push(root);
  const sourceRoot = join(root, 'target'), workspaceRoot = join(root, 'workspaces'), ledger = join(root, 'ledger.sqlite');
  await mkdir(sourceRoot, { mode: 0o700 }); await mkdir(workspaceRoot, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec('/usr/bin/git', ['-C', sourceRoot, ...args])).stdout.trim();
  await git('init', '-q'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Test'); await git('config', 'gc.auto', '0');
  await writeFile(join(sourceRoot, 'note.txt'), 'base\n'); await git('add', '.'); await git('commit', '-qm', 'base');
  const base = await git('rev-parse', 'HEAD'); await git('branch', 'integration', base);
  const options: GitWorkspaceOptions = { sourceRoot, workspaceRoot, gitExecutable: '/usr/bin/git', timeoutMs: 10_000, outputBytes: 65_536, baseRef: TARGET };
  const gitTarget = new GitQueueTarget(options, 'installation', 'registered', [TARGET], []);
  /** A commit whose parent is `parent`, made before any measurement (stands for a privately prepared candidate's objects). */
  const commit = async (parent: string, name: string) => git('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', name);
  /** Every reference with its value, the object store, HEAD and the checkout: equal values mean the queue wrote nothing to the target. */
  const target = async () => ({ refs: await git('for-each-ref', '--format=%(refname) %(objectname)'), objects: await git('count-objects', '-v'),
    head: await git('rev-parse', 'HEAD'), status: await git('status', '--porcelain'), tip: await git('rev-parse', TARGET) });
  const generation = async () => {
    const rows = await git('for-each-ref', '--format=%(objectname)', 'refs/deckent/queue-generations/');
    return rows ? JSON.parse(await git('cat-file', 'blob', rows)) as { owner: string; epoch: number } : null;
  };
  const db0 = new DatabaseSync(ledger); migrateLedger(db0, 'allow'); db0.close();
  /** Candidate per ticket: version and Git commit are the same value, so the effect stubs move real refs to real objects. */
  const candidates = new Map<string, string>(), conflicts = new Set<string>();
  const ttl = { ms: 60_000 };
  /** What the effect lookup observes for a reconciling ticket, and how often the service asked. */
  const reconciliation: { calls: number; result: 'unknown' | 'not-applied' } = { calls: 0, result: 'unknown' };
  /** One service process: its own instance id and ledger connection, like a restart of the runtime service. */
  /** `failAudit` makes the audit of the first write entering that state fail inside its ledger transaction (an audit/storage error). */
  const service = (instanceId: string, failAudit?: { state: TargetQueueRecord['state'] }, windowMs = 1) => {
    const db = new DatabaseSync(ledger), queue = new SqliteTargetQueue(db);
    const app = new TargetQueueApplication(queue, { async authorize() {}, async validate() {} }, bounds, (_store, written) => {
      if (failAudit && written.state === failAudit.state) { failAudit = undefined; throw new Error('audit-storage-failure'); } });
    const context = (): QueueServiceContext => ({ principal, document: { revision: 'p' }, config: { targetQueue: { capacity: 8, ttlMs: ttl.ms } }, queue, bounds, app,
      target: { binding: ref => gitTarget.resolveTarget(ref), describe: () => gitTarget.describe() },
      async accepted() { return { acceptedRevision: 1, outputDigest: 'c'.repeat(64) }; }, async describeCandidate() { return { changes: ['note.txt'] }; } });
    const preparation: TargetQueuePreparation = {
      async prepare(record, predecessor) {
        if (conflicts.has(record.request.commandId)) throw Object.assign(new Error('overlap'), { code: 'PATCH_BASE_ADVANCED' });
        const from = predecessor?.candidate?.candidateVersion ?? await git('rev-parse', TARGET), to = candidates.get(record.request.commandId)!;
        return candidateBindingSchema.parse({ schemaVersion: 1, target: record.request.target, identity: record.request.identity, sourceBinding: 'b'.repeat(64),
          outputDigest: record.request.outputDigest, observedVersion: from, effectiveVersion: from, candidateVersion: to, candidateDigest: 'd'.repeat(64),
          custodyReceipt: 'e'.repeat(64), criteria: ['f'.repeat(64)], profileFingerprint: 'a'.repeat(64), replacesCommandId: null });
      },
      async admitVerification() {},
      async evidence(record) {
        const c = record.candidate!;
        return candidateEvidenceSchema.parse({ schemaVersion: 1, identity: record.request.identity, sourceBinding: c.sourceBinding, candidateVersion: c.candidateVersion,
          candidateDigest: c.candidateDigest, custodyReceipt: c.custodyReceipt, criteria: c.criteria, profileFingerprint: c.profileFingerprint, evidenceReceipt: 'f'.repeat(64), phase: 'accepted' });
      },
      effectIds: record => [`publish-${record.request.commandId}`, `adopt-${record.request.commandId}`],
    };
    const fenced = (fence: string) => JSON.parse(fence) as { ref: string; value: string };
    // The shipped adapters verify the generation in the same ref transaction as their write; these stand-ins do exactly that.
    const effects: TargetBatchEffects = {
      fence: async (binding, owner, epoch) => JSON.stringify(await gitTarget.fence(targetQueueKey(binding), owner, epoch)),
      async validate() {},
      async publish(record, fence) {
        const { ref, value } = fenced(fence);
        await runTransaction(`verify ${ref} ${value}\ncreate refs/deckent/deliveries/${record.request.commandId} ${record.candidate!.candidateVersion}\n`);
        return { state: 'settled', evidenceRefs: ['1'.repeat(64)] };
      },
      async adopt(record, fence) {
        const { ref, value } = fenced(fence);
        await runTransaction(`verify ${ref} ${value}\nupdate ${TARGET} ${record.candidate!.candidateVersion} ${record.candidate!.effectiveVersion}\n`);
        return { state: 'settled', evidenceRefs: ['2'.repeat(64)] };
      },
      async lookup() { reconciliation.calls++; return { state: reconciliation.result }; },
      async release() { return reconciliation.result === 'not-applied' ? { state: 'refused', evidenceRefs: ['3'.repeat(64)] } : { state: 'unknown' }; },
    };
    const instance = createTargetQueueService({ instanceId, config: { targetQueue: { capacity: 8, candidateSlots: 2, batchWindowMs: windowMs } },
      async withScope(_scope, _peer, _read, work) { return work(context()); }, snapshot: async () => queue.pending(8), withActor: async (_record, work) => work(),
      effects: async () => effects, preparation: async () => preparation, captureProcess: async () => ({ processStart: 'start', terminal: 'tty' }),
      isMcp: () => false, record: async () => {} });
    const call = (operation: string, input: unknown) => instance.execute({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'rpc', operation, input, delivery } as never, peer, 131_072);
    const enqueue = (commandId: string, n: number) => call('enqueueTargetQueue', { schemaVersion: 1, commandId, identity: identity(n), target: { kind: 'git-ref', id: TARGET } });
    const challenge = async (commandId: string, operation: 'publish' | 'adopt', publishDigest?: string) =>
      await call('challengeTargetQueue', { schemaVersion: 1, scopeId: SCOPE, commandId, operation, ...(publishDigest ? { publishDigest } : {}) }) as { digest: string; capability: string };
    const answer = (consent: { digest: string; capability: string }, value: 'allow' | 'decline') =>
      call('answerTargetQueue', { schemaVersion: 1, scopeId: SCOPE, digest: consent.digest, capability: consent.capability, answer: value });
    /** The two cards (publication, then adoption of the same frozen prefix), both allowed, then the execution. */
    const confirm = async (commandId: string) => {
      const publish = await challenge(commandId, 'publish'); await answer(publish, 'allow');
      const adopt = await challenge(commandId, 'adopt', publish.digest); await answer(adopt, 'allow');
      return call('executeTargetQueue', { schemaVersion: 1, scopeId: SCOPE, commandId, publishDigest: publish.digest, adoptDigest: adopt.digest });
    };
    const record = (commandId: string) => queue.load(SCOPE, commandId) as TargetQueueRecord;
    /** Ticks until the batch window has passed and the ticket left `queued`. */
    const advance = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await instance.tick(); };
    return { instance, app, queue, call, enqueue, challenge, answer, confirm, record, advance, close: () => db.close() };
  };
  const runTransaction = async (body: string) => new Promise<void>((resolve, reject) => {
    const child = execFile('/usr/bin/git', ['-C', sourceRoot, 'update-ref', '--stdin'], error => error ? reject(error) : resolve());
    child.stdin!.end(`start\noption no-deref\n${body}prepare\ncommit\n`);
  });
  return { git, base, commit, target, generation, service, candidates, conflicts, ttl, gitTarget, reconciliation, sourceRoot, options };
}

describe.skipIf(process.platform !== 'linux')('queue generation fence: no target write before consent, durable ownership across restart (Astra 2607 F1/F2)', () => {
  it('a conflicting first activation, a declined batch and an expired ticket leave every ref, object, HEAD and checkout untouched', async () => {
    const f = await fixture(), s = f.service('service-a');
    try {
      const before = await f.target();
      // First activation of this target: no generation exists yet. The item overlaps the target's drift and settles as a reattempt.
      f.conflicts.add('q1');
      expect(await s.enqueue('q1', 1)).toMatchObject({ state: 'queued' });
      expect(await f.target()).toEqual(before);
      await s.advance();
      expect(s.record('q1')).toMatchObject({ state: 'settled', outcome: 'conflict-needs-reattempt' });
      expect(await f.target()).toEqual(before); expect(await f.generation()).toBeNull();

      // A verified candidate reaches the publication card; the human declines it. The execution that follows has no consent.
      f.candidates.set('q2', await f.commit(f.base, 'candidate-2'));
      const prepared = await f.target();
      f.ttl.ms = 1_500;
      expect(await s.enqueue('q2', 2)).toMatchObject({ state: 'queued' });
      await s.advance();
      expect(s.record('q2').state).toBe('awaiting-confirmation');
      const publish = await s.challenge('q2', 'publish');
      await expect(s.answer(publish, 'decline')).rejects.toMatchObject({ code: 'QUEUE_CONFIRMATION_REQUIRED' });
      await expect(s.call('executeTargetQueue', { schemaVersion: 1, scopeId: SCOPE, commandId: 'q2', publishDigest: publish.digest, adoptDigest: publish.digest }))
        .rejects.toMatchObject({ code: 'QUEUE_CONFIRMATION_REQUIRED' });
      expect(await f.target()).toEqual(prepared); expect(await f.generation()).toBeNull();

      // Unanswered until its deadline: the ticket parks, still without a target write.
      await new Promise(resolve => setTimeout(resolve, Math.max(0, s.record('q2').request.deadline - Date.now()) + 10));
      await s.instance.tick();
      expect(s.record('q2').state).toBe('parked');
      expect(await f.target()).toEqual(prepared); expect(await f.generation()).toBeNull();
    } finally { s.close(); }
  });

  it('a restart between enqueue and reservation still delivers; a restart on an emptied target moves ownership forward, never sideways', async () => {
    const f = await fixture();
    f.candidates.set('q1', await f.commit(f.base, 'candidate-1'));
    const a = f.service('service-a');
    try { expect(await a.enqueue('q1', 1)).toMatchObject({ state: 'queued' }); } finally { a.close(); }

    // Restart before the ticket was reserved: the new instance recovers nothing to fence, reserves the durable epoch and executes it.
    const b = f.service('service-b');
    try {
      expect(await b.instance.recover()).toEqual([]);
      await b.advance();
      expect(b.record('q1')).toMatchObject({ state: 'awaiting-confirmation', ownerInstance: 'service-b', epoch: 1 });
      expect(await b.confirm('q1')).toMatchObject({ settledPrefix: 1 });
      expect(b.record('q1')).toMatchObject({ state: 'settled', outcome: 'adopted' });
      expect(await f.git('rev-parse', TARGET)).toBe(f.candidates.get('q1'));
      expect(await f.generation()).toMatchObject({ owner: 'service-b', epoch: 1 });
    } finally { b.close(); }

    // Every ticket is terminal; a new instance admits the next one and takes the next epoch, past the previous owner's.
    f.candidates.set('q2', await f.commit(f.candidates.get('q1')!, 'candidate-2'));
    const c = f.service('service-c');
    try {
      expect(await c.instance.recover()).toEqual([]);
      expect(await c.enqueue('q2', 2)).toMatchObject({ state: 'queued' });
      await c.advance();
      expect(c.record('q2')).toMatchObject({ state: 'awaiting-confirmation', ownerInstance: 'service-c', epoch: 2 });
      expect(await c.confirm('q2')).toMatchObject({ settledPrefix: 1 });
      expect(await f.git('rev-parse', TARGET)).toBe(f.candidates.get('q2'));
      expect(await f.generation()).toMatchObject({ owner: 'service-c', epoch: 2 });
      // The stale-writer guard is unchanged: the previous owner's epoch, or another owner at the same epoch, is refused.
      const key = targetQueueKey(c.record('q2').request.target);
      await expect(f.gitTarget.fence(key, 'service-b', 1)).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
      await expect(f.gitTarget.fence(key, 'service-b', 2)).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
    } finally { c.close(); }
  });

  it('startup parks pre-consent work by durable ownership alone and physically fences only work whose effect may be in flight', async () => {
    const f = await fixture();
    f.candidates.set('q1', await f.commit(f.base, 'candidate-1'));
    const a = f.service('service-a');
    let quiet: Awaited<ReturnType<typeof f.target>>;
    try {
      await a.enqueue('q1', 1); await a.advance();
      expect(a.record('q1').state).toBe('awaiting-confirmation');
      quiet = await f.target();
    } finally { a.close(); }
    const b = f.service('service-b');
    try {
      expect(await b.instance.recover()).toEqual([]);
      expect(b.record('q1')).toMatchObject({ state: 'parked', ownerInstance: 'service-b', epoch: 2 });
      expect(await f.target()).toEqual(quiet); expect(await f.generation()).toBeNull();

      // A publication that was consented and started, then lost with its process: the restart must advance the physical fence.
      f.candidates.set('q2', await f.commit(f.base, 'candidate-2'));
      await b.enqueue('q2', 2); await b.advance();
      const waiting = b.record('q2');
      expect(waiting).toMatchObject({ state: 'awaiting-confirmation', ownerInstance: 'service-b', epoch: 3 });
      b.app.transition(waiting, { state: 'publishing', batchDigest: '9'.repeat(64) });
    } finally { b.close(); }
    const c = f.service('service-c');
    try {
      expect(await c.instance.recover()).toEqual([]);
      expect(c.record('q2')).toMatchObject({ state: 'reconciling', ownerInstance: 'service-c', epoch: 4 });
      expect(await f.generation()).toMatchObject({ owner: 'service-c', epoch: 4 });
    } finally { c.close(); }
  });

  it('an interrupted recovery leaves pre-consent work unchanged or safely parkable, never an effect in flight (Astra 2609 F2-R)', async () => {
    const f = await fixture();
    f.candidates.set('q1', await f.commit(f.base, 'candidate-1')); f.candidates.set('q2', await f.commit(f.base, 'candidate-2'));
    const a = f.service('service-a');
    let quiet: Awaited<ReturnType<typeof f.target>>;
    try {
      await a.enqueue('q1', 1); await a.advance();
      expect(a.record('q1')).toMatchObject({ state: 'awaiting-confirmation', ownerInstance: 'service-a', epoch: 1, batchDigest: null });
      quiet = await f.target();
    } finally { a.close(); }
    // Recovery's park write fails in its ledger transaction (audit/storage error). Nothing about that ticket may have been committed.
    const b = f.service('service-b', { state: 'parked' });
    try {
      const failures = await b.instance.recover();
      expect(failures).toHaveLength(1);
      expect(b.record('q1')).toMatchObject({ state: 'awaiting-confirmation', ownerInstance: 'service-a', epoch: 1 });
      expect(await f.target()).toEqual(quiet); expect(await f.generation()).toBeNull();
    } finally { b.close(); }
    // The ledger is reopened and recovery runs again: the ticket parks under the new owner, still without any target write.
    const c = f.service('service-c');
    try {
      expect(await c.instance.recover()).toEqual([]);
      expect(c.record('q1')).toMatchObject({ state: 'parked', ownerInstance: 'service-c', epoch: 2, batchDigest: null });
      expect(await f.target()).toEqual(quiet); expect(await f.generation()).toBeNull();
    } finally { c.close(); }
  });

  it('a ticket an earlier recovery left reconciling before its park committed is parked from the ledger, not fenced (Astra 2609 F2-R)', async () => {
    const f = await fixture();
    f.candidates.set('q2', await f.commit(f.base, 'candidate-2'));
    const c = f.service('service-c');
    let quiet: Awaited<ReturnType<typeof f.target>>;
    try {
      // The process died between the two commits of the previous recovery: ownership is durable, the park is not. No effect started.
      await c.enqueue('q2', 2); await c.advance();
      const waiting = c.record('q2');
      expect(waiting).toMatchObject({ state: 'awaiting-confirmation', ownerInstance: 'service-c', epoch: 1, batchDigest: null });
      c.app.transition(waiting, { state: 'reconciling', ownerInstance: 'service-c', epoch: 2, leaseDeadline: Date.now() + 60_000 });
      quiet = await f.target();
    } finally { c.close(); }
    const d = f.service('service-d');
    try {
      expect(await d.instance.recover()).toEqual([]);
      expect(await f.target()).toEqual(quiet); expect(await f.generation()).toBeNull();
      expect(d.record('q2')).toMatchObject({ state: 'parked', ownerInstance: 'service-d', epoch: 3, batchDigest: null });
      expect(await f.target()).toEqual(quiet); expect(await f.generation()).toBeNull();
      // An effect-capable state can never be entered without its consented batch, so null keeps meaning "no effect started".
      f.candidates.set('q3', await f.commit(f.base, 'candidate-3')); await d.enqueue('q3', 3); await d.advance();
      const pending = d.record('q3');
      expect(pending.state).toBe('awaiting-confirmation');
      expect(() => d.app.transition(pending, { state: 'adopting' })).toThrow('QUEUE_CONFIRMATION_REQUIRED');
      expect(d.record('q3')).toEqual(pending);
    } finally { d.close(); }
  });
});

describe.skipIf(process.platform !== 'linux')('queue reconciliation after a started effect (BENIMSEME-DEPO-KIMLIGI)', () => {
  it('a reconciling head is reconciled periodically with bounded backoff, and parks only with a typed reason and new evidence (BENIMSEME-DEPO-KIMLIGI)', async () => {
    const f = await fixture();
    f.candidates.set('q1', await f.commit(f.base, 'candidate-1'));
    const s = f.service('service-a', undefined, 200);
    try {
      await s.enqueue('q1', 1); await s.advance();
      const started = s.app.transition(s.record('q1'), { state: 'publishing', batchDigest: '9'.repeat(64) });
      const reconciling = s.app.transition(started, { state: 'reconciling' });
      // F2-R amended: a started effect never parks without a typed reason, nor without new evidence.
      expect(() => s.app.transition(reconciling, { state: 'parked', evidenceRefs: ['4'.repeat(64)] })).toThrow('QUEUE_CONFLICT');
      expect(() => s.app.transition(reconciling, { state: 'parked', reason: 'ADOPTION_NOT_APPLIED' })).toThrow('QUEUE_CONFLICT');
      expect(s.record('q1')).toEqual(reconciling);
      // Not only at start: tick reconciles the head, then waits out its backoff before asking again.
      await s.instance.tick(); expect(f.reconciliation.calls).toBe(1);
      await s.instance.tick(); expect(f.reconciliation.calls).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 450)); await s.instance.tick(); expect(f.reconciliation.calls).toBe(2);
      expect(s.record('q1').state).toBe('reconciling');
      // The effect is observed not applied: the ticket parks for a new attempt with the release receipt and a typed reason.
      f.reconciliation.result = 'not-applied';
      await new Promise(resolve => setTimeout(resolve, 850)); await s.instance.tick();
      expect(s.record('q1')).toMatchObject({ state: 'parked', reason: 'ADOPTION_NOT_APPLIED', evidenceRefs: ['3'.repeat(64)] });
      expect(await f.target()).toMatchObject({ tip: f.base });
    } finally { s.close(); }
  });
});

// WSL2 renumbers block devices after a restart: a queue identity that hashed st_dev changed under every queued ticket (QUEUE_CONFLICT).
describe.skipIf(process.platform !== 'linux')('queue target identity is the adoption repository identity (no device number)', () => {
  it('the binding is the realpath+inode repository identity and stays the same when only the device number changes', async () => {
    const f = await fixture();
    const path = await realpath(await f.git('rev-parse', '--path-format=absolute', '--git-common-dir')), { ino: inode, dev } = await stat(path);
    const binding = await f.gitTarget.resolveTarget({ kind: 'git-ref', id: TARGET });
    expect(binding.resourceBinding).toBe(adoptionRepositoryIdentity({ path, inode }));
    // The same repository observed under two device numbers (before and after a WSL2 restart) is one queue.
    const run = (args: string[], input = '') => new Promise<string>((resolve, reject) => {
      const child = execFile('/usr/bin/git', ['-C', f.sourceRoot, ...args], (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
      child.stdin!.end(input);
    });
    const observed = (device: number) => new GitQueueTargetApplication(f.options, 'installation', 'registered', [TARGET], [],
      { custody: async () => {}, run, common: async () => ({ path, inode, device }) as { path: string; inode: number } }).binding(TARGET);
    const [before, after] = [await observed(dev), await observed(dev + 31)];
    expect(after).toEqual(before); expect(targetQueueKey(after)).toBe(targetQueueKey(binding));
  });

  it('a generation written under the pre-change identity is refused until the operator removes it; then the queue takes the new identity', async () => {
    const f = await fixture();
    const path = await realpath(await f.git('rev-parse', '--path-format=absolute', '--git-common-dir')), { ino: inode, dev: device } = await stat(path);
    const binding = await f.gitTarget.resolveTarget({ kind: 'git-ref', id: TARGET });
    const legacy = targetQueueKey({ ...binding, resourceBinding: createHash('sha256').update(JSON.stringify({ path, device, inode })).digest('hex') });
    expect(legacy).not.toBe(targetQueueKey(binding));
    const ref = queueGenerationRef(TARGET), blob = await new Promise<string>((resolve, reject) => {
      const child = execFile('/usr/bin/git', ['-C', f.sourceRoot, 'hash-object', '-w', '--stdin'], (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
      child.stdin!.end(JSON.stringify({ schemaVersion: 1, key: legacy, owner: 'service-a', epoch: 1 }) + '\n');
    });
    await f.git('update-ref', ref, blob);
    // The key check is not weakened: a generation of another queue identity is never taken over silently.
    await expect(f.gitTarget.fence(targetQueueKey(binding), 'service-a', 2)).rejects.toMatchObject({ code: 'QUEUE_CONFLICT' });
    expect(await f.generation()).toMatchObject({ owner: 'service-a', epoch: 1 });
    // Upgrade step (queue terminal on that target): delete the generation once; the next fence writes the new identity.
    await f.git('update-ref', '-d', ref, blob);
    await f.gitTarget.fence(targetQueueKey(binding), 'service-b', 1);
    expect(await f.generation()).toMatchObject({ key: targetQueueKey(binding), owner: 'service-b', epoch: 1 });
  });
});
