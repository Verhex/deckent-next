import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ records: [] as { connectionId: string; state: string; planUse: boolean }[], connect: vi.fn() }));
vi.mock('../../../src/composition/core/siwc/internal/connection.js', () => ({
  withConfiguredSiwc: async (_root: string, _scope: string, _options: unknown, _operation: string,
    work: (app: unknown, caller: unknown) => Promise<unknown>) => work({ list: async () => state.records, connect: state.connect },
      { principal: { id: 'person', issuer: 'host', subject: '1000', assurance: 'os-user', scopeIds: ['scope'] } }),
}));
import { configuredSiwcConnect } from '#composition/core/siwc/index.js';
import { modelConnectCommandSchema } from '#domain/index.js';

it('requires an explicit disconnected old account for new authorization and writes only the owner reference into a default-off profile', async () => {
  // Synthetic lifecycle ports; this is not a TTY witness, browser login or account entitlement proof.
  const command = modelConnectCommandSchema.parse({ schemaVersion: 1, commandId: 'fixture', scopeId: 'scope', connection: 'fixture-connection',
    model: { pull: 'available' }, subscription: { newAccount: true } });
  state.records = [{ connectionId: '00000000-0000-4000-8000-000000000001', state: 'connected', planUse: true }]; state.connect.mockReset();
  await expect(configuredSiwcConnect('/fixture', command, {}).adapter()).rejects.toMatchObject({ code: 'SIWC_ACCOUNT_STILL_CONNECTED' });
  expect(state.connect).not.toHaveBeenCalled();
  state.records = [{ ...state.records[0]!, state: 'disconnected', planUse: false }];
  const connectionId = '00000000-0000-4000-8000-000000000002';
  state.connect.mockResolvedValue({ connectionId, state: 'connected', planUse: true });
  const profile = await configuredSiwcConnect('/fixture', command, {}).adapter();
  expect(state.connect).toHaveBeenCalledWith({ planUse: true }, undefined);
  expect(profile).toMatchObject({ billingAxis: 'subscription', tariff: 'unmetered', adapter: { definition: { schemaVersion: 2, connectionId,
    owner: { issuer: 'host', subject: '1000' }, rawUse: 'person', delegatedUse: null, apiContinuation: null } } });
  expect(profile.adapter.definition['owner']).not.toHaveProperty('id');
});
