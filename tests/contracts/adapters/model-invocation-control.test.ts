import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' } as const;

async function file() { const root = await mkdtemp(join(tmpdir(), 'deckent-model-control-')); roots.push(root); return join(root, 'ledger.db'); }
async function fixture(maxCalls = 4, maxInFlight = 2) {
  const path = await file(), activations = await openSqliteModelActivationStore(path, options);
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  const profile = { schemaVersion: 1 as const, id: 'local-profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
    allocation: { id: 'allocation', maxCalls, maxInFlight }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1_000 } };
  return { path, activation: activated.receipt.record, profile };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, commandId = 'command-1', invocationId = 'invocation-1') {
  const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: 'private prompt' }] } };
  return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization, definition, activation: base.activation,
    profile: base.profile, profileDigest: modelInvocationProfileDigest(base.profile), invocationId, claimedAtMs: 10 };
}
function cancellation(claim: { readonly scopeId: string; readonly commandId: string; readonly requestDigest: string }, commandId = 'cancel-1') {
  return { command: { schemaVersion: 1 as const, commandId, scopeId: claim.scopeId, targetCommandId: claim.commandId,
    reference, expectedRequestDigest: claim.requestDigest }, actor, authorization, requestedAtMs: 20 };
}
function allocation(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  const value = db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get(); db.close();
  return value;
}
function controls(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  const value = db.prepare('SELECT count(*) AS count FROM model_invocation_controls').get()?.count; db.close();
  return value;
}
async function openClaim(base: Awaited<ReturnType<typeof fixture>>, commandId = 'command-1', invocationId = 'invocation-1') {
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const result = await store.claim(admission(base, commandId, invocationId));
  return { store, result };
}

it('creates a pending durable control with each claim and restores it after restart', async () => {
  const base = await fixture(), { store, result } = await openClaim(base);
  expect(await store.loadControl('scope', result.record.receipt.claim.invocationId)).toMatchObject({ schemaVersion: 1,
    claim: result.record.receipt.claim, reference, send: { state: 'pending' }, cancellation: null });
  expect(await store.loadControl('scope', 'missing')).toBeNull();
  store.close();
  const reopened = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  expect(await reopened.loadControl('scope', result.record.receipt.claim.invocationId)).toMatchObject({ send: { state: 'pending' } });
  reopened.close();
  expect(controls(base.path)).toBe(1);
});

it('grants send permission once, binds it to its owner, and refuses send recording before permission', async () => {
  const base = await fixture(), { store, result } = await openClaim(base), claim = result.record.receipt.claim;
  await expect(store.recordResponse(claim, { schemaVersion: 1, native: { id: 'response' }, usage: null }, 30))
    .rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  const first = await store.permitSend(claim, 'sender-a', 21);
  expect(first).toMatchObject({ granted: true, control: { send: { state: 'permitted', ownerId: 'sender-a', permittedAtMs: 21 } },
    record: { receipt: { claim } } });
  expect(await store.permitSend(claim, 'sender-a', 22)).toMatchObject({ granted: false, control: first.control });
  expect(await store.permitSend(claim, 'sender-b', 22)).toMatchObject({ granted: false, control: first.control });
  await expect(store.permitSend({ ...claim, invocationId: 'altered' }, 'sender-a', 22)).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  await expect(store.recordResponse(claim, { schemaVersion: 1, native: { id: 'response' }, usage: null }, 30))
    .resolves.toMatchObject({ receipt: { outcome: { state: 'responded' } } });
  store.close();
});

it('atomically prevents a pending send, releases only in-flight capacity, and replays its cancellation receipt', async () => {
  const base = await fixture(), { store, result } = await openClaim(base), claim = result.record.receipt.claim, input = cancellation(claim);
  const first = await store.cancelInvocation(input);
  expect(first).toMatchObject({ replayed: false, receipt: { command: input.command, claim, disposition: 'prevented' } });
  expect(await store.loadInvocation('scope', claim.invocationId)).toMatchObject({ receipt: { outcome: { schemaVersion: 4,
    state: 'not-sent', reason: 'cancelled-before-permission', cancellationCommandId: 'cancel-1', content: null, observedAtMs: 20 } } });
  expect(await store.loadControl('scope', claim.invocationId)).toMatchObject({ send: { state: 'prevented' }, cancellation: first.receipt });
  expect(await store.cancelInvocation(input)).toEqual({ replayed: true, receipt: first.receipt });
  await expect(store.cancelInvocation({ ...input, actor: { ...actor, id: 'other' } })).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  await expect(store.cancelInvocation({ ...input, command: { ...input.command, targetCommandId: 'foreign' } })).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  await expect(store.cancelInvocation({ ...input, command: { ...input.command, expectedRequestDigest: '0'.repeat(64) } })).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  await expect(store.cancelInvocation({ ...input, command: { ...input.command, scopeId: 'other' } })).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  store.close();
  expect(allocation(base.path)).toEqual({ lifetime_calls: 1, in_flight: 0 });
  expect(controls(base.path)).toBe(1);
});

it('records requested cancellation after permission, preserves unknown capacity, and reports terminal invocations', async () => {
  const requestedBase = await fixture(), requested = await openClaim(requestedBase), requestedClaim = requested.result.record.receipt.claim;
  await requested.store.permitSend(requestedClaim, 'sender', 21);
  expect(await requested.store.cancelInvocation(cancellation(requestedClaim))).toMatchObject({ receipt: { disposition: 'requested' } });
  requested.store.close();
  expect(allocation(requestedBase.path)).toEqual({ lifetime_calls: 1, in_flight: 1 });

  const unknownBase = await fixture(), unknown = await openClaim(unknownBase), unknownClaim = unknown.result.record.receipt.claim;
  await unknown.store.permitSend(unknownClaim, 'sender', 21);
  await unknown.store.recordUnknown(unknownClaim, 'transport-error', 22);
  expect(allocation(unknownBase.path)).toEqual({ lifetime_calls: 1, in_flight: 1 });
  unknown.store.close();

  const terminalBase = await fixture(), terminal = await openClaim(terminalBase), terminalClaim = terminal.result.record.receipt.claim;
  await terminal.store.permitSend(terminalClaim, 'sender', 21);
  await terminal.store.recordResponse(terminalClaim, { schemaVersion: 1, native: { id: 'response' }, usage: null }, 22);
  expect(await terminal.store.cancelInvocation(cancellation(terminalClaim))).toMatchObject({ replayed: false, receipt: { disposition: 'already-terminal' } });
  terminal.store.close();
});

it('rolls cancellation writes back before and after audit insertion failures', async () => {
  for (const [name, sql] of [
    ['before-audit', `CREATE TRIGGER cancel_audit_failure BEFORE INSERT ON model_invocation_cancellations
      BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;`],
    ['after-audit', `CREATE TRIGGER cancel_control_failure BEFORE UPDATE ON model_invocation_controls
      BEGIN SELECT RAISE(ABORT,'fixture control failure'); END;`],
  ] as const) {
    const base = await fixture(), seeded = await openClaim(base, `command-${name}`, `invocation-${name}`), claim = seeded.result.record.receipt.claim;
    seeded.store.close();
    const db = new DatabaseSync(base.path); db.exec(sql); db.close();
    const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
    await expect(store.cancelInvocation(cancellation(claim, `cancel-${name}`))).rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE');
    expect(await store.loadInvocation('scope', claim.invocationId)).toMatchObject({ receipt: { outcome: null } });
    expect(await store.loadControl('scope', claim.invocationId)).toMatchObject({ send: { state: 'pending' }, cancellation: null });
    store.close();
    expect(allocation(base.path)).toEqual({ lifetime_calls: 1, in_flight: 1 });
  }
});

async function waitFor(path: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error(`BARRIER_TIMEOUT:${path}`);
}
async function race(path: string, operations: readonly unknown[]) {
  const entry = resolve('dist/adapters/core/sqlite-model-invocation/index.js');
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-control-race-')); roots.push(root);
  const ready = join(root, 'ready'), gate = join(root, 'gate'), child = resolve('tests/fixtures/model-invocation-control-race.mjs');
  const pending = operations.map((operation, index) => execute(process.execPath, [child, path,
    Buffer.from(JSON.stringify(operation)).toString('base64url'), `${ready}-${index}`, gate],
  { cwd: process.cwd(), timeout: 10_000, maxBuffer: 1_048_576 }));
  await Promise.all(operations.map((_, index) => waitFor(`${ready}-${index}`)));
  await writeFile(gate, 'go');
  return Promise.all(pending).then(results => results.map(result => JSON.parse(result.stdout.trim())));
}

it('uses a cross-process barrier to serialize permit/permit and cancel/permit races', async () => {
  const permitBase = await fixture(), permit = await openClaim(permitBase), permitClaim = permit.result.record.receipt.claim; permit.store.close();
  const permits = await race(permitBase.path, [{ kind: 'permit', claim: permitClaim, ownerId: 'sender-a', now: 21 },
    { kind: 'permit', claim: permitClaim, ownerId: 'sender-b', now: 21 }]) as { ok: boolean; granted?: boolean }[];
  expect(permits.filter(value => value.ok && value.granted)).toHaveLength(1);
  expect(permits.filter(value => value.ok && !value.granted)).toHaveLength(1);

  const mixedBase = await fixture(), mixed = await openClaim(mixedBase), mixedClaim = mixed.result.record.receipt.claim; mixed.store.close();
  const mixedOutcomes = await race(mixedBase.path, [{ kind: 'cancel', input: cancellation(mixedClaim) },
    { kind: 'permit', claim: mixedClaim, ownerId: 'sender', now: 21 }]) as { ok: boolean; granted?: boolean; disposition?: string }[];
  expect(mixedOutcomes.every(value => value.ok)).toBe(true);
  const store = await openSqliteModelInvocationStore(mixedBase.path, options, 'forbid');
  const control = await store.loadControl('scope', mixedClaim.invocationId); store.close();
  if (control?.cancellation?.disposition === 'prevented') {
    expect(mixedOutcomes).toEqual(expect.arrayContaining([expect.objectContaining({ disposition: 'prevented' }), expect.objectContaining({ granted: false })]));
    expect(allocation(mixedBase.path)).toEqual({ lifetime_calls: 1, in_flight: 0 });
  } else {
    expect(control).toMatchObject({ send: { state: 'permitted' }, cancellation: { disposition: 'requested' } });
    expect(allocation(mixedBase.path)).toEqual({ lifetime_calls: 1, in_flight: 1 });
  }
});
