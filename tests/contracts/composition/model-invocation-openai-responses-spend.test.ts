import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from '#adapters/core/provider-http-json/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteProviderSpendIntegrityReader, readLocalOsIdentity } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, createModelInvocationResponseEvidence, modelInvocationTargetId, verifyProviderSpendIntegrity } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';
import { responsesFixture, responsesFinal, responsesCreated, responsesUsage, event, toolStream } from '../support/openai-responses.js';

// Real policy, activation, reservation and SQLite settlement; only HTTP is synthetic. No live settings, key, socket or paid call.
const roots: string[] = [];
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(wire: string, status = 200) {
  let calls = 0;
  vi.spyOn(http, 'sendNativeJsonHttp').mockImplementation(async (request, options) => {
    calls++;
    const reject = (reason: 'http-status' | 'invalid-response' | 'model-mismatch' | 'response-limit' | 'interrupted') => ({ kind: 'rejected' as const,
      evidence: createModelInvocationResponseEvidence(request.adapter, reason, status, Buffer.from(wire), reason !== 'interrupted') });
    if (status !== 200) return reject('http-status');
    const pushed = options.stream!.push(Buffer.from(wire));
    for (const delta of pushed.deltas) options.onDelta?.(delta);
    if (pushed.rejected) return reject(pushed.rejected);
    if (pushed.limit) return reject('response-limit');
    const result = options.stream!.finish(); return 'reason' in result ? reject(result.reason) : result.response;
  });
  const root = await mkdtemp(join(tmpdir(), 'deckent-responses-spend-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(data), mkdir(home)]);
  const f = responsesFixture('http://127.0.0.1:1/v1/responses');
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ ...f.definition.provider, models: [f.definition.model] }] };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(f.definition as never)).digest('hex') };
  const profile = { ...f.profile, bindingDigest: binding.digest, allocation: { ...f.profile.allocation, maxCalls: 3, maxInFlight: 2 } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    provider_spending: { schemaVersion: 1, budgets: [{ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 1000 }] } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const principal = { ...readLocalOsIdentity(), scopeIds: ['scope'] };
  const activation = new ModelActivationApplication({ async verify() { return principal; } }, { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } },
    new ModelBindingApplication({ async read() { return catalog as never; } }), async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  await activation.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference: f.profile.reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants: [{
    id: 'invoke', effect: 'allow', actions: ['invoke'], scopes: ['scope'], principals: [{ issuer: principal.issuer, subject: principal.subject }],
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(f.profile.reference)] } }] }), { mode: 0o600 });
  return { project, ledger, command: { ...f.command, expectedBinding: binding }, calls: () => calls,
    options: { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } } };
}
async function spendOf(f: Awaited<ReturnType<typeof fixture>>, invocationId: string) {
  const reader = await openSqliteModelInvocationReader(f.ledger, { busyTimeoutMs: 1000 });
  let inspection;
  try { inspection = await reader.loadInspection('scope', invocationId); } finally { reader.close(); }
  const spend = await openSqliteProviderSpendIntegrityReader(f.ledger, { busyTimeoutMs: 1000 });
  try { return { inspection, integrity: await verifyProviderSpendIntegrity(spend, 'scope', 10) }; } finally { spend.close(); }
}
describe.skipIf(process.platform === 'win32')('Responses through the existing governed invocation and durable spend ledger', () => {
  it.each([['text', event('response.completed', 1, { response: responsesFinal() })], ['tools and reasoning', toolStream().join('')]])(
    'settles %s exactly once, preserves replay and records separate reasoning without double billing', async (_name, wire) => {
      const f = await fixture(wire), result = await invokeConfiguredModel(f.project, f.command as never, f.options);
      expect(result.receipt.outcome?.state).toBe('responded');
      const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
      expect(inspection?.spending).toMatchObject({ disposition: { state: 'settled-measured-tariff' }, measurement: { exactMinorUnits: '0.024',
        source: { dimensions: [{ field: 'input', tokens: 60 }, { field: 'cached-input', tokens: 40 }, { field: 'output', tokens: 4 }, { field: 'reasoning', tokens: 6 }] } } });
      expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: 0, checkpoint: { account: { settledExactMinorUnits: '0.024', frozen: false } } });
      const replay = await invokeConfiguredModel(f.project, f.command as never, f.options);
      expect(replay.receipt.claim.invocationId).toBe(result.receipt.claim.invocationId); expect(f.calls()).toBe(1);
      expect((await spendOf(f, result.receipt.claim.invocationId)).integrity.checkpoint.account.settledExactMinorUnits).toBe('0.024');
    });
  it.each([
    ['interim usage and cut', responsesCreated({ usage: responsesUsage() })],
    ['cut tool arguments', toolStream().slice(0, -1).join('')],
    ['contradictory terminal', event('response.completed', 1, { response: responsesFinal() }) + event('response.completed', 2, { response: responsesFinal() })],
    ['truncated contradictory tail', event('response.completed', 1, { response: responsesFinal() }) + 'data: {'],
  ])('holds the reservation for %s, never inventing final usage', async (_name, wire) => {
    const f = await fixture(wire), result = await invokeConfiguredModel(f.project, f.command as never, f.options);
    expect(result.receipt.outcome?.state).not.toBe('responded');
    const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
    expect(inspection?.spending).toMatchObject({ disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null }, measurement: null });
    const maximum = inspection!.spending!.descriptor.quote.maxChargeMinorUnits;
    expect(maximum).toBeGreaterThan(0);
    expect(integrity).toMatchObject({ reservationCount: 1, reservedMinorUnits: maximum, settledMinorUnits: 0 });
  });
  it('records HTTP400 without measured settlement or a second effect flow', async () => {
    const f = await fixture(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Use /v1/responses' } }), 400);
    const result = await invokeConfiguredModel(f.project, f.command as never, f.options);
    expect(result.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { httpStatus: 400, adapter: { version: 6 } } });
    const { inspection, integrity } = await spendOf(f, result.receipt.claim.invocationId);
    expect(inspection?.spending?.measurement).toBeNull(); expect(integrity.settledMinorUnits).toBe(0);
  });
});
