import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition } from '#domain/index.js';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { ModelActivationApplication, ModelBindingApplication, modelInvocationProfileDigest, modelInvocationRequestDigest,
  modelInvocationTargetId, type ModelInvocationInspection, type ProviderSpendReservation } from '#engine/index.js';
import { clearConfigCache, prepareProductFile, resolveProductLayout } from '#platform/index.js';

const execute = promisify(execFile), roots: string[] = [], children: ChildProcess[] = [];
const sdk = resolve('dist/index.js'), cli = resolve('dist/composition/core/cli/internal/entry.js');
const mcp = resolve('dist/composition/core/mcp/internal/entry.js');
const sqlite = { busyTimeoutMs: 1000, journalMode: 'delete' as const, durability: 'full' as const };
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 10_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function terminate(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await bounded(new Promise<void>(done => child.once('exit', () => done())), 'CHILD_EXIT_TIMEOUT');
  }
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(terminate)); clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const sdkProgram = `
import { pathToFileURL } from 'node:url';
const [entry,project,encoded]=process.argv.slice(1),api=await import(pathToFileURL(entry).href);
try { process.stdout.write(JSON.stringify({ok:true,value:await api.inspectModelInvocation(project,JSON.parse(encoded),{env:process.env})})); }
catch(error) { process.stdout.write(JSON.stringify({ok:false,code:error?.code??'UNKNOWN'})); }
`;
async function inspectSdk(project: string, env: Record<string, string>, query: unknown) {
  const result = await execute(process.execPath, ['--input-type=module', '-e', sdkProgram, sdk, project, JSON.stringify(query)],
    { cwd: project, env, timeout: 10_000, maxBuffer: 1_048_576 });
  return JSON.parse(result.stdout) as { ok: true; value: ModelInvocationInspection } | { ok: false; code: string };
}
async function inspectMcp(project: string, env: Record<string, string>, query: Record<string, unknown>) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp, '--project', project], env, stderr: 'pipe' });
  const client = new Client({ name: 'spending-inspection-proof', version: '1' });
  try {
    await bounded(client.connect(transport), 'MCP_CONNECT_TIMEOUT');
    return await bounded(client.callTool({ name: 'inspect_model_invocation', arguments: query }), 'MCP_CALL_TIMEOUT');
  } finally {
    await bounded(client.close(), 'MCP_CLIENT_CLOSE_TIMEOUT'); await bounded(transport.close(), 'MCP_TRANSPORT_CLOSE_TIMEOUT');
    expect(transport.pid).toBeNull();
  }
}
async function startRuntime(project: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); let output = '', errors = '';
  child.stderr!.on('data', chunk => { errors += String(chunk); });
  await bounded(new Promise<void>((done, reject) => {
    child.once('error', reject); child.once('exit', () => reject(new Error(`RUNTIME_EXIT:${errors}`)));
    child.stdout!.on('data', chunk => { output += String(chunk); const lines = output.split('\n'); output = lines.pop() ?? '';
      if (lines.some(line => { try { return JSON.parse(line).event === 'ready'; } catch { return false; } })) done(); });
  }), 'RUNTIME_READY_TIMEOUT');
}
function ledgerSnapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.stringify({ accounts: db.prepare('SELECT * FROM provider_spend_accounts ORDER BY scope_id').all(),
    reservations: db.prepare('SELECT * FROM model_invocation_spend_reservations ORDER BY scope_id,invocation_id').all() }); }
  finally { db.close(); }
}

it('shows exact per-invocation spending across compiled SDK, CLI and MCP without mutating money state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-spending-inspection-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), data = join(root, 'data');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(home), mkdir(data)]);
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const model = { id: 'model', version: 1, nativeId: 'native', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] };
  const catalog = { schemaVersion: 1 as const, revision: 'catalog', providers: [{ id: 'provider', version: 1, models: [model] }] };
  const definition = { encodingVersion: 1 as const, provider: { id: 'provider', version: 1 }, model };
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
    digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 2,
      definition: { endpoint: 'http://127.0.0.1:1/chat', maxOutputTokens: 8 } },
    allocation: { id: 'allocation', maxCalls: 4, maxInFlight: 4 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ mode: 'api', layout: { root: data }, storage: { driver: 'sqlite', sqlite },
    provider_catalog: catalog, provider_invocation_profiles: { schemaVersion: 1, profiles: [profile] },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 10, claimTtlMs: 100 },
    cancellationRuntime: { scopeIds: ['scope'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 1_048_576, maxConnections: 8, maxConcurrentRequests: 4,
      maxConcurrentExecutions: 2, headerTimeoutMs: 1000, responseTimeoutMs: 1000, shutdownGraceMs: 2000 } }), { mode: 0o600 });
  const ledger = await prepareProductFile(resolveProductLayout({ projectRoot: project, root: data }), 'ledger', ['-wal', '-shm', '-journal']);
  const identity = { id: 'actor', issuer: hostname(), subject: String(userInfo().uid), assurance: 'os-user' as const, scopeIds: ['scope'] };
  const actor = { id: identity.id, issuer: identity.issuer, subject: identity.subject, assurance: identity.assurance };
  const activationApp = new ModelActivationApplication({ async verify() { return identity; } },
    { async authorize() { return { revision: 'seed', ruleId: 'seed' }; } }, new ModelBindingApplication({ async read() { return catalog; } }),
    async () => openSqliteModelActivationStore(ledger, sqlite), () => 1);
  const activation = await activationApp.admit({ schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'inspect', restrictions: [], grants: [{ id: 'inspect', effect: 'allow',
    actions: ['inspect'], scopes: ['scope'], principals: [{ issuer: identity.issuer, subject: identity.subject }],
    resource: { kind: 'model-invocation', ids: [modelInvocationTargetId(reference)] } }] }), { mode: 0o600 });
  const store = await openSqliteModelInvocationStore(ledger, sqlite, 'forbid');
  const seed = async (suffix: string) => {
    const command = { schemaVersion: 1 as const, commandId: `command-${suffix}`, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
      nativeRequest: { model: 'native', messages: [{ role: 'user', content: suffix }], max_completion_tokens: 4 } };
    const requestDigest = modelInvocationRequestDigest(command), profileDigest = modelInvocationProfileDigest(profile);
    const spending = { budget: { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 20 },
      quote: { schemaVersion: 1 as const, scopeId: 'scope', requestDigest, profileDigest,
        pricing: { id: 'native-price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } }, meter: { id: 'native-meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } },
        currency: 'USD', maxChargeMinorUnits: 6 } };
    return store.claim({ command, requestDigest, actor, authorization: { revision: 'seed', ruleId: 'seed' }, definition,
      activation: activation.receipt.record, profile, profileDigest, invocationId: `invocation-${suffix}`, claimedAtMs: 2, spending });
  };
  const held = await seed('held'); await store.permitSend(held.record.receipt.claim, 'owner', 3);
  await store.recordResponse(held.record.receipt.claim, { schemaVersion: 1, native: { id: 'response' }, usage: null }, 4);
  const released = await seed('released'); await store.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel-released', scopeId: 'scope',
    targetCommandId: released.record.receipt.claim.commandId, reference, expectedRequestDigest: released.record.receipt.claim.requestDigest },
  actor, authorization: { revision: 'seed', ruleId: 'seed' }, requestedAtMs: 5 }); store.close();
  await startRuntime(project, env);
  const query = (id: string, ref = reference, scopeId = 'scope') => ({ schemaVersion: 2, scopeId, invocationId: id, reference: ref });
  const heldQuery = query('invocation-held'), releasedQuery = query('invocation-released');
  const before = ledgerSnapshot(ledger), heldSdk = await inspectSdk(project, env, heldQuery), releasedSdk = await inspectSdk(project, env, releasedQuery);
  expect(heldSdk).toMatchObject({ ok: true, value: { schemaVersion: 6, historyIntegrity: 'not-recorded', contentStatus: 'retained', spending: { disposition: { state: 'held', reason: 'missing-usage' } } } });
  expect(releasedSdk).toMatchObject({ ok: true, value: { schemaVersion: 6, historyIntegrity: 'not-recorded', contentStatus: 'not-captured', spending: { disposition: { state: 'released-not-sent' } } } });
  if (!heldSdk.ok || !releasedSdk.ok) throw new Error('SDK_INSPECTION_FAILED');
  expect(Object.hasOwn(heldSdk.value, 'responseContent')).toBe(false); expect(Object.hasOwn(releasedSdk.value, 'responseContent')).toBe(false);
  const input = join(root, 'query.json'); await writeFile(input, JSON.stringify(heldQuery));
  const cliJson = JSON.parse((await execute(process.execPath, [cli, 'models', 'invocation', '--input', input, '--json'],
    { cwd: project, env, timeout: 10_000 })).stdout) as ModelInvocationInspection;
  expect(cliJson).toEqual(heldSdk.value);
  const mcpResult = await inspectMcp(project, env, releasedQuery);
  expect(mcpResult.isError).not.toBe(true); expect(mcpResult.structuredContent).toEqual(releasedSdk.value);
  for (const [language, phrase] of [['en', 'Local reservation held: up to 6 minor units (USD)'], ['tr', 'Yerel rezervasyon bekletildi: en fazla 6 alt birim (USD)']] as const) {
    const text = (await execute(process.execPath, [cli, 'models', 'invocation', '--input', input, '--lang', language, '--no-color'],
      { cwd: project, env, timeout: 10_000 })).stdout;
    expect(text).toContain(phrase); expect(text.toLowerCase()).toContain(language === 'en' ? 'not a provider invoice' : 'sağlayıcı faturası değildir');
  }
  expect((heldSdk.value.spending as ProviderSpendReservation).disposition).toEqual({ state: 'held', reason: 'missing-usage', observedMinorUnits: null,
    evidenceDigest: expect.any(String) });
  expect(await inspectSdk(project, env, query('invocation-held', reference, 'foreign'))).toEqual({ ok: false, code: 'POLICY_DENIED' });
  expect(await inspectSdk(project, env, query('invocation-held', { ...reference, modelId: 'foreign' }))).toEqual({ ok: false, code: 'POLICY_DENIED' });
  expect(ledgerSnapshot(ledger)).toBe(before);
});
