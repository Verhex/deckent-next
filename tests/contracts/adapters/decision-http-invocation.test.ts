import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition, parseModelBindingDefinition, parseModelInvocationProfile } from '#domain/index.js';
import { ModelInvocationApplication } from '#engine/core/model-invocation/index.js';
import { openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';
import { openSqliteModelInvocationStore } from '#adapters/core/sqlite-model-invocation/index.js';
import { createDecisionHttpNativePort, decisionHttpAdapter, quoteDecisionHttpOperatorTariff } from '#adapters/core/provider-decision-http/index.js';

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(async server => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const sqlite = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = parseModelBindingDefinition({ encodingVersion: 1, provider: { id: 'provider', version: 1 }, model: { id: 'model', version: 1, nativeId: 'configured-model',
  protocols: [{ ...decisionHttpAdapter.protocol, capabilities: [] }] } });
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const principal = { id: 'actor', issuer: 'test', subject: '1', assurance: 'os-user' as const, scopeIds: ['scope'] };
const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance };
const authorization = { revision: 'policy', ruleId: 'invoke' };
const command = { schemaVersion: 1, commandId: 'ask-command', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
  nativeRequest: { schemaVersion: 1, case: { schemaVersion: 1, objective: 'Choose safe action', scope: 'scope', revision: 'revision', constraints: [], unknowns: [],
    evidence: [{ id: 'e', source: 'fixture', observedAt: '2026-10-01T00:00:00.000Z', observation: 'Action verified' }],
    options: [{ id: 'a', action: 'Action a', tradeoffs: [], evidenceIds: ['e'] }], checks: [],
    process: { stage: 'review', currentState: 'prepared', acceptedDecisions: [], nextStep: 'Actor selects', reopenReason: null } } } };
async function fixture(lostOutcome = false) {
  let requests = 0; const server = createServer((_req, res) => { requests++; res.end(JSON.stringify({ model: 'resolved-revision',
    answers: { selection: { type: 'choice', choice: 'a', probabilities: { a: .9, none_of_the_above: .05, insufficient_information: .05 }, confidence: .8 }, sufficiency: { type: 'noul', noul: .9 } },
    usage: { input_tokens: 10, output_tokens: 5 } })); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  const root = await mkdtemp(join(tmpdir(), 'deckent-decision-invocation-')); roots.push(root); const path = join(root, 'ledger.db');
  const activations = await openSqliteModelActivationStore(path, sqlite);
  const admitted = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor, authorization, admittedAtMs: 1, definition }); activations.close();
  const seed = await openSqliteModelInvocationStore(path, sqlite, 'forbid'); seed.close();
  if (lostOutcome) { const db = new DatabaseSync(path); db.exec("CREATE TRIGGER reject_decision_response BEFORE UPDATE ON model_invocations BEGIN SELECT RAISE(ABORT,'fixture lost outcome'); END;"); db.close(); }
  const profile = parseModelInvocationProfile({ schemaVersion: 1, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: decisionHttpAdapter.protocol, adapter: { id: decisionHttpAdapter.id, version: decisionHttpAdapter.version,
      definition: { endpoint: `http://127.0.0.1:${address.port}/`, authentication: { type: 'none' },
        tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } } },
    allocation: { id: 'allocation', maxCalls: 1, maxInFlight: 1 }, limits: { requestMaxBytes: 16_384, responseMaxBytes: 16_384, timeoutMs: 5000 } });
  const app = new ModelInvocationApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } },
    { async inspect() { return { schemaVersion: 1, reference, status: 'declared', catalogRevision: 'catalog', definition, binding, availability: 'not-observed' }; } },
    async () => ({ async loadRecord() { return admitted.receipt.record; }, close() {} }), { async resolve() { return profile; } },
    { resolve() { return createDecisionHttpNativePort(); } }, async () => openSqliteModelInvocationStore(path, sqlite, 'forbid'),
    { invocationId: () => 'invocation', ownerId: () => 'owner', now: () => 10 }, { async authorize(input) {
      return { budget: { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100 }, quote: quoteDecisionHttpOperatorTariff(input) };
    } });
  return { app, path, requests: () => requests };
}
function allocations(path: string) { const db = new DatabaseSync(path, { readOnly: true }); try {
  return db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get();
} finally { db.close(); } }

it('uses activation, profile, allocation, spending and durable invocation receipt for one adapter request and its replay', async () => {
  const f = await fixture(); const first = await f.app.invoke(command);
  expect(first).toMatchObject({ replayed: false, receipt: { actor, profile: { adapter: { id: decisionHttpAdapter.id } }, outcome: { state: 'responded' } },
    response: { native: { decisionAdvice: { choice: 'a', sufficiency: .9, probabilities: { none_of_the_above: .05, insufficient_information: .05 } } } } });
  expect(await f.app.invoke(command)).toEqual({ ...first, replayed: true }); expect(f.requests()).toBe(1); expect(allocations(f.path)).toMatchObject({ lifetime_calls: 1, in_flight: 0 });
  // This authority supplies a budget, so the zero tariff is reserved and settled at zero (only a budget-less local exemption skips money rows).
  const db = new DatabaseSync(f.path, { readOnly: true }); try { const row = db.prepare('SELECT record FROM model_invocation_spend_reservations').get();
    expect(JSON.parse(String(row?.record))).toMatchObject({ disposition: { state: 'settled-local', amountMinorUnits: 0 } });
  } finally { db.close(); }
});

it('keeps the durable pending claim after an observed response cannot be recorded and never repeats the paid-capable transport', async () => {
  const f = await fixture(true); await expect(f.app.invoke(command)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_OUTCOME_UNKNOWN' });
  const replay = await f.app.invoke(command); expect(replay).toMatchObject({ replayed: true, receipt: { outcome: null }, response: null });
  expect(f.requests()).toBe(1); expect(allocations(f.path)).toMatchObject({ lifetime_calls: 1, in_flight: 1 });
});
