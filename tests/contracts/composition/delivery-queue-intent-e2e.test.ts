import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { proposeRun } from '../../../src/index.js';
import { configuredTargetQueueTerminal, startConfiguredRuntimeService } from '../../../src/composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { DockerSupervisor, readLocalOsIdentity } from '#adapters/index.js';
import { createProviderSpendAccount, createProviderSpendCheckpoint, queueCommandIds } from '#engine/index.js';
import { queueServiceActor, type RunProposal } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { DRIVER, type Step } from '../support/pty-steps.js';
import { terminalApplication } from '../support/approval-terminal.js';

// alpha.47 S6 R4-b (owner D2b, 2026-10-18), real boundary: the owner proposes a coding Run whose proposal carries a delivery intent for one
// target. Even a standing low-risk class asks the owner's Run-create card; the owner approves it in a terminal. The runtime service's own Run
// progression executes the task in Docker, and the service's scan submits the accepted Attempt to the queue as the owner's service principal
// with the delegation recorded. Nobody enqueues by hand. The queue verifies the candidate; nothing reaches the target until the owner's two
// cards adopt it on the shipped CLI's PTY.
const exec = promisify(execFile);
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const git = async (cwd: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', cwd, ...args])).stdout.trim();
const TARGET = 'refs/heads/dogfood/adopted', SCOPE = 's';
const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
const attemptActions = ['execute', 'read-output', 'recover-output', 'prepare-integration', 'deliver-integration', 'evaluate', 'adopt-integration', 'rollback-integration'];
const criterion = { id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } };
const WORKERS: Readonly<Record<string, string>> = { 'append-first': "require('node:fs').appendFileSync('shared.txt','first\\n')", verify: "require('node:fs').accessSync('shared.txt')" };
const workClasses = { schemaVersion: 2, revision: 'intent-v1', classes: [{ id: 'business', parentClassId: 'small', defaultEffort: 'high',
  proposalAdmission: { risk: 'low', standingAdmission: true }, acceptanceProfile: { schemaVersion: 1, version: 1, criterionTypes: ['completion'],
    evidenceTypes: ['verification-result'], rubric: [{ criterionType: 'completion', evidenceTypes: ['verification-result'], weight: 1 }],
    ceilingRules: [], decisionThresholds: { rejectBelow: 0.2, acceptAt: 1 } } }], bindings: [{ kind: 'append-first', classId: 'business' }] };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dn-queue-intent-')); roots.push(root);
  const project = join(root, 'project'), target = join(root, 'target'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await git(project, 'init', '-q'); await git(project, 'config', 'user.email', 'live@example.invalid'); await git(project, 'config', 'user.name', 'Live');
  await writeFile(join(project, 'shared.txt'), 'base\n'); await git(project, 'add', 'shared.txt'); await git(project, 'commit', '-q', '-m', 'base');
  const base = await git(project, 'rev-parse', 'HEAD');
  await exec('/usr/bin/git', ['clone', '-q', project, target]);
  await git(target, 'config', 'user.email', 'target@example.invalid'); await git(target, 'config', 'user.name', 'Target');
  await git(target, 'branch', 'dogfood/adopted', base); await git(target, 'checkout', '-q', '--detach', base);
  const template = fixtureDockerRegistry(['x']).profiles[0]!;
  const parameters = { ...template.parameters, imageId: process.env.DECKENT_TEST_DOCKER_IMAGE! };
  const profiles = Object.entries(WORKERS).map(([kind, script]) => ({ ...template, id: `fixture-${kind}`, parameters: { ...parameters, argv: ['node', '-e', script] } }));
  const registry = { ...fixtureDockerRegistry([]), profiles, kinds: Object.keys(WORKERS).map(kind => ({ kind, profile: { id: `fixture-${kind}`, version: 1 } })), workClasses };
  const { argv: _argv, ...bounds } = parameters; void _argv;
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') }, options = { env };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
      adoption: { targets: [TARGET], verification: { kind: 'verify', required: true, criteria: [{ evaluator: criterion.evaluator, parameters: criterion.parameters }] } },
      workTargets: { schemaVersion: 1, targets: [{ id: 'n1', kind: 'git', path: target, baseRef: TARGET }] } },
    runRuntime: { pollIntervalMs: 250, failureBackoffMs: 1000 },
    // The intent pass shares the re-attempt scan cadence (once per lease); a short lease keeps the test within seconds.
    targetQueue: { batchWindowMs: 1000, leaseMs: 3000 },
    toolchains: { update: { atStartup: false, intervalMs: 0 } },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: [SCOPE], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const account = createProviderSpendAccount({ schemaVersion: 1, scopeId: SCOPE, budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 });
  const checkpoint = createProviderSpendCheckpoint(account, 1, 0), db = new DatabaseSync(opened.path);
  try { db.prepare('INSERT INTO provider_spend_accounts(scope_id,revision,reservation_count,digest,record) VALUES(?,?,?,?,?)').run(SCOPE, 1, 0, checkpoint.digest, JSON.stringify(account)); }
  finally { db.close(); }
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'queue-intent', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: [SCOPE], principals, resource: { kind: 'run', ids: 'all' } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: [SCOPE], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: attemptActions, scopes: [SCOPE], principals, resource: { kind: 'attempt', ids: 'all' } },
    { id: 'target', effect: 'allow', actions: ['use', 'adopt'], scopes: [SCOPE], principals, resource: { kind: 'work-target', ids: ['n1'] } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals, resource: { kind: 'scope', ids: [SCOPE] } },
    { id: 'budget', effect: 'allow', actions: ['inspect'], scopes: [SCOPE], principals, resource: { kind: 'provider-spend-account', ids: ['scope-budget'] } },
    { id: 'approval', effect: 'allow', actions: ['inspect', 'decide'], scopes: [SCOPE], principals, resource: { kind: 'approval', ids: 'all' } },
  ] }), { mode: 0o600 });
  const release = async (runId: string) => {
    const store = await openConfiguredAttemptStore(project, options);
    try {
      for (const binding of (await store.store.loadRun(SCOPE, runId))?.bindings ?? []) {
        const record = await store.store.loadBoundDispatch(binding.identity);
        if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); }
      }
    } finally { store.store.close(); }
  };
  return { project, target, base, env, options, release };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, notes: () => unknown, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}; service notes ${JSON.stringify(notes())}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** The shared PTY driver, except that a step whose text arrived together with the program's exit is met (the CLI prints its result and ends). */
const CLI_DRIVER = DRIVER.replace('if time.time() > deadline or not read_for(0.1):', 'if time.time() > deadline or (not read_for(0.1) and wait.encode() not in out[since:]):');
async function cliInPty(project: string, env: NodeJS.ProcessEnv, args: readonly string[], steps: readonly Step[]) {
  const argv = [process.execPath, resolve('dist/composition/core/cli/internal/entry.js'), ...args];
  const { stdout } = await exec('python3', ['-c', CLI_DRIVER, JSON.stringify(argv), JSON.stringify(steps), 'tty'],
    { cwd: project, env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const result = JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string };
  if (result.timeout) throw new Error(`waited for ${JSON.stringify(result.timeout)}\n${result.output.slice(-6000)}`);
  expect(CLI_DRIVER).not.toBe(DRIVER);
  return { ...result, output: stripVTControlCharacters(result.output) };
}

describe.skipIf(process.platform !== 'linux' || !process.env['DECKENT_TEST_DOCKER_IMAGE'])('Run delivery intent (alpha.47 S6 R4-b)', () => {
  it('an approved intent lets the service submit the accepted Attempt; only the owner\'s two cards adopt it', { timeout: 900_000 }, async () => {
    const f = await fixture(), { id, issuer, subject } = readLocalOsIdentity(), owner = { id, issuer, subject };
    const proposal: RunProposal = { schemaVersion: 1, commandId: 'propose', proposalId: 'plan', scopeId: SCOPE, runId: 'r1', proposer: owner, source: { kind: 'human' },
      budgetCeiling: { currency: 'USD', limitMinorUnits: 200 }, requiredPermissions: [], delivery: { target: { kind: 'git-ref', id: TARGET }, mode: 'enqueue-accepted' },
      graph: { schemaVersion: 4, revision: 1, tasks: [{ id: 't', kind: 'append-first', workClass: 'business', dependencies: [], acceptanceCriteria: ['exit'] }], criterionDefinitions: [criterion] } };
    cleanup.push(() => f.release('r1'));
    // A standing low-risk class would admit at once; the intent always asks the owner's Run-create card.
    const pending = await proposeRun(f.project, proposal, f.options);
    expect(pending.proposal).toMatchObject({ status: 'pending', binding: { delivery: { target: { kind: 'git-ref', id: TARGET }, mode: 'enqueue-accepted', grantedBy: owner } } });
    await terminalApplication({ project: f.project, env: f.env }, 'decide', SCOPE, { schemaVersion: 1, scopeId: SCOPE, approvalId: pending.proposal.approval!.approvalId,
      commandId: 'owner-allow', expectedRevision: 0, decision: 'allow', reason: 'Deliver this Run for my cards' });
    expect((await proposeRun(f.project, proposal, f.options)).proposal.status).toBe('accepted');

    const progressed: string[] = [], notes: { source: string; code: string; runId?: string }[] = [];
    const service = await startConfiguredRuntimeService(f.project, { onPage() {}, onError() {},
      onRunProgression(query) { progressed.push(query.runId); },
      onRunProgressionError(query, error) { notes.push({ source: 'run-progression', code: error.code, ...(query ? { runId: query.runId } : {}) }); },
      onQueryFailure(event) { notes.push({ source: 'query', code: event.code }); },
    }, { env: f.env });
    cleanup.push(async () => { await service.stop(); await service.done; });
    const client = configuredTargetQueueTerminal(f.project, f.options).deliveryQueue;
    const ticket = async () => (await client.listTargetQueue({ schemaVersion: 1, scopeId: SCOPE, after: null, limit: 16 })).records.find(row => row.identity.runId === 'r1') ?? null;
    const queued = await until(ticket, record => record?.state === 'awaiting-confirmation' || record?.state === 'settled' || record?.state === 'parked' || record?.state === 'expired',
      'the service submits and verifies the accepted Attempt', () => ({ notes, progressed }), 600_000);
    cleanup.push(() => f.release(queueCommandIds({ request: { identity: { scopeId: SCOPE }, commandId: queued!.commandId } } as never).verificationRun));
    expect(queued).toMatchObject({ state: 'awaiting-confirmation', verification: { phase: 'accepted' }, nextAction: 'confirm-batch', responsibility: 'human',
      delegation: { grantedBy: owner, runId: 'r1', requeues: 0 } });
    expect(progressed).toContain('r1');
    expect(await git(f.target, 'rev-parse', TARGET)).toBe(f.base); // nothing is written before the owner's cards
    const opened = await openConfiguredAttemptStore(f.project, f.options), db = new DatabaseSync(opened.path, { readOnly: true });
    try {
      const record = JSON.parse(String(db.prepare('SELECT record FROM target_queue WHERE command_id=?').get(queued!.commandId)!.record));
      expect(record.request).toMatchObject({ actor: queueServiceActor(owner), deliveryIntent: 'service-reattempt', delegation: { grantedBy: owner, intentRef: { runId: 'r1', proposalId: 'plan' } } });
    } finally { db.close(); opened.store.close(); }

    const adopt = await cliInPty(f.project, f.env, ['task', 'integration-queue-confirm', '--scope', SCOPE, '--command-id', queued!.commandId],
      [['y/N: ', 'y\r'], ['Adopt the verified prefix', 'y\r', 'fresh'], ['Queue result', '']]);
    expect(adopt.status).toBe(0); expect(adopt.output).toContain('"settledPrefix":1');
    const head = await git(f.target, 'rev-parse', TARGET);
    expect(await git(f.target, 'show', `${head}:shared.txt`)).toBe('base\nfirst');
    expect(await ticket()).toMatchObject({ state: 'settled', outcome: 'adopted' });
    expect(notes).toEqual([]);
  });
});
