import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { ModelInvocationApplication } from '#engine/core/model-invocation/index.js';
import { openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';
import { openSqliteModelInvocationStore } from '#adapters/core/sqlite-model-invocation/index.js';
import { isNativeCliHeadlessAdapter, NATIVE_CLI_HEADLESS_ADAPTER } from '#adapters/core/native-cli-headless/index.js';
import { binding as definition, cleanupConnections, connection, request } from '../../fixtures/native-headless/connection.js';
import { assistantLine, initLine, rateLimitLine, resultLine, uiLine } from '../../fixtures/native-headless/stream.js';
import { measureTestShellHost } from '../../fixtures/shell-host.js';
const sandbox = (await measureTestShellHost()).bubblewrap.status === 'available';

afterEach(cleanupConnections);
const sqlite = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
const reference = { providerId: 'cli-subscription', providerVersion: 1, modelId: 'pinned', modelVersion: 1 };
const expectedBinding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const principal = { id: 'person', issuer: 'test', subject: '1', assurance: 'os-user' as const, scopeIds: ['scope'] };
const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance }, authorization = { revision: 'policy', ruleId: 'invoke' };
const steps = (text: string) => [uiLine(), initLine(), assistantLine(text), rateLimitLine(), resultLine(text)].map(line => ({ line }));
async function fixture(lines = steps('{"ok":true}')) {
  const c = await connection({ steps: lines }, {}, expectedBinding.digest), path = join(c.root, 'ledger.db');
  const activations = await openSqliteModelActivationStore(path, sqlite);
  const admitted = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding }, actor, authorization, admittedAtMs: 1, definition }); activations.close();
  (await openSqliteModelInvocationStore(path, sqlite, 'forbid')).close();
  // The registry shape the composition uses: resolve gives the headless port, admit (the credential-source decision) runs its preflight before any claim.
  const app = new ModelInvocationApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } },
    { async inspect() { return { schemaVersion: 1, reference, status: 'declared', catalogRevision: 'catalog', definition, binding: expectedBinding, availability: 'not-observed' }; } },
    async () => ({ async loadRecord() { return admitted.receipt.record; }, close() {} }), { async resolve() { return c.profile; } },
    { resolve() { return c.port; }, async admit(profile, signal) { await c.port.preflight(profile, signal); } },
    async () => openSqliteModelInvocationStore(path, sqlite, 'forbid'), { invocationId: () => 'invocation', ownerId: () => 'owner', now: () => 10 });
  const command = { schemaVersion: 1, commandId: 'plan-1', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding, nativeRequest: request() };
  return { c, app, path, command };
}
const calls = async (c: Awaited<ReturnType<typeof connection>>) => (await c.log()).filter(entry => entry.mode === 'call').length;

it.skipIf(!sandbox)('records a subscription receipt without money, replays it without a second spawn (N16), and keeps model and token counters after purge (N17)', async () => {
  const { c, app, path, command } = await fixture();
  const first = await app.invoke(command);
  expect(first).toMatchObject({ replayed: false, receipt: { profile: { billingAxis: 'subscription', adapter: { id: 'native-cli-headless' } }, outcome: { state: 'responded' } },
    response: { native: { choices: [{ message: { content: '{"ok":true}' } }] } } });
  expect(await app.invoke(command)).toEqual({ ...first, replayed: true });
  expect(await calls(c)).toBe(1);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_invocation_spend_reservations').get()).toMatchObject({ n: 0 });
    const usage = JSON.parse(String(db.prepare('SELECT record FROM model_invocation_plan_usage').get()?.record));
    expect(usage).toMatchObject({ source: 'provider-reported', counters: { prompt_tokens: 586, completion_tokens: 9, modelUsage: { [definition.model.nativeId]: { outputTokens: 9 } },
      quota: { five_hour: { utilizationPermille: 250, resetsAtMs: 1792773600000 } } } });
    expect(JSON.stringify(usage)).not.toMatch(/cost|usd/iu);
  } finally { db.close(); }
});
it.skipIf(!sandbox)('records an in-run guard refusal as a rejected receipt with the typed body, and a preflight refusal before any claim', async () => {
  const guarded = await fixture([{ line: initLine({ apiKeySource: 'ANTHROPIC_API_KEY' }) }, { line: resultLine('x') }]);
  const rejected = await guarded.app.invoke(guarded.command);
  expect(rejected).toMatchObject({ receipt: { outcome: { state: 'rejected', evidence: { reason: 'invalid-response' } } } });
  const refused = await fixture(); await refused.c.write({ auth: { loggedIn: false } });
  await expect(refused.app.invoke(refused.command)).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_REQUIRED' });
  const db = new DatabaseSync(refused.path, { readOnly: true });
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM model_invocations').get()).toMatchObject({ n: 0 }); } finally { db.close(); }
});
it.skipIf(!sandbox)('N22: only this exact adapter id and version select the headless branch; any other version stays unavailable, as alpha.54 resolves this id', () => {
  expect(isNativeCliHeadlessAdapter(NATIVE_CLI_HEADLESS_ADAPTER)).toBe(true);
  for (const adapter of [{ ...NATIVE_CLI_HEADLESS_ADAPTER, version: 2 }, { id: 'native-cli-headless-next', version: 1 }]) expect(isNativeCliHeadlessAdapter(adapter)).toBe(false);
});
