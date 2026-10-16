import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteLedger, openRuntimeObservationLedger } from '#adapters/index.js';
import { createRun } from '#domain/index.js';
import { createDefaultConfig } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'task', kind: 'fixture', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'CANARY_PROMPT', evaluator: { id: 'exit', version: 1 }, parameters: {} }] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dk-events-source-')); roots.push(root); const path = join(root, 'ledger.db');
  const opened = openSqliteLedger(path, sqlite); opened.close(); const writer = new DatabaseSync(path);
  const run = createRun({ scopeId: 'scope', runId: 'run', layoutRevision: 'layout' }, graph, 1, fixtureExecution(graph));
  const write = (revision: number, scope = 'scope', id = 'run') => writer.prepare('INSERT OR REPLACE INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)')
    .run(scope, id, revision, JSON.stringify({ ...run, identity: { ...run.identity, scopeId: scope, runId: id }, revision }), '{}');
  return { path, writer, write };
}
it('observes another connection without creating a publication journal or migrating and strips content at the adapter boundary', async () => {
  const f = await fixture(); const before = f.writer.prepare('PRAGMA user_version').get()?.user_version;
  f.write(0); f.write(0, 'foreign');
  const reader = openRuntimeObservationLedger(f.path, sqlite, { schemaVersion: 1, scopeId: 'scope', topics: ['run'], resume: null }, createDefaultConfig().service.events);
  try {
    const initial = reader.capture(100); expect(initial.rows).toHaveLength(1); expect(JSON.stringify(initial)).not.toContain('CANARY_PROMPT'); expect(JSON.stringify(initial)).not.toContain('foreign');
    f.write(2); expect(reader.capture(101).rows[0]?.record).toMatchObject({ id: 'run', revision: 2 });
    expect(f.writer.prepare('PRAGMA user_version').get()?.user_version).toBe(before);
    expect(f.writer.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%publication%'").all()).toEqual([]);
  } finally { reader.close(); f.writer.close(); }
});
it('refuses row and byte cap exhaustion explicitly instead of silently clipping the snapshot', async () => {
  const f = await fixture(); f.write(0); f.write(0, 'scope', 'another');
  for (const limits of [{ maxSnapshotRows: 1, readPageSize: 1 }, { maxSnapshotBytes: 10 }]) {
    const reader = openRuntimeObservationLedger(f.path, sqlite, { schemaVersion: 1, scopeId: 'scope', topics: ['run'], resume: null }, { ...createDefaultConfig().service.events, ...limits });
    try { expect(() => reader.capture(1)).toThrow(expect.objectContaining({ code: 'RUNTIME_EVENTS_TOO_LARGE' })); } finally { reader.close(); }
  }
  f.writer.close();
});
it('projects verified spend checkpoints and refuses a changed account whose checksum was not updated', async () => {
  const { createProviderSpendAccount, createProviderSpendCheckpoint } = await import('#engine/index.js');
  const f = await fixture(), account = createProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100 });
  const checkpoint = createProviderSpendCheckpoint(account, 1, 0);
  f.writer.prepare('INSERT INTO provider_spend_accounts(scope_id,revision,reservation_count,digest,record) VALUES(?,?,?,?,?)').run('scope', 1, 0, checkpoint.digest, JSON.stringify(account));
  const reader = openRuntimeObservationLedger(f.path, sqlite, { schemaVersion: 1, scopeId: 'scope', topics: ['usage'], resume: null }, createDefaultConfig().service.events);
  try {
    expect(reader.capture(1).rows[0]?.record).toMatchObject({ topic: 'usage', entity: 'account', currency: 'USD', usageBasis: 'account-checkpoint', settledMinorUnits: 0, reservedMinorUnits: 0 });
    f.writer.prepare('UPDATE provider_spend_accounts SET record=? WHERE scope_id=?').run(JSON.stringify({ ...account, reservedMinorUnits: 20 }), 'scope');
    expect(() => reader.capture(2)).toThrow(expect.objectContaining({ code: 'RUNTIME_EVENTS_UNAVAILABLE' }));
  } finally { reader.close(); f.writer.close(); }
});
it('verifies approval integrity, derives expiry without mutation and never emits summaries or tool arguments', async () => {
  const { sealApproval } = await import('#engine/index.js'); const { createHmacIntegrity } = await import('#platform/index.js');
  const f = await fixture(), integrity = createHmacIntegrity('fixture-key', Buffer.alloc(32, 1));
  const record = sealApproval({ request: { schemaVersion: 1, approvalId: 'approval', scopeId: 'scope', runId: 'run', taskId: 'task', requester: { id: 'actor', issuer: 'fixture', subject: 'actor' },
    actionDigest: 'a'.repeat(64), policyRevision: 'policy', summary: 'CANARY_COMMAND_AND_PROMPT', createdAt: 1, expiresAt: 10 }, revision: 0, status: 'pending', decision: null }, integrity);
  f.writer.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot) VALUES(?,?,?,?,?,?,?,?)').run('scope', 'approval', 'task', 'run', 'task', 'a'.repeat(64), 0, JSON.stringify(record));
  const reader = openRuntimeObservationLedger(f.path, sqlite, { schemaVersion: 1, scopeId: 'scope', topics: ['approval'], resume: null }, createDefaultConfig().service.events, integrity);
  try {
    const initial = reader.capture(2); expect(initial.rows[0]?.record.status).toBe('pending'); expect(JSON.stringify(initial)).not.toContain('CANARY');
    expect(reader.capture(11).rows[0]?.record.status).toBe('expired'); expect(JSON.parse(String(f.writer.prepare('SELECT snapshot FROM approvals').get()?.snapshot)).status).toBe('pending');
    f.writer.prepare('UPDATE approvals SET snapshot=?').run(JSON.stringify({ ...record, mac: 'b'.repeat(64) }));
    expect(() => reader.capture(12)).toThrow(expect.objectContaining({ code: 'RUNTIME_EVENTS_UNAVAILABLE' }));
  } finally { reader.close(); f.writer.close(); }
});
it('captures scoped activations and catalog metadata without transport, provider configuration or provenance', async () => {
  const { seedCatalog } = await import('../support/model-catalog.js'); const { parseProviderCatalogDocument } = await import('#domain/index.js');
  const seed = parseProviderCatalogDocument(await seedCatalog()), provider = seed.providers[0]!, model = provider.models[0]!;
  const f = await fixture(), channel = { schemaVersion: 1, channelId: provider.id, revision: 1, providerVersion: provider.version, channel: provider.channel, catalogRevision: seed.revision };
  const entry = { schemaVersion: 1, channelId: provider.id, modelId: model.nativeId, revision: 1, providerVersion: provider.version, model, catalogRevision: seed.revision };
  f.writer.prepare('INSERT INTO model_catalog_channels(channel_id,revision,record) VALUES(?,?,?)').run(provider.id, 1, JSON.stringify(channel));
  f.writer.prepare('INSERT INTO model_catalog_models(channel_id,model_id,revision,lifecycle,record) VALUES(?,?,?,?,?)').run(provider.id, model.nativeId, 1, 'active', JSON.stringify(entry));
  const reader = openRuntimeObservationLedger(f.path, sqlite, { schemaVersion: 1, scopeId: 'scope', topics: ['inventory'], resume: null }, createDefaultConfig().service.events);
  try {
    const captured = reader.capture(1); expect(captured.rows.map(row => row.record.entity)).toEqual(['catalog-channel', 'catalog-model']);
    expect(captured.rows[1]?.record).toMatchObject({ status: 'registered', providerId: provider.id, modelId: model.nativeId });
    expect(JSON.stringify(captured.rows.map(row => row.record))).not.toMatch(/provenance|protocolFamily|sourceUrl|endpoint/);
  } finally { reader.close(); f.writer.close(); }
});
