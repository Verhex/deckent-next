import { beforeEach, expect, it, vi } from 'vitest';
import { ProviderSpendError, runtimeServiceResultCapacity } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';

const calls: Array<{ maximum: number }> = [];
let failure: Error | null = null;
vi.mock('#composition/core/provider-spend/index.js', () => ({
  async inspectPeerConfiguredProviderSpendAccount() { throw new Error('unexpected inspection'); },
  async auditPeerConfiguredProviderSpendAccount(_root: string, _command: unknown, _peer: unknown, maximum: number) {
    calls.push({ maximum });
    if (failure) throw failure;
    return { schemaVersion: 1, receipt: { digest: 'a'.repeat(64) }, replayed: false };
  },
}));

const command = { schemaVersion: 1 as const, commandId: 'audit', scopeId: 'scope', budgetId: 'budget', budgetRevision: 1,
  expectedCheckpointDigest: 'b'.repeat(64) };
const peer = { schemaVersion: 1 as const, kind: 'unix-peer' as const, uid: 1000, gid: 1000, pid: 10 };
const request = { schemaVersion: 10 as const, requestId: 'request', operation: 'auditProviderSpendAccount' as const,
  input: command, delivery: { maxResultBytes: 1234 } };

beforeEach(() => { calls.length = 0; failure = null; });

it('computes the server/client minimum before invoking the peer-owned audit composition', async () => {
  const { executeConfiguredRuntimeProviderSpendOperation } = await import('#composition/core/runtime-service/internal/provider-spend.js');
  const result = await executeConfiguredRuntimeProviderSpendOperation('/project', request, peer, 4096, {});
  expect(result).toMatchObject({ schemaVersion: 1, replayed: false });
  expect(calls).toEqual([{ maximum: runtimeServiceResultCapacity(request.requestId, 4096, request.delivery.maxResultBytes) }]);
});

it.each([
  ['the engine error', () => new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT')],
  ['the composition-mapped platform error', () => queryFailure(new ProviderSpendError('PROVIDER_SPEND_RESULT_LIMIT'))],
])('maps %s to the runtime response-limit contract', async (_label, createFailure) => {
  const { executeConfiguredRuntimeProviderSpendOperation } = await import('#composition/core/runtime-service/internal/provider-spend.js');
  failure = createFailure();
  await expect(executeConfiguredRuntimeProviderSpendOperation('/project', request, peer, 4096, {}))
    .rejects.toMatchObject({ code: 'RUNTIME_SERVICE_RESPONSE_LIMIT' });
  expect(calls).toHaveLength(1);
});

it('does not trust a response-limit code on an unrecognized error type', async () => {
  const { executeConfiguredRuntimeProviderSpendOperation } = await import('#composition/core/runtime-service/internal/provider-spend.js');
  failure = Object.assign(new Error('forged'), { code: 'PROVIDER_SPEND_RESULT_LIMIT' });
  await expect(executeConfiguredRuntimeProviderSpendOperation('/project', request, peer, 4096, {}))
    .rejects.toBe(failure);
});
