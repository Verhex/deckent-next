import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteModelActivationStore, openSqliteModelAllocationIntegrityReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseModelInvocationControlRecord, parseProviderCatalog, resolveModelBindingDefinition, type ModelActivationRecord } from '#domain/index.js';
import { createModelAllocationCheckpoint, createModelInvocationClaimReceipt, modelInvocationProfileDigest, modelInvocationRequestDigest,
  parseModelAllocation, verifyModelAllocationIntegrity } from '#engine/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const scopeId = 'performance-scope', allocationId = 'performance-allocation';
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' } as const;

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

function profile() {
  return { schemaVersion: 1 as const, id: 'performance-profile', version: 1, scopeId, reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1, definition: {} },
    allocation: { id: allocationId, maxCalls: 20_100, maxInFlight: 20_100 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1_000 } };
}
function admission(activation: ModelActivationRecord, ordinal: number) {
  const command = { schemaVersion: 1 as const, commandId: `claim-${ordinal.toString().padStart(5, '0')}`, scopeId, reference,
    catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: `claim-${ordinal}` }] } };
  const configured = profile();
  return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization, definition, activation, profile: configured,
    profileDigest: modelInvocationProfileDigest(configured), invocationId: `invocation-${ordinal.toString().padStart(5, '0')}`, claimedAtMs: ordinal + 1 };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-allocation-performance-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const activationStore = await openSqliteModelActivationStore(path, options);
  try {
    const result = await activationStore.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId,
      reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
    authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
    return { path, activation: result.receipt.record };
  } finally { activationStore.close(); }
}

/** Inserts a schema-valid claimed history in one transaction; the timed work below is only store.claim. */
function seed(path: string, activation: ModelActivationRecord, history: number) {
  const db = new DatabaseSync(path);
  const allocation = parseModelAllocation({ schemaVersion: 1, scopeId, allocationId, maxCalls: 20_100, maxInFlight: 20_100,
    lifetimeCalls: history, inFlight: history });
  const checkpoint = createModelAllocationCheckpoint(allocation, 1);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`INSERT INTO model_invocation_allocations(scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record)
      VALUES(?,?,?,?,?,?,?)`).run(scopeId, allocationId, allocation.maxCalls, allocation.maxInFlight, allocation.lifetimeCalls, allocation.inFlight, JSON.stringify(allocation));
    db.prepare('INSERT INTO model_invocation_allocation_checkpoints(scope_id,allocation_id,revision,digest) VALUES(?,?,?,?)')
      .run(scopeId, allocationId, checkpoint.revision, checkpoint.digest);
    const invocation = db.prepare('INSERT INTO model_invocations(scope_id,command_id,invocation_id,allocation_id,state,record) VALUES(?,?,?,?,?,?)');
    const control = db.prepare('INSERT INTO model_invocation_controls(scope_id,invocation_id,send_state,record) VALUES(?,?,?,?)');
    for (let ordinal = 0; ordinal < history; ordinal += 1) {
      const receipt = createModelInvocationClaimReceipt(admission(activation, ordinal));
      const record = parseModelInvocationControlRecord({ schemaVersion: 1, claim: receipt.claim, reference: receipt.request.reference,
        send: { state: 'pending' }, cancellation: null });
      invocation.run(scopeId, receipt.claim.commandId, receipt.claim.invocationId, allocationId, 'claimed', JSON.stringify(receipt));
      control.run(scopeId, receipt.claim.invocationId, 'pending', JSON.stringify(record));
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

function percentile(values: readonly number[], ratio: number) {
  return values[Math.ceil(values.length * ratio) - 1]!;
}

it('reports descriptive actual claim timings for schema-valid allocation histories', async () => {
  const results: Array<{ history: number; samplesMs: number[]; medianMs: number; p95Ms: number }> = [];
  for (const history of [0, 100, 10_000]) {
    const base = await fixture(); seed(base.path, base.activation, history);
    const reader = await openSqliteModelAllocationIntegrityReader(base.path, { busyTimeoutMs: 20 });
    try {
      await expect(verifyModelAllocationIntegrity(reader, scopeId, allocationId, 1_000)).resolves.toMatchObject({ status: 'consistent', lifetimeCalls: history, inFlight: history });
    } finally { reader.close(); }
    const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
    try {
      const inputs = Array.from({ length: 12 }, (_, index) => admission(base.activation, history + index + 1));
      await store.claim(inputs[0]!); await store.claim(inputs[1]!);
      const samplesMs: number[] = [];
      for (const input of inputs.slice(2)) {
        const start = performance.now(); await store.claim(input); samplesMs.push(performance.now() - start);
      }
      samplesMs.sort((left, right) => left - right);
      expect(samplesMs).toHaveLength(10);
      expect(samplesMs.every(Number.isFinite)).toBe(true);
      results.push({ history, samplesMs, medianMs: percentile(samplesMs, 0.5), p95Ms: percentile(samplesMs, 0.95) });
    } finally { store.close(); }
  }
  process.stdout.write(`${JSON.stringify({ benchmark: 'sqlite-model-invocation-claim-allocation-history', ledgerVersion: CURRENT_LEDGER_VERSION,
    workload: 'one scope/allocation; schema-valid claimed receipt/control/allocation/checkpoint seed; audit before 2 warmup and 10 actual store.claim samples',
    warmupClaims: 2, samplesPerHistory: 10, results })}\n`);
}, 60_000);
