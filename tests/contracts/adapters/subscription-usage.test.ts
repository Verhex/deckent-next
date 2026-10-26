import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore, readSqliteSubscriptionUsageSummary } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

it('counts this person’s completed connection requests without presenting unknown or foreign usage as zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-subscription-usage-')), path = join(root, 'ledger.db');
  const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
  const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
  const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
    models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }), reference)!;
  const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
  const actor = { id: 'person', issuer: 'host', subject: '1000', assurance: 'os-user' as const }, connectionId = '00000000-0000-4000-8000-000000000001';
  try {
    const activations = await openSqliteModelActivationStore(path, options);
    const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
      expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
      authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activations.close();
    const profile = { schemaVersion: 2 as const, billingAxis: 'subscription' as const, id: 'subscription', version: 1, scopeId: 'scope', reference,
      bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
      adapter: { id: 'fixture-subscription', version: 1, definition: { connectionId } }, allocation: { id: 'allocation', maxCalls: null, maxInFlight: 1 },
      limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
    const store = await openSqliteModelInvocationStore(path, options, 'forbid');
    try { for (const [index, time] of [10, 86_400_010, 86_400_020].entries()) {
      const command = { schemaVersion: 1 as const, commandId: `call-${index}`, scopeId: 'scope', reference, catalogRevision: 'catalog',
        expectedBinding: binding, nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: 'fixture' }] } };
      const claimed = await store.claim({ command, requestDigest: modelInvocationRequestDigest(command), actor, authorization: { revision: 'policy', ruleId: 'invoke' },
        definition, activation: activated.receipt.record, profile, profileDigest: modelInvocationProfileDigest(profile), invocationId: `id-${index}`, claimedAtMs: time });
      await store.permitSend(claimed.record.receipt.claim, 'sender', time);
      await store.recordResponse(claimed.record.receipt.claim, { schemaVersion: 1, native: { answer: 'fixture' }, usage: { output_tokens: 1 } }, time + 1);
    } } finally { store.close(); }
    const query = { scopeId: 'scope', connectionId, adapterId: 'fixture-subscription', owner: { issuer: actor.issuer, subject: actor.subject },
      fromMs: 0, untilMs: 172_800_000, maxEntries: 10, timeoutMs: 5000, busyTimeoutMs: 2000, references: [reference] };
    expect(await readSqliteSubscriptionUsageSummary(path, query)).toEqual({ state: 'complete', completedRequests: 3, busiestDayRequests: 2, activeDays: 2 });
    expect(await readSqliteSubscriptionUsageSummary(path, { ...query, owner: { issuer: 'host', subject: 'other' } })).toMatchObject({ completedRequests: 0 });
    const cancelled = AbortSignal.abort();
    expect(await readSqliteSubscriptionUsageSummary(path, { ...query, signal: cancelled })).toMatchObject({ state: 'unavailable', completedRequests: null });
    expect(await readSqliteSubscriptionUsageSummary(path, { ...query, maxEntries: 2 })).toEqual({ state: 'unavailable', completedRequests: null, busiestDayRequests: null, activeDays: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});
