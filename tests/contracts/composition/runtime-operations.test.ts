import { createTerminalRuntimeClient } from '../support/terminal-runtime-client.js';
import { once } from 'node:events';
import { Socket } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { executeConfiguredOperation } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { encodeServiceFrame } from '../../../src/adapters/core/local-runtime-socket/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { conditionalRecordServer } from '../support/conditional-record-server.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';

// C12 G4 (protocol v15): catalog operations are runtime-service operations. The socket peer is the principal; scope, company membership,
// policy, the approval broker and the effect contract are the same composition function the CLI/SDK use (withEffects), so a required
// approval is a non-blocking `approval-pending` outcome and the same command resubmitted after an allow settles exactly once.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); clearConfigCache(); });
const ref = (id: string) => ({ id, version: 1 });
const descriptor = (id: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, operation: ref(id), targetKind: 'records',
  effectClass: 'write', approval: 'policy', precondition: 'record-version', compensation: null, inputMaxBytes: 4096, ...extra });
const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];

async function fixture(options: { readonly responseMaxBytes?: number } = {}) {
  const server = await conditionalRecordServer(); cleanup.push(server.close);
  const root = await mkdtemp(join(tmpdir(), 'dn-runtime-ops-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const env = { HOME: join(root, 'home') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') },
    service: { inputMaxBytes: 65536, responseMaxBytes: options.responseMaxBytes ?? 65536, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 },
    operations: { catalog: [descriptor('post-order', { compensation: ref('cancel-order') }), descriptor('cancel-order')],
      targets: [{ adapter: 'http-conditional', options: { kind: 'records', baseUrl: server.baseUrl, timeoutMs: 2000, responseMaxBytes: 65536, idempotencyLookup: true } }] } }));
  registerProviderConfig(); // as every composed entry does before loading configuration
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  // `s` only: `foreign` is declared and pinned by the one test that needs it, and only after that test's own service is already
  // running (decision 6, H34 S3 Q1, owner 2026-09-27 evening — a foreign-pinned scope the trusted policy already declares at start
  // refuses the start itself; declaring it here for every test would refuse every fixture() call before the service ever starts).
  const policy = (grants: 'gated' | 'allow' | 'inspect-only', scopes: readonly string[] = ['s']) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1,
    revision: `ops-${grants}`, restrictions: [], grants: [
      { id: 'operations', effect: 'allow', actions: grants === 'inspect-only' ? ['inspect'] : ['execute', 'compensate', 'inspect'], scopes, principals,
        resource: { kind: 'operation', ids: 'all' } },
      { id: 'approvals', effect: 'allow', actions: 'all', scopes, principals, resource: { kind: 'approval', ids: 'all' } },
      ...(grants === 'gated' ? [{ id: 'gate', effect: 'require-approval', actions: ['execute'], scopes,
        resource: { kind: 'operation', ids: ['post-order'] }, principals }] : []),
    ] }), { mode: 0o600 });
  await policy('gated');
  server.records.set('PO-1', 1);
  const command = (commandId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, commandId, scopeId: 's', operation: ref('post-order'),
    target: { kind: 'records', id: 'PO-1' }, idempotencyKey: `key-${commandId}`, input: { amount: 10 },
    expectedVersion: server.etag(server.records.get('PO-1') ?? 0), ...extra });
  const rows = (table: 'effect_intents' | 'approvals', commandId?: string) => {
    const db = new DatabaseSync(opened.path, { readOnly: true });
    try {
      return table === 'effect_intents' ? db.prepare('SELECT state,sequence FROM effect_intents WHERE command_id=?').all(commandId ?? '')
        : db.prepare('SELECT approval_id FROM approvals').all();
    } finally { db.close(); }
  };
  const pin = (scope: string, company: string) => {
    const db = new DatabaseSync(opened.path);
    try {
      db.prepare('INSERT OR IGNORE INTO companies(company_id) VALUES(?)').run(company);
      db.prepare("INSERT INTO scope_registry(scope_id,company_id,origin) VALUES(?,?,'start')").run(scope, company);
    } finally { db.close(); }
  };
  const service = await startTestRuntimeService(project, env);
  const client = createTerminalRuntimeClient(project, { env });
  return { server, project, env, policy, command, rows, pin, service, client, ledger: opened.path, layout: opened.layout };
}
const decide = (client: ReturnType<typeof createTerminalRuntimeClient>, approvalId: string, commandId: string, decision: 'allow' | 'deny') =>
  client.decideApproval({ schemaVersion: 1, scopeId: 's', approvalId, commandId, expectedRevision: 0, decision, reason: 'Reviewed' }) as Promise<{ status: string }>;

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] executes a catalog operation through the runtime service: pending without an effect, decided on the live connection, the same command settles once (C12 G4)', async () => {
  const f = await fixture();
  try {
    const pending = await f.client.executeOperation(f.command('gated'));
    expect(pending).toMatchObject({ schemaVersion: 2, status: 'approval-pending', commandId: 'gated', scopeId: 's', operation: ref('post-order'),
      target: { kind: 'records', id: 'PO-1' }, approval: { revision: 0 } });
    if (pending.status !== 'approval-pending') throw new Error(pending.status);
    // Non-blocking and idempotent: the same command is the same open request; nothing reached the target, no intent exists.
    expect(await f.client.executeOperation(f.command('gated'))).toEqual(pending);
    expect(f.server.operations).toHaveLength(0); expect(f.rows('effect_intents', 'gated')).toEqual([]);
    // The runtime approval tools see the operation subject (v15) and decide it with the connection's live session.
    const listed = await f.client.listApprovals({ schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 }) as { request: { approvalId: string; subject: { kind: string } } }[];
    expect(listed.map(record => [record.request.approvalId, record.request.subject.kind])).toEqual([[pending.approval.approvalId, 'operation']]);
    expect(await decide(f.client, pending.approval.approvalId, 'allow-gated', 'allow')).toMatchObject({ status: 'decided' });
    const settled = await f.client.executeOperation(f.command('gated'));
    expect(settled).toMatchObject({ schemaVersion: 1, status: 'settled', commandId: 'gated', sequence: 1, version: '"v2"', evidence: 'idempotency-record' });
    // One intent, settled; one write at the target; a replay returns the durable outcome without a second effect.
    expect(f.rows('effect_intents', 'gated')).toEqual([{ state: 'settled', sequence: 1 }]); expect(f.server.operations).toHaveLength(1);
    expect(await f.client.executeOperation(f.command('gated', { expectedVersion: '"v1"' }))).toEqual(settled);
    expect(f.server.operations).toHaveLength(1);
    const inspected = await f.client.inspectOperation({ schemaVersion: 1, scopeId: 's', commandId: 'gated' });
    expect(inspected).toMatchObject({ schemaVersion: 1, record: { state: 'settled', intent: { approval: { approvalId: pending.approval.approvalId } } } });
    expect(await f.client.inspectOperation({ schemaVersion: 1, scopeId: 's', commandId: 'absent' })).toEqual({ schemaVersion: 1, record: null });
    // The service's outcome is the one the SDK computes from the same ledger (one composition function, same principal).
    expect(await executeConfiguredOperation(f.project, f.command('gated', { expectedVersion: '"v1"' }) as never, { env: f.env })).toEqual(settled);
    // Compensation is a new operation through the same service path.
    const compensated = await f.client.compensateOperation({ ...f.command('cancel', { expectedVersion: '"v2"' }), operation: ref('cancel-order'), compensates: 'gated' });
    expect(compensated).toMatchObject({ status: 'settled', compensates: 'gated', operation: ref('cancel-order'), sequence: 2 });
    await expect(f.client.executeOperation({ ...f.command('bad', { expectedVersion: '"v3"' }), compensates: 'gated' })).rejects.toMatchObject({ code: 'EFFECT_INVALID' });
  } finally { await stopTestRuntimeService(f.service); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses a denied request, a policy without a grant and another company\'s scope with typed codes and sends nothing (C12 G4)', async () => {
  const f = await fixture();
  try {
    const pending = await f.client.executeOperation(f.command('denied'));
    if (pending.status !== 'approval-pending') throw new Error(pending.status);
    await decide(f.client, pending.approval.approvalId, 'deny-denied', 'deny');
    await expect(f.client.executeOperation(f.command('denied'))).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    expect(f.rows('effect_intents', 'denied')).toEqual([]); expect(f.server.operations).toHaveLength(0);
    // No execute grant: refused before any ledger access, no request is opened.
    await f.policy('inspect-only');
    const before = f.rows('approvals').length;
    await expect(f.client.executeOperation(f.command('no-grant'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.rows('approvals')).toHaveLength(before); expect(f.server.operations).toHaveLength(0);
    // A scope pinned to another company is indistinguishable from an unknown one: the code only, no parameters on the wire. Declared
    // and pinned only now, with the service already running: a scope that grows foreign after a clean start is the ordinary
    // per-request fail-closed path every port already covers (decision 6 above refuses only an already-foreign scope AT START).
    await f.policy('allow', ['s', 'foreign']);
    f.pin('foreign', 'other-company');
    const foreign = await f.client.executeOperation(f.command('foreign', { scopeId: 'foreign' })).then(() => null, (error: { code?: string; params?: unknown }) => error);
    expect(foreign).toMatchObject({ code: 'SCOPE_UNKNOWN' }); expect(Object.keys(foreign?.params ?? {})).toEqual([]);
    expect(`${String((foreign as unknown as Error).message)} ${JSON.stringify(foreign)}`).not.toContain('other-company');
    await expect(f.client.inspectOperation({ schemaVersion: 1, scopeId: 'foreign', commandId: 'foreign' })).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
    expect(f.rows('effect_intents', 'foreign')).toEqual([]); expect(f.server.operations).toHaveLength(0);
    // Allowed outright: settles without any approval request.
    expect(await f.client.executeOperation(f.command('open'))).toMatchObject({ status: 'settled', sequence: 1 });
    expect(f.rows('approvals')).toHaveLength(before);
  } finally { await stopTestRuntimeService(f.service); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses a released v15 envelope for the operation before dispatch, and bounds an inspected record by the delivery (protocol v16)', async () => {
  const f = await fixture({ responseMaxBytes: 1024 });
  try {
    await f.policy('allow');
    const socket = new Socket({ allowHalfOpen: true });
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.connect(f.service.endpoint, () => resolve()); });
    let answer = '';
    socket.on('data', chunk => { answer += String(chunk); });
    socket.end(encodeServiceFrame({ schemaVersion: 15, requestId: 'v15-op', operation: 'executeOperation', input: f.command('v15'),
      delivery: { maxResultBytes: 512 } }, 65536));
    await once(socket, 'close');
    // Closed unanswered: the client sees the typed transport failure; nothing ran.
    expect(answer).toBe(''); expect(f.rows('effect_intents', 'v15')).toEqual([]); expect(f.server.operations).toHaveLength(0);
    // An input larger than the delivery: the settled outcome fits, the inspected record (carrying the input) is a typed limit.
    const large = f.command('large', { input: { note: 'x'.repeat(2048) } });
    expect(await f.client.executeOperation(large)).toMatchObject({ status: 'settled' });
    await expect(f.client.inspectOperation({ schemaVersion: 1, scopeId: 's', commandId: 'large' })).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_RESPONSE_LIMIT' });
  } finally { await stopTestRuntimeService(f.service); }
});
