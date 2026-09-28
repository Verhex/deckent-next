import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation, configuredApproval } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { HttpConditionalEffectTarget, registerProviderConfig } from '#adapters/index.js';
import { SystemTrustedClock, clearConfigCache, productResourcePath } from '#platform/index.js';
import { conditionalRecordServer } from '../support/conditional-record-server.js';

const exec = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); });
const ref = (id: string) => ({ id, version: 1 });
const descriptor = (id: string, targetKind: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, operation: ref(id), targetKind,
  effectClass: 'write', approval: 'policy', precondition: 'record-version', compensation: null, inputMaxBytes: 4096, ...extra });

async function fixture() {
  const server = await conditionalRecordServer(); cleanup.push(server.close);
  const root = await mkdtemp(join(tmpdir(), 'dn-effects-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const options = { env: { HOME: join(root, 'home') } };
  const target = (kind: string, idempotencyLookup: boolean) => ({ adapter: 'http-conditional', options: { kind, baseUrl: server.baseUrl, timeoutMs: 2000, responseMaxBytes: 65536, idempotencyLookup } });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, operations: {
    catalog: [descriptor('post-order', 'records', { compensation: ref('cancel-order') }), descriptor('cancel-order', 'records'),
      descriptor('approve-payment', 'records', { effectClass: 'irreversible', approval: 'required', precondition: 'none', admitWithinMs: 1 }),
      descriptor('post-blind', 'blind')],
    targets: [target('records', true), target('blind', false)] } }));
  registerProviderConfig(); // as every composed entry does before loading configuration
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (effect: 'allow' | 'require-approval' = 'allow', actions = ['execute', 'compensate', 'inspect']) => writeFile(productResourcePath(opened.layout, 'policy'),
    JSON.stringify({ schemaVersion: 1, revision: `effects-${effect}`, restrictions: [], grants: [
      { id: 'operations', effect: 'allow', actions, scopes: ['s', 's2'], principals, resource: { kind: 'operation', ids: 'all' } },
      { id: 'approvals', effect: 'allow', actions: 'all', scopes: ['s', 's2'], principals, resource: { kind: 'approval', ids: 'all' } },
      ...(effect === 'require-approval' ? [{ id: 'gate', effect, actions: ['execute'], scopes: ['s'], principals, resource: { kind: 'operation', ids: ['post-order'] } }] : []),
    ] }), { mode: 0o600 });
  await policy();
  const command = (commandId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, commandId, scopeId: 's', operation: ref('post-order'),
    target: { kind: 'records', id: 'PO-1' }, idempotencyKey: `key-${commandId}`, input: { amount: 10 }, expectedVersion: server.etag(server.records.get('PO-1') ?? 0), ...extra });
  const execute = (input: ReturnType<typeof command>) => executeConfiguredOperation(project, input as never, options);
  const state = (commandId: string) => {
    const db = new DatabaseSync(productResourcePath(opened.layout, 'ledger'), { readOnly: true });
    try { return db.prepare('SELECT state,sequence FROM effect_intents WHERE command_id=?').get(commandId); } finally { db.close(); }
  };
  server.records.set('PO-1', 1);
  return { server, project, options, policy, command, execute, state, root, target };
}

it('settles a conditional write once, replays it, refuses stale and raced preconditions, and stops approval-gated operations before any effect', async () => {
  const f = await fixture();
  const first = await f.execute(f.command('post'));
  expect(first).toMatchObject({ status: 'settled', sequence: 1, version: '"v2"', evidence: 'idempotency-record', compensates: null });
  expect(f.server.operations).toHaveLength(1);
  expect(await f.execute(f.command('post', { expectedVersion: '"v1"' }))).toEqual(first);
  expect(f.server.operations).toHaveLength(1);
  await expect(f.execute(f.command('other', { idempotencyKey: 'key-post', expectedVersion: '"v2"' }))).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
  expect((await inspectConfiguredOperation(f.project, { scopeId: 's', commandId: 'post' }, f.options)).record).toMatchObject({ state: 'settled', sequence: 1 });

  // A stale decision is refused before any intent; a change racing the write is refused by the target (If-Match) and recorded.
  await expect(f.execute(f.command('stale', { expectedVersion: '"v1"' }))).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
  expect(f.state('stale')).toBeUndefined();
  f.server.faults.bumpBeforeApply = 1;
  await expect(f.execute(f.command('raced'))).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
  expect(f.state('raced')).toEqual({ state: 'refused', sequence: 2 });
  await expect(f.execute(f.command('raced', { expectedVersion: '"v2"' }))).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
  expect(f.server.operations).toHaveLength(1);

  // C12 G2: a required approval is a pending result — no effect, no intent, the request is open for a decision.
  const pay = await f.execute(f.command('pay', { operation: ref('approve-payment'), expectedVersion: null }));
  expect(pay).toMatchObject({ schemaVersion: 2, status: 'approval-pending', commandId: 'pay', scopeId: 's', approval: { revision: 0 } });
  await f.policy('require-approval');
  expect(await f.execute(f.command('gated'))).toMatchObject({ status: 'approval-pending', commandId: 'gated' });
  expect(f.server.operations).toHaveLength(1); expect(f.state('pay')).toBeUndefined(); expect(f.state('gated')).toBeUndefined();
  await f.policy('allow', ['inspect']);
  await expect(f.execute(f.command('denied'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  // No grant is refused before any ledger access: a recorded command id with another body is not a conflict probe for the unauthorized.
  await expect(f.execute(f.command('post', { input: { amount: 11 } }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('brokers a required operation approval: pending, decided allow, the same command settles once, the approval is consumed and bound to its command and input (C12 G1/G2)', async () => {
  const f = await fixture();
  await f.policy('require-approval');
  const decide = (approvalId: string, commandId: string, decision: 'allow' | 'deny') => configuredApproval(f.project, 'decide',
    { schemaVersion: 1, scopeId: 's', approvalId, commandId, expectedRevision: 0, decision, reason: 'Reviewed' }, f.options) as Promise<{ status: string }>;
  const pending = await f.execute(f.command('gated'));
  if (pending.status !== 'approval-pending') throw new Error(pending.status);
  // The same command asked again is the same pending request (idempotent on the action digest); nothing happened at the target.
  expect(await f.execute(f.command('gated'))).toEqual(pending);
  expect(f.server.operations).toHaveLength(0); expect(f.state('gated')).toBeUndefined();
  const listed = await configuredApproval(f.project, 'list', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 }, f.options) as { request: { subject?: { kind: string; commandId?: string } } }[];
  expect(listed.map(record => record.request.subject)).toEqual([expect.objectContaining({ kind: 'operation', commandId: 'gated', target: { kind: 'records', id: 'PO-1' } })]);
  // Same command, other input: another subject, another request; the first approval never covers it.
  const other = await f.execute(f.command('gated', { input: { amount: 99 } }));
  expect(other).toMatchObject({ status: 'approval-pending' }); if (other.status !== 'approval-pending') throw new Error(other.status);
  expect(other.approval.approvalId).not.toBe(pending.approval.approvalId);

  expect(await decide(pending.approval.approvalId, 'allow-gated', 'allow')).toMatchObject({ status: 'decided' });
  const settled = await f.execute(f.command('gated'));
  expect(settled).toMatchObject({ schemaVersion: 1, status: 'settled', sequence: 1, version: '"v2"' });
  expect(f.server.operations).toHaveLength(1);
  // The intent carries the approval reference; a replay settles from the record without a new request.
  const record = (await inspectConfiguredOperation(f.project, { scopeId: 's', commandId: 'gated' }, f.options)).record;
  expect(record?.intent.approval).toEqual({ approvalId: pending.approval.approvalId, actionDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await f.execute(f.command('gated', { expectedVersion: '"v1"' }))).toEqual(settled);
  const approvals = await configuredApproval(f.project, 'list', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 }, f.options) as unknown[];
  expect(approvals).toHaveLength(2);
  // Consumed: a new command with the same input and target is not admitted by the earlier allow; it opens its own request.
  const again = await f.execute(f.command('gated-2', { expectedVersion: '"v2"' }));
  expect(again).toMatchObject({ status: 'approval-pending', commandId: 'gated-2' });
  if (again.status !== 'approval-pending') throw new Error(again.status);
  expect(again.approval.approvalId).not.toBe(pending.approval.approvalId); expect(f.server.operations).toHaveLength(1);
  // Deny is a typed refusal for that command; a different command opens its own request.
  await decide(again.approval.approvalId, 'deny-gated-2', 'deny');
  await expect(f.execute(f.command('gated-2', { expectedVersion: '"v2"' }))).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
  expect(f.state('gated-2')).toBeUndefined();
  // Catalog admitWithinMs: an allow that is not used in time is refused; nothing is sent.
  const late = await f.execute(f.command('late', { operation: ref('approve-payment'), expectedVersion: null }));
  if (late.status !== 'approval-pending') throw new Error(late.status);
  // The product measures the window on its trusted wall clock (process floor over Date.now), not on timers: the decision is stamped at a
  // frozen instant and the admission runs 50 ms later, so the case never depends on how the host wall clock moves (WSL2 steps it back ~2 s).
  const wall = vi.spyOn(Date, 'now'), decidedAt = new SystemTrustedClock().sample().wallMs; wall.mockReturnValue(decidedAt);
  await decide(late.approval.approvalId, 'allow-late', 'allow');
  wall.mockReturnValue(decidedAt + 50);
  await expect(f.execute(f.command('late', { operation: ref('approve-payment'), expectedVersion: null }))).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
  expect(f.state('late')).toBeUndefined(); expect(f.server.operations).toHaveLength(1);
});

it('runs the approval flow end to end on the product CLI and through the SDK wait wrapper: pending, decided, the same command settles (C12 G2)', async () => {
  const f = await fixture();
  await f.policy('require-approval');
  const cli = async (...args: string[]) => JSON.parse((await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), ...args, '--json'],
    { cwd: f.project, env: { ...process.env, ...f.options.env } })).stdout);
  const input = join(f.root, 'gated.json'); await writeFile(input, JSON.stringify(f.command('cli-gated')));
  const pending = await cli('operation', 'execute', '--input', input);
  expect(pending).toMatchObject({ schemaVersion: 2, status: 'approval-pending', commandId: 'cli-gated', approval: { revision: 0 } });
  expect(f.server.operations).toHaveLength(0); expect(f.state('cli-gated')).toBeUndefined();
  // The decision: the same session-authenticated `decideApproval` every surface uses (the CLI `approval decide` reaches it through the
  // running runtime service, which this test does not start; the SDK path is the local-sdk channel of the one application).
  const decide = (approvalId: string, commandId: string, decision: 'allow' | 'deny') => configuredApproval(f.project, 'decide',
    { schemaVersion: 1, scopeId: 's', approvalId, commandId, expectedRevision: 0, decision, reason: 'Reviewed' }, f.options) as Promise<{ status: string }>;
  expect(await decide(pending.approval.approvalId, 'cli-allow', 'allow')).toMatchObject({ status: 'decided', decision: { decision: 'allow' } });
  const settled = await cli('operation', 'execute', '--input', input);
  expect(settled).toMatchObject({ schemaVersion: 1, status: 'settled', commandId: 'cli-gated', sequence: 1, version: '"v2"' });
  expect(f.server.operations).toHaveLength(1); expect(f.state('cli-gated')).toEqual({ state: 'settled', sequence: 1 });
  expect((await cli('operation', 'inspect', '--scope', 's', '--command-id', 'cli-gated')).record.intent.approval).toMatchObject({ approvalId: pending.approval.approvalId });

  // SDK wait wrapper: the core never blocks; the wrapper polls the request and resubmits once after an allow. A timeout returns the pending outcome.
  const waited = await executeConfiguredOperation(f.project, f.command('sdk-gated', { expectedVersion: '"v2"' }) as never, f.options, { awaitApproval: { timeoutMs: 30, pollMs: 5 } });
  expect(waited).toMatchObject({ status: 'approval-pending', commandId: 'sdk-gated' }); if (waited.status !== 'approval-pending') throw new Error(waited.status);
  expect(f.server.operations).toHaveLength(1);
  const settling = executeConfiguredOperation(f.project, f.command('sdk-gated', { expectedVersion: '"v2"' }) as never, f.options, { awaitApproval: { timeoutMs: 5_000, pollMs: 5 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  await configuredApproval(f.project, 'decide', { schemaVersion: 1, scopeId: 's', approvalId: waited.approval.approvalId, commandId: 'sdk-allow', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' }, f.options);
  expect(await settling).toMatchObject({ status: 'settled', commandId: 'sdk-gated', sequence: 2, version: '"v3"' });
  expect(f.server.operations).toHaveLength(2);
  // The CLI wait: `--wait` polls up to the given time; a deny while waiting is the typed refusal.
  const denyInput = join(f.root, 'deny.json'); await writeFile(denyInput, JSON.stringify(f.command('cli-denied', { expectedVersion: '"v3"' })));
  const opened = await cli('operation', 'execute', '--input', denyInput);
  const waiting = exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'operation', 'execute', '--input', denyInput, '--wait', '5000', '--json'],
    { cwd: f.project, env: { ...process.env, ...f.options.env } });
  await new Promise(resolve => setTimeout(resolve, 300));
  await decide(opened.approval.approvalId, 'cli-deny', 'deny');
  await expect(waiting).rejects.toMatchObject({ stderr: expect.stringContaining('APPROVAL_DENIED') });
  expect(f.server.operations).toHaveLength(2); expect(f.state('cli-denied')).toBeUndefined();
});

it('recovers interrupted effects from target evidence and never retries an unknown outcome blindly', async () => {
  const f = await fixture();
  // Crash after the intent, before the write: the target is busy until the same command settles it.
  vi.spyOn(HttpConditionalEffectTarget.prototype, 'apply').mockImplementationOnce(async () => { throw new Error('process died before write'); });
  await expect(f.execute(f.command('first'))).rejects.toThrow();
  expect(f.state('first')).toEqual({ state: 'claimed', sequence: 1 });
  await expect(f.execute(f.command('second', { expectedVersion: '"v1"' }))).rejects.toMatchObject({ code: 'EFFECT_TARGET_BUSY' });
  expect(await f.execute(f.command('first', { expectedVersion: '"v1"' }))).toMatchObject({ status: 'settled', sequence: 1 });
  expect(f.server.operations).toHaveLength(1);

  // The write reached the target but the response was lost: the idempotency record settles it without a second write.
  f.server.faults.dropAfterWrite = 1;
  expect(await f.execute(f.command('dropped'))).toMatchObject({ status: 'settled', sequence: 2, version: '"v3"' });
  expect(f.server.operations).toHaveLength(2);
  // Lost response and the evidence endpoint is down: unknown now, settled later from evidence, still one write.
  f.server.faults.dropAfterWrite = 1; f.server.faults.lookupDown = 1;
  await expect(f.execute(f.command('uncertain'))).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
  expect(f.state('uncertain')).toEqual({ state: 'unknown', sequence: 3 });
  await expect(f.execute(f.command('blocked', { expectedVersion: '"v4"' }))).rejects.toMatchObject({ code: 'EFFECT_TARGET_BUSY' });
  expect(await f.execute(f.command('uncertain', { expectedVersion: '"v3"' }))).toMatchObject({ status: 'settled', sequence: 3, version: '"v4"' });
  expect(f.server.operations).toHaveLength(3);

  // A target without an idempotency lookup stays unknown: no retry, exactly one write, the record remains blocked.
  const blind = (commandId: string) => f.command(commandId, { operation: ref('post-blind'), target: { kind: 'blind', id: 'PO-9' }, expectedVersion: null });
  f.server.faults.dropAfterWrite = 1; f.server.records.set('PO-9', 1);
  const blindCommand = { ...blind('blind'), expectedVersion: '"v1"' };
  await expect(f.execute(blindCommand as never)).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
  const writes = f.server.operations.length;
  await expect(f.execute(blindCommand as never)).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
  expect(f.server.operations.length).toBe(writes); expect(f.state('blind')).toMatchObject({ state: 'unknown' });
});

it('compensates a settled operation with its catalog compensation as a new operation, through SDK and the product CLI', async () => {
  const f = await fixture();
  await f.execute(f.command('post'));
  const compensation = { ...f.command('cancel'), operation: ref('cancel-order'), compensates: 'post', idempotencyKey: 'cancel-post' };
  await expect(compensateConfiguredOperation(f.project, { ...compensation, operation: ref('post-order') } as never, f.options)).rejects.toMatchObject({ code: 'EFFECT_NOT_COMPENSABLE' });
  await expect(compensateConfiguredOperation(f.project, { ...compensation, commandId: 'cancel-missing', compensates: 'missing' } as never, f.options)).rejects.toMatchObject({ code: 'EFFECT_NOT_COMPENSABLE' });
  await expect(executeConfiguredOperation(f.project, compensation as never, f.options)).rejects.toMatchObject({ code: 'EFFECT_INVALID' });
  const input = join(f.root, 'cancel.json'); await writeFile(input, JSON.stringify(compensation));
  const cli = JSON.parse((await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'operation', 'compensate', '--input', input, '--json'],
    { cwd: f.project, env: { ...process.env, ...f.options.env } })).stdout);
  expect(cli).toMatchObject({ status: 'settled', compensates: 'post', operation: ref('cancel-order'), sequence: 2 });
  expect(await compensateConfiguredOperation(f.project, compensation as never, f.options)).toEqual(cli);
  // The target only ever sees namespaced wire keys derived from the durable intent, never the caller's raw keys (Astra 2041).
  const keys = f.server.operations.map(entry => entry.key);
  expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(2);
  for (const key of keys) { expect(key).toMatch(/^[a-f0-9]{64}$/); expect(['key-post', 'cancel-post']).not.toContain(key); }
  const inspected = JSON.parse((await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'operation', 'inspect', '--scope', 's', '--command-id', 'cancel', '--json'],
    { cwd: f.project, env: { ...process.env, ...f.options.env } })).stdout);
  expect(inspected.record).toMatchObject({ state: 'settled', intent: { command: { compensates: 'post' } } });
});

it('namespaces target keys, never resumes against a changed endpoint and lets a losing concurrent replay return the settled outcome (Astra 2041)', async () => {
  const f = await fixture();
  // Two scopes reuse one caller key on different records: both writes really happen (a raw key would replay the first).
  f.server.records.set('PO-2', 1);
  expect(await f.execute(f.command('a', { idempotencyKey: 'shared' }))).toMatchObject({ status: 'settled' });
  expect(await f.execute(f.command('b', { scopeId: 's2', idempotencyKey: 'shared', target: { kind: 'records', id: 'PO-2' }, expectedVersion: '"v1"' })))
    .toMatchObject({ status: 'settled', version: '"v2"' });
  expect(f.server.operations.map(entry => entry.id)).toEqual(['PO-1', 'PO-2']);

  // A concurrent replay of an unknown effect: both callers settle from evidence; the CAS loser returns the durable outcome.
  f.server.faults.dropAfterWrite = 1; f.server.faults.lookupDown = 1;
  await expect(f.execute(f.command('race'))).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
  const replay = f.command('race', { expectedVersion: '"v2"' });
  const [left, right] = await Promise.all([f.execute(replay), f.execute(replay)]);
  expect(left).toEqual(right); expect(left).toMatchObject({ status: 'settled' });

  // An unknown effect whose endpoint was reconfigured is never resent or looked up at the new service.
  f.server.faults.dropAfterWrite = 1; f.server.faults.lookupDown = 1;
  await expect(f.execute(f.command('moved'))).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
  const other = await conditionalRecordServer(); cleanup.push(other.close);
  const configPath = join(f.project, '.deckent/config.json');
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8')) as { operations: { targets: { options: { kind: string; baseUrl: string } }[] } };
  for (const target of config.operations.targets) if (target.options.kind === 'records') target.options.baseUrl = other.baseUrl;
  await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
  await expect(f.execute(f.command('moved', { expectedVersion: '"v3"' }))).rejects.toMatchObject({ code: 'EFFECT_TARGET_CHANGED' });
  expect(other.operations).toHaveLength(0); expect(f.state('moved')).toMatchObject({ state: 'unknown' });
});
