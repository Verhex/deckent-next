import { createHash } from 'node:crypto';
import { hostname, tmpdir, userInfo } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { configuredApproval, createConfiguredRuntimeClient } from '../../../src/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore } from '#adapters/index.js';
import { z } from 'zod';
import { approvalRecordSchema, approvalRequestSchema } from '#domain/index.js';
import { RUNTIME_SERVICE_SCHEMA_VERSION, approvalSubjectsHiddenFromProtocol, requestTaskApproval, sealApproval } from '#engine/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { startTestRuntimeService, stopTestRuntimeService } from '../support/runtime-service.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sqlite = { busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const };

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), 'dk-approval-protocol-')); roots.push(project);
  await mkdir(join(project, '.deckent'), { recursive: true }); const env = { HOME: join(project, 'h') };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(project, 'd') }, admission: {
    poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']) },
  cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
  cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
  service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'p1', restrictions: [], grants: [
    { id: 'approvals', effect: 'allow', actions: 'all', scopes: ['s'], principals, resource: { kind: 'approval', ids: 'all' } },
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } }] }), { mode: 0o600 });
  // Seed one approval of each subject kind as the producers would (task admission, agent tool call, catalog operation).
  const integrity = await openLocalIntegrityAuthority(opened.layout, 'authority.key', true);
  const journal = openSqliteApprovalStore(opened.path, sqlite);
  const requester = { id: 'owner', issuer: hostname(), subject: String(userInfo().uid) }, now = Date.now();
  const task = requestTaskApproval(journal.store, integrity, { scopeId: 's', runId: 'run', taskId: 'a', requester, actionDigest: digest('task'),
    policyRevision: 'p1', summary: 'a', createdAt: now, expiresAt: now + 600_000 });
  const call = journal.store.create(sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 2, approvalId: 'tool-call', scopeId: 's',
    subject: { kind: 'agent-tool-call', turnId: 'turn', round: 1, index: 0, tool: 'edit_file', toolVersion: 1, resource: 'src/a.ts', argsDigest: digest('args') },
    requester, actionDigest: digest('call'), policyRevision: 'p1', summary: 'edit_file · src/a.ts', createdAt: now, expiresAt: now + 600_000 }),
  revision: 0, status: 'pending', decision: null }, integrity));
  const operation = journal.store.create(sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 2, approvalId: 'operation', scopeId: 's',
    subject: { kind: 'operation', operation: { id: 'post-order', version: 1 }, target: { kind: 'records', id: 'PO-1' }, commandId: 'cmd', inputDigest: digest('input'),
      targetBinding: digest('binding'), expectedVersion: '"v1"', compensates: null },
    requester, actionDigest: digest('operation'), policyRevision: 'p1', summary: 'post-order@1 · records/PO-1', createdAt: now, expiresAt: now + 600_000 }),
  revision: 0, status: 'pending', decision: null }, integrity));
  journal.close();
  return { project, env, task, call, operation };
}

// Protocol v15 (T-L5 lane, owner 2026-09-27 v15 package) activated C12 G4 visibility: OPERATION_SUBJECT_PROTOCOL_VERSION is 15 (a
// threshold; v16 and v17 keep it), so a current runtime client receives operation-subject approvals. A released v14 client can no longer reach approval operations at all
// (every non-lifecycle operation is current-version only, socket.test.ts); the v14 view below is kept as the engine contract.
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] delivers operation-subject approvals to a v15 runtime client in the record shape the terminal parses, as the in-process SDK sees them (C12 G4)', async () => {
  expect(RUNTIME_SERVICE_SCHEMA_VERSION).toBe(20);
  expect(approvalSubjectsHiddenFromProtocol(14)).toEqual(['operation']);
  expect(approvalSubjectsHiddenFromProtocol(15)).toEqual([]);
  const f = await fixture();
  const service = await startTestRuntimeService(f.project, f.env);
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    const query = { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 };
    const listed = await client.listApprovals(query) as { request: { approvalId: string; subject?: { kind: string } } }[];
    expect(listed.map(record => record.request.approvalId).sort()).toEqual([f.task.request.approvalId, 'operation', 'tool-call'].sort());
    // The terminal's /approvals page parser (terminal-ledger) accepts every record v15 delivers.
    expect(() => z.array(approvalRecordSchema).parse(listed)).not.toThrow();
    // Service start closed the orphaned tool-call approval as expired (C12 sweep); the operation approval is not a turn's and stays pending.
    expect(await client.inspectApproval({ schemaVersion: 1, scopeId: 's', approvalId: 'tool-call' })).toMatchObject({ request: f.call.request, status: 'expired' });
    expect(await client.inspectApproval({ schemaVersion: 1, scopeId: 's', approvalId: 'operation' })).toEqual(f.operation);
    const sdk = await configuredApproval(f.project, 'list', query, { env: f.env }) as { request: { approvalId: string } }[];
    expect(sdk.map(record => record.request.approvalId).sort()).toEqual(listed.map(record => record.request.approvalId).sort());
    const decided = await client.decideApproval({ schemaVersion: 1, scopeId: 's', approvalId: 'operation', commandId: 'allow-operation', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' }) as { status: string };
    expect(decided).toMatchObject({ status: 'decided', decision: { decision: 'allow' } });
  } finally { await stopTestRuntimeService(service); }
});

it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] pages a hidden-subject view over visible approvals only: a page never comes back empty because of a hidden operation approval (Astra 2128)', async () => {
  const f = await fixture();
  const service = await startTestRuntimeService(f.project, f.env);
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    // Ids order: <task uuid> | 'operation' | 'tool-call'. After 'n' the full page of one is the operation approval (SDK and v15 client);
    // the page of one of a view that hides operation subjects (the released-v14 view) is the next visible record, never an empty page.
    const query = { schemaVersion: 1, scopeId: 's', afterId: 'n', limit: 1 };
    const hidden = { excludeSubjects: approvalSubjectsHiddenFromProtocol(14) };
    const sdk = await configuredApproval(f.project, 'list', query, { env: f.env }) as { request: { approvalId: string } }[];
    expect(sdk.map(record => record.request.approvalId)).toEqual(['operation']);
    expect((await client.listApprovals(query) as { request: { approvalId: string } }[]).map(record => record.request.approvalId)).toEqual(['operation']);
    const page = await configuredApproval(f.project, 'list', query, { env: f.env }, undefined, undefined, hidden) as { request: { approvalId: string } }[];
    expect(page.map(record => record.request.approvalId)).toEqual(['tool-call']);
    // Walking the whole scope one record at a time visits every visible approval exactly once and ends on an empty page.
    const walked: string[] = []; let afterId: string | null = null;
    for (;;) {
      const next = await configuredApproval(f.project, 'list', { ...query, afterId }, { env: f.env }, undefined, undefined, hidden) as { request: { approvalId: string } }[];
      if (!next.length) break;
      walked.push(...next.map(record => record.request.approvalId)); afterId = next.at(-1)!.request.approvalId;
    }
    expect(walked).toEqual([f.task.request.approvalId, 'tool-call'].sort());
  } finally { await stopTestRuntimeService(service); }
});

// POLICY-HARDEN K3 at the runtime service: the peer behind the runtime SDK (same uid) cannot allow an approval of an authority-surface
// operation (`policy.administer@1`); the request stays pending. A deny is still accepted. The code is registered, so the client sees it as is.
it.skipIf(process.platform !== 'linux')('[requires Linux local runtime socket] refuses an allow of a policy.administer approval from a runtime client (direct runtime SDK); the record stays pending', async () => {
  const f = await fixture();
  const layout = (await openConfiguredAttemptStore(f.project, { env: f.env }).then(opened => { opened.store.close(); return opened; }));
  const integrity = await openLocalIntegrityAuthority(layout.layout, 'authority.key', true);
  const journal = openSqliteApprovalStore(layout.path, sqlite);
  const requester = { id: 'owner', issuer: hostname(), subject: String(userInfo().uid) }, now = Date.now();
  const seed = (approvalId: string) => journal.store.create(sealApproval({ request: approvalRequestSchema.parse({ schemaVersion: 2, approvalId, scopeId: 's',
    subject: { kind: 'operation', operation: { id: 'policy.administer', version: 1 }, target: { kind: 'authority-document', id: 'installation' }, commandId: `cmd-${approvalId}`,
      inputDigest: digest(approvalId), targetBinding: digest('binding'), expectedVersion: 'p1', compensates: null },
    requester, actionDigest: digest(`authority-${approvalId}`), policyRevision: 'p1', summary: 'policy.administer@1 · 1 change\n+ grant g: allow', createdAt: now, expiresAt: now + 600_000 }),
  revision: 0, status: 'pending', decision: null }, integrity));
  seed('authority-a'); seed('authority-b'); journal.close();
  const service = await startTestRuntimeService(f.project, f.env);
  try {
    const client = createConfiguredRuntimeClient(f.project, { env: f.env });
    const decide = (approvalId: string, decision: 'allow' | 'deny') => client.decideApproval({ schemaVersion: 1, scopeId: 's', approvalId, commandId: `${decision}-${approvalId}`,
      expectedRevision: 0, decision, reason: 'Reviewed' });
    await expect(decide('authority-a', 'allow')).rejects.toMatchObject({ code: 'APPROVAL_SURFACE_RESTRICTED' });
    expect(await client.inspectApproval({ schemaVersion: 1, scopeId: 's', approvalId: 'authority-a' })).toMatchObject({ status: 'pending', decision: null });
    await expect(decide('authority-b', 'deny')).resolves.toMatchObject({ status: 'decided', decision: { decision: 'deny' } });
    // An ordinary operation approval is still decidable on the same surface.
    await expect(decide('operation', 'allow')).resolves.toMatchObject({ status: 'decided' });
  } finally { await stopTestRuntimeService(service); }
});
