import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

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
async function fixture(maxInFlight = 2) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-purge-')); roots.push(root);
  const path = join(root, 'ledger.db'), activations = await openSqliteModelActivationStore(path, options);
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'loopback-http', version: 1, definition: { origin: 'http://127.0.0.1:1' } },
    allocation: { id: 'allocation', maxCalls: 4, maxInFlight }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  return { path, profile, activation: activated.receipt.record };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, commandId = 'invoke', invocationId = 'invocation') {
  const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: 'private prompt' }] } };
  return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization: { revision: 'policy', ruleId: 'invoke' }, definition,
    activation: base.activation, profile: base.profile, profileDigest: modelInvocationProfileDigest(base.profile), invocationId, claimedAtMs: 10 };
}
function purge(commandId: string, invocationId: string, expectedContentDigest: string, suppliedActor = actor, scopeId = 'scope') {
  return { command: { schemaVersion: 1 as const, commandId, scopeId, invocationId, reference, expectedContentDigest }, actor: suppliedActor,
    authorization: { revision: 'policy', ruleId: 'purge-content' }, purgedAtMs: 30 };
}
async function responded(base: Awaited<ReturnType<typeof fixture>>, store: Awaited<ReturnType<typeof openSqliteModelInvocationStore>>, commandId = 'invoke', invocationId = 'invocation') {
  const claim = await store.claim(admission(base, commandId, invocationId));
  return store.recordResponse(claim.record.receipt.claim, { schemaVersion: 1, native: { id: 'sensitive-result', output: 'secret' }, usage: { total_tokens: 2 } }, 20);
}

it('purges retained native content without changing immutable receipt, counters, or same-command replay', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const record = await responded(base, store), receiptBefore = record.receipt;
  const digest = record.content!.descriptor.digest, first = await store.purgeContent(purge('purge-1', 'invocation', digest));
  expect(first).toMatchObject({ replayed: false, receipt: { command: { commandId: 'purge-1', expectedContentDigest: digest } } });
  expect(await store.purgeContent(purge('purge-1', 'invocation', digest))).toEqual({ replayed: true, receipt: first.receipt });
  const loaded = await store.loadInvocation('scope', 'invocation');
  expect(loaded).toEqual({ receipt: receiptBefore, content: null, purge: first.receipt });
  await expect(store.purgeContent(purge('purge-1', 'invocation', digest, { ...actor, subject: 'other' }))).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  await expect(store.purgeContent(purge('purge-2', 'invocation', digest))).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  store.close();
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 0 });
  expect(db.prepare('SELECT record,purge_command_id FROM model_invocation_contents').get()).toEqual({ record: null, purge_command_id: 'purge-1' });
  expect(String(db.prepare('SELECT record FROM model_invocations').get()?.record)).not.toContain('secret'); db.close();
});

async function waitForBarrier(path: string, count: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(Array.from({ length: count }, (_, index) => access(`${path}.${index}`).then(() => true, () => false)));
    if (ready.every(Boolean)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('PURGE_CHILD_BARRIER_TIMEOUT');
}
async function racePurge(path: string, admissions: readonly unknown[]) {
  const entry = resolve('dist/adapters/core/sqlite-model-invocation/index.js');
  await access(entry).catch(() => { throw new Error('BUILD_REQUIRED'); });
  const gate = `${path}.purge-gate`, moduleUrl = pathToFileURL(entry).href;
  const script = `import { existsSync, writeFileSync } from 'node:fs';
    const [database, encoded, gate, marker] = process.argv.slice(1);
    const { openSqliteModelInvocationStore } = await import(${JSON.stringify(moduleUrl)});
    writeFileSync(marker, 'ready'); while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 5));
    const store = await openSqliteModelInvocationStore(database, { journalMode: 'delete', durability: 'full', busyTimeoutMs: 2000 }, 'forbid');
    try { const result = await store.purgeContent(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
      process.stdout.write(JSON.stringify({ ok: true, replayed: result.replayed, commandId: result.receipt.command.commandId })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? 'UNKNOWN' })); } finally { store.close(); }`;
  const children = admissions.map((admission, index) => execute(process.execPath, ['--input-type=module', '--eval', script, path,
    Buffer.from(JSON.stringify(admission)).toString('base64url'), gate, `${gate}.${index}`], { cwd: process.cwd(), timeout: 10_000, maxBuffer: 1_048_576 }));
  await waitForBarrier(gate, children.length); await writeFile(gate, 'go');
  return Promise.all(children).then(results => results.map(result => JSON.parse(result.stdout) as { ok: boolean; replayed?: boolean; commandId?: string; code?: string }));
}

it('uses independent writer processes: distinct commands elect one winner and same command replays the original audit', async () => {
  const distinctBase = await fixture(), distinctStore = await openSqliteModelInvocationStore(distinctBase.path, options, 'forbid');
  const distinct = await responded(distinctBase, distinctStore), digest = distinct.content!.descriptor.digest; distinctStore.close();
  const wrong = await openSqliteModelInvocationStore(distinctBase.path, options, 'forbid');
  await expect(wrong.purgeContent(purge('wrong-digest', 'invocation', '0'.repeat(64)))).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  await expect(wrong.purgeContent(purge('wrong-scope', 'invocation', digest, actor, 'other-scope'))).rejects.toThrow('MODEL_INVOCATION_COMMAND_CONFLICT');
  expect((await wrong.loadInvocation('scope', 'invocation'))?.content?.descriptor.digest).toBe(digest); wrong.close();
  const winners = await racePurge(distinctBase.path, [purge('purge-a', 'invocation', digest), purge('purge-b', 'invocation', digest)]);
  expect(winners.filter(value => value.ok)).toHaveLength(1);
  expect(winners.filter(value => value.code === 'MODEL_INVOCATION_COMMAND_CONFLICT')).toHaveLength(1);

  const replayBase = await fixture(), replayStore = await openSqliteModelInvocationStore(replayBase.path, options, 'forbid');
  const replay = await responded(replayBase, replayStore), replayDigest = replay.content!.descriptor.digest; replayStore.close();
  const replays = await racePurge(replayBase.path, [purge('same-purge', 'invocation', replayDigest), purge('same-purge', 'invocation', replayDigest)]);
  expect(replays).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, replayed: false }), expect.objectContaining({ ok: true, replayed: true })]));
  const inspect = new DatabaseSync(replayBase.path, { readOnly: true });
  expect(inspect.prepare('SELECT count(*) AS count FROM model_invocation_content_purges').get()?.count).toBe(1); inspect.close();
});

it('rolls both pre-insert and post-insert audit failures back and keeps partial unknown allocations in flight after purge', async () => {
  const base = await fixture(1), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claim = await store.claim(admission(base));
  const partial = createModelInvocationResponseEvidence({ id: 'loopback-http', version: 1 }, 'interrupted', null, Buffer.from('prefix'), false, 10);
  const record = await store.recordUnknown(claim.record.receipt.claim, 'transport-error', 20, partial), digest = record.content!.descriptor.digest;
  store.close();
  const trigger = new DatabaseSync(base.path); trigger.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON model_invocation_content_purges
    BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;`); trigger.close();
  const failing = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(failing.purgeContent(purge('purge-fail', 'invocation', digest))).rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE'); failing.close();
  const before = new DatabaseSync(base.path, { readOnly: true });
  expect(before.prepare('SELECT record,purge_command_id FROM model_invocation_contents').get()?.purge_command_id).toBeNull(); before.close();
  const remove = new DatabaseSync(base.path); remove.exec(`DROP TRIGGER reject_audit; CREATE TRIGGER reject_content_update
    BEFORE UPDATE ON model_invocation_contents WHEN NEW.purge_command_id='purge-after'
    BEGIN SELECT RAISE(ABORT,'fixture content update failure'); END;`); remove.close();
  const afterInsert = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(afterInsert.purgeContent(purge('purge-after', 'invocation', digest))).rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE'); afterInsert.close();
  const afterFailure = new DatabaseSync(base.path, { readOnly: true });
  expect(afterFailure.prepare('SELECT count(*) AS count FROM model_invocation_content_purges').get()?.count).toBe(0);
  expect(afterFailure.prepare('SELECT record,purge_command_id FROM model_invocation_contents').get()?.purge_command_id).toBeNull(); afterFailure.close();
  const removeUpdate = new DatabaseSync(base.path); removeUpdate.exec('DROP TRIGGER reject_content_update'); removeUpdate.close();
  const storeAfter = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await storeAfter.purgeContent(purge('purge-ok', 'invocation', digest)); storeAfter.close();
  const db = new DatabaseSync(base.path, { readOnly: true });
  expect(db.prepare('SELECT lifetime_calls,in_flight FROM model_invocation_allocations').get()).toEqual({ lifetime_calls: 1, in_flight: 1 });
  expect(db.prepare('SELECT record,purge_command_id FROM model_invocation_contents').get()).toEqual({ record: null, purge_command_id: 'purge-ok' }); db.close();
});
