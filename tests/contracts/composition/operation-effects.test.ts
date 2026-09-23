import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { executeConfiguredOperation, compensateConfiguredOperation, inspectConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { HttpConditionalEffectTarget, registerProviderConfig } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
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
      descriptor('approve-payment', 'records', { effectClass: 'irreversible', approval: 'required', precondition: 'none' }),
      descriptor('post-blind', 'blind')],
    targets: [target('records', true), target('blind', false)] } }));
  registerProviderConfig(); // as every composed entry does before loading configuration
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (effect: 'allow' | 'require-approval' = 'allow', actions = ['execute', 'compensate', 'inspect']) => writeFile(productResourcePath(opened.layout, 'policy'),
    JSON.stringify({ schemaVersion: 1, revision: 'effects', restrictions: [], grants: [
      { id: 'operations', effect: 'allow', actions, scopes: ['s'], principals, resource: { kind: 'operation', ids: 'all' } },
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
  return { server, project, options, policy, command, execute, state, root };
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

  await expect(f.execute(f.command('pay', { operation: ref('approve-payment'), expectedVersion: null }))).rejects.toMatchObject({ code: 'EFFECT_APPROVAL_REQUIRED' });
  await f.policy('require-approval');
  await expect(f.execute(f.command('gated'))).rejects.toMatchObject({ code: 'EFFECT_APPROVAL_REQUIRED' });
  expect(f.server.operations).toHaveLength(1); expect(f.state('pay')).toBeUndefined(); expect(f.state('gated')).toBeUndefined();
  await f.policy('allow', ['inspect']);
  await expect(f.execute(f.command('denied'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
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
  expect(f.server.operations.map(entry => entry.key)).toEqual(['key-post', 'cancel-post']);
  const inspected = JSON.parse((await exec(process.execPath, [resolve('dist/composition/core/cli/internal/entry.js'), 'operation', 'inspect', '--scope', 's', '--command-id', 'cancel', '--json'],
    { cwd: f.project, env: { ...process.env, ...f.options.env } })).stdout);
  expect(inspected.record).toMatchObject({ state: 'settled', intent: { command: { compensates: 'post' } } });
});
