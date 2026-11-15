import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { notifyNativeBuiltinPlugins } from '#composition/core/model-invocation/index.js';
import { ModelInvocationApplication, createModelInvocationPlanUsage, type ModelInvocationNativePort } from '#engine/core/model-invocation/index.js';
import { openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';
import { bindCapacityResource, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { headlessCapacityBinding, openSqliteModelInvocationStore } from '#adapters/core/sqlite-model-invocation/index.js';
import { createNativeCliHeadlessPort, isNativeCliHeadlessAdapter, NATIVE_CLI_HEADLESS_ADAPTER } from '#adapters/core/native-cli-headless/index.js';
import { bubblewrapObservation } from '#adapters/index.js';
import { binding as definition, cleanupConnections, connection, request, testIsolation } from '../../fixtures/native-headless/connection.js';
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
async function fixture(lines = steps('{"ok":true}'), isolation = testIsolation, onAdmitted = () => {}, bound = true, native?: ModelInvocationNativePort, observed?: { timeoutMs: number; onPaidUsage: () => Promise<void> }) {
  const c = await connection({ steps: lines }, {}, expectedBinding.digest, isolation), path = join(c.root, 'ledger.db');
  if (observed) {
    c.profile = { ...c.profile, limits: { ...c.profile.limits, timeoutMs: observed.timeoutMs } };
    c.port = createNativeCliHeadlessPort({ now: Date.now, isolation, paidExtraUsage: 'continue', onPaidUsage: observed.onPaidUsage });
  }
  const activations = await openSqliteModelActivationStore(path, sqlite);
  const admitted = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding }, actor, authorization, admittedAtMs: 1, definition }); activations.close();
  const resources = openSqliteLedger(path, sqlite, 'forbid');
  try { if (bound) bindCapacityResource(resources, headlessCapacityBinding(c.profile.adapter.definition), { executionSlots: c.profile.allocation.maxInFlight, inFlightSlots: c.profile.allocation.maxInFlight }); } finally { resources.close(); }
  // The registry shape the composition uses: resolve gives the headless port, admit (the credential-source decision) runs its preflight before any claim.
  const app = new ModelInvocationApplication({ async verify() { return principal; } }, { async authorize() { return authorization; } },
    { async inspect() { return { schemaVersion: 1, reference, status: 'declared', catalogRevision: 'catalog', definition, binding: expectedBinding, availability: 'not-observed' }; } },
    async () => ({ async loadRecord() { return admitted.receipt.record; }, close() {} }), { async resolve() { return c.profile; } },
    { resolve() { return native ?? c.port; }, async admit(profile, signal) { if (!native) await c.port.preflight(profile, signal); onAdmitted(); } },
    async () => openSqliteModelInvocationStore(path, sqlite, 'forbid'), { invocationId: () => 'invocation', ownerId: () => 'owner', now: () => 10 });
  const command = { schemaVersion: 1, commandId: 'plan-1', scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding, nativeRequest: request() };
  return { c, app, path, command };
}
const calls = async (c: Awaited<ReturnType<typeof connection>>) => (await c.log()).filter(entry => entry.mode === 'call').length;

it('retains an unseen builtin and CLI version once in invocation evidence and notifies once without persistent deduplication', async () => {
  // Guard provenance is exercised through both real guards in native-cli-headless-registry. Only CLI I/O is substituted here.
  let sends = 0;
  const native: ModelInvocationNativePort = { billingAxis: 'subscription', async prepare() { return {}; }, async send() {
    sends++;
    return { schemaVersion: 1, native: { object: 'chat.completion', model: definition.model.nativeId,
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      headless: { cliVersion: '2.1.322', builtinPlugins: ['cc-plugin-unseen'] } },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  } };
  const { app, command, path } = await fixture(undefined, testIsolation, () => {}, true, native);
  const first = await app.invoke(command), notices: string[] = [], session = {};
  const notify = (result: typeof first) => notifyNativeBuiltinPlugins(result, 'en', session, 'terminal', text => { notices.push(text); });
  await notify(first); await notify(first); await notify(await app.invoke(command));
  expect(sends).toBe(1);
  expect(notices).toEqual(['[deckent] Claude CLI 2.1.322 loaded a new built-in plugin: cc-plugin-unseen. Nothing was blocked; this observation is recorded with the turn.']);
  const store = await openSqliteModelInvocationStore(path, sqlite, 'forbid');
  try { expect((await store.loadReceipt('scope', command.commandId))?.content).toMatchObject({ kind: 'native-response',
    response: { native: { headless: { cliVersion: '2.1.322', builtinPlugins: ['cc-plugin-unseen'] } } } }); }
  finally { store.close(); }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare('SELECT count(*) AS n FROM model_invocation_contents').get()?.n).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM audit_counters WHERE counter LIKE 'native-builtin:%'").get()?.n).toBe(0);
  } finally { db.close(); }
});
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
it.skipIf(!sandbox)('records an in-run guard refusal as a rejected receipt with the typed body, and a preflight refusal before any claim; unreported per-model counters stay absent', async () => {
  const guarded = await fixture([{ line: initLine({ apiKeySource: 'ANTHROPIC_API_KEY' }) }, { line: resultLine('x') }]);
  const rejected = await guarded.app.invoke(guarded.command);
  expect(rejected).toMatchObject({ receipt: { outcome: { state: 'rejected', evidence: { reason: 'invalid-response' } } } });
  const refused = await fixture(); await refused.c.write({ auth: { loggedIn: false } });
  await expect(refused.app.invoke(refused.command)).rejects.toMatchObject({ code: 'HEADLESS_LOGIN_REQUIRED' });
  const db = new DatabaseSync(refused.path, { readOnly: true });
  try { expect(db.prepare('SELECT COUNT(*) AS n FROM model_invocations').get()).toMatchObject({ n: 0 }); } finally { db.close(); }
  // 1b: a CLI that ends before a complete turn, and a typed refusal thrown after the claim (the realm gone between admit and send), are incomplete
  // evidence on an unknown receipt: the ledger's unknown reason stays transport-error (v73), the exit or the typed code is kept, never a message.
  const exited = await fixture([{ line: initLine() }, { exit: 2 }]);
  expect(await exited.app.invoke(exited.command)).toMatchObject({ receipt: { outcome: { state: 'unknown', reason: 'transport-error', evidence: { reason: 'interrupted', body: { complete: false } } } } });
  let gone = false;
  const typed = await fixture(steps('x'), async () => gone ? bubblewrapObservation('unavailable', 'no bubblewrap launcher') : testIsolation(), () => { gone = true; });
  expect(await typed.app.invoke(typed.command)).toMatchObject({ receipt: { outcome: { state: 'unknown', reason: 'transport-error', evidence: { adapter: { id: 'native-cli-headless' }, reason: 'interrupted' } } } });
  const store = await openSqliteModelInvocationStore(typed.path, sqlite, 'forbid');
  try { expect((await store.loadReceipt('scope', 'plan-1'))?.content).toMatchObject({ kind: 'response-body', data: Buffer.from(JSON.stringify({ code: 'HEADLESS_ISOLATION_UNAVAILABLE' })).toString('base64') }); } finally { store.close(); }
  // Astra 2850 R4: valid top counters with empty or invalid per-model counters answer, but no per-model zero is reported or persisted.
  for (const counters of [{}, { inputTokens: 2, outputTokens: '9', cacheReadInputTokens: 584, cacheCreationInputTokens: 0 }]) {
    const { app, path, command } = await fixture([uiLine(), initLine(), assistantLine('x'), rateLimitLine(), resultLine('x', { modelUsage: { [definition.model.nativeId]: counters } })].map(line => ({ line })));
    expect(await app.invoke(command)).toMatchObject({ receipt: { outcome: { state: 'responded' } }, response: { usage: { prompt_tokens: 586, modelUsage: { [definition.model.nativeId]: {} } } } });
    const ledger = new DatabaseSync(path, { readOnly: true });
    try {
      const usage = JSON.parse(String(ledger.prepare('SELECT record FROM model_invocation_plan_usage').get()?.record));
      expect(usage).toMatchObject({ source: 'provider-reported', counters: { prompt_tokens: 586, completion_tokens: 9 } }); expect(usage.counters).not.toHaveProperty('modelUsage');
    } finally { ledger.close(); }
  }
});
it.skipIf(!sandbox)('N22: only this exact adapter id and version select the headless branch; any other version stays unavailable, as alpha.54 resolves this id', () => {
  expect(isNativeCliHeadlessAdapter(NATIVE_CLI_HEADLESS_ADAPTER)).toBe(true);
  for (const adapter of [{ ...NATIVE_CLI_HEADLESS_ADAPTER, version: 2 }, { id: 'native-cli-headless-next', version: 1 }]) expect(isNativeCliHeadlessAdapter(adapter)).toBe(false);
});

it.skipIf(!sandbox)('invokes an alpha.62-shaped connection without a capacity binding and persists only resource metadata', async () => {
  const { c, app, path, command } = await fixture(steps('legacy-first-use'), testIsolation, () => {}, false);
  expect(c.profile.adapter.definition).not.toHaveProperty('sourceBinding');
  const before = JSON.stringify(c.profile);
  expect(await app.invoke(command)).toMatchObject({ receipt: { outcome: { state: 'responded' } },
    response: { native: { choices: [{ message: { content: 'legacy-first-use' } }] } } });
  expect(await calls(c)).toBe(1); expect(JSON.stringify(c.profile)).toBe(before);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare('SELECT count(*) AS n FROM capacity_resources').get()?.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM model_invocation_spend_reservations').get()?.n).toBe(0);
  } finally { db.close(); }
});

it.skipIf(!sandbox)('keeps v1 settlement bytes and current rejection bodies after unseen-plugin/paid input on response, guard, cancel and timeout', async () => {
  for (const end of ['responded', 'guard', 'cancel', 'timeout'] as const) {
    const controller = new AbortController(); let paid = false;
    const plugin = { name: 'fixture-unseen', path: 'builtin', source: 'fixture-unseen@builtin' };
    const prefix = [uiLine(), initLine({ plugins: [plugin] }), rateLimitLine('rejected', { isUsingOverage: true })].map(line => ({ line }));
    const tail = end === 'responded' ? [{ line: assistantLine('ok') }, { line: resultLine('ok') }]
      : end === 'guard' ? [{ line: { type: 'system', subtype: 'api_retry' } }] : [{ hang: true }];
    const f = await fixture([...prefix, ...tail], testIsolation, () => {}, true, undefined, { timeoutMs: end === 'timeout' ? 600 : 5000,
      async onPaidUsage() { paid = true; if (end === 'cancel') setTimeout(() => controller.abort(), 20); } });
    const result = await f.app.invoke(f.command, undefined, controller.signal);
    expect(paid).toBe(true);
    expect(result.receipt.outcome?.state).toBe(end === 'responded' ? 'responded' : end === 'guard' ? 'rejected' : 'unknown');
    const store = await openSqliteModelInvocationStore(f.path, sqlite, 'forbid');
    const record = (await store.loadInvocation('scope', 'invocation'))!; store.close();
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      const bytes = String(db.prepare('SELECT record FROM model_invocation_plan_usage').get()!.record);
      expect(bytes).toBe(JSON.stringify(createModelInvocationPlanUsage(record)));
      expect(JSON.parse(bytes).schemaVersion).toBe(1); expect(JSON.parse(bytes)).not.toHaveProperty('observation');
    } finally { db.close(); }
    if (record.content?.kind === 'response-body') {
      const body = JSON.parse(Buffer.from(record.content.data, 'base64').toString('utf8'));
      expect(JSON.stringify(body)).not.toContain('fixture-unseen'); expect(body).not.toHaveProperty('observation');
      expect(body.schemaVersion ?? 1).toBeLessThanOrEqual(5);
    }
  }
});
