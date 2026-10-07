import { afterEach, expect, it, vi } from 'vitest';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import type { EffectCommand } from '#domain/index.js';
const transport = vi.hoisted(() => vi.fn());
vi.mock('#adapters/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('#adapters/index.js')>(), requestLocalRuntime: transport,
}));
vi.mock('#platform/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('#platform/index.js')>();
  return { ...actual, loadConfig: async () => ({ service: actual.getConfigFieldDefault('service') }),
    prepareProductSocket: async () => '/unused-test-socket' };
});
afterEach(() => transport.mockReset());
const client = () => createConfiguredRuntimeClient('/unused-test-project');
const query = { schemaVersion: 1 as const, scopeId: 'scope', query: 'file', limit: 1 };
const attachment = { schemaVersion: 1 as const, scopeId: 'scope', path: 'file', maxBytes: 4 };
const command: EffectCommand = { schemaVersion: 1, scopeId: 'scope', commandId: 'command', operation: { id: 'write', version: 1 },
  target: { kind: 'record', id: 'record' }, idempotencyKey: 'key', input: {}, expectedVersion: null };
const outcome = { schemaVersion: 1, status: 'settled', scopeId: command.scopeId, commandId: command.commandId,
  operation: command.operation, target: command.target, sequence: 1, version: null, compensates: null, evidence: 'fence' };
function reply(result: unknown) { transport.mockResolvedValue({ ok: true, result }); }
it('rejects malformed requests before transport for all five moved methods', async () => {
  const c = client();
  await expect(c.findWorkspaceFiles({ ...query, limit: 0 })).rejects.toMatchObject({ code: 'AGENT_TURN_INVALID' });
  await expect(c.attachWorkspaceFile({ ...attachment, maxBytes: 0 })).rejects.toMatchObject({ code: 'AGENT_TURN_INVALID' });
  await expect(c.executeOperation({ ...command, commandId: '' })).rejects.toMatchObject({ code: 'EFFECT_INVALID' });
  await expect(c.compensateOperation({ ...command, commandId: '' })).rejects.toMatchObject({ code: 'EFFECT_INVALID' });
  await expect(c.inspectOperation({ schemaVersion: 1, scopeId: '', commandId: 'command' })).rejects.toMatchObject({ code: 'EFFECT_INVALID' });
  expect(transport).not.toHaveBeenCalled();
});
it('preserves file results and passes cancellation to the transport', async () => {
  const signal = new AbortController().signal, result = { schemaVersion: 1, paths: ['file'], truncated: false, incomplete: false };
  reply(result); expect(await client().findWorkspaceFiles(query, signal)).toEqual(result);
  expect(transport).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ operation: 'findWorkspaceFiles', input: query }), signal);
  const refused = { schemaVersion: 1, path: 'file', status: 'refused', reason: 'path-denied' };
  reply(refused); expect(await client().attachWorkspaceFile(attachment)).toEqual(refused);
  const attached = { schemaVersion: 1, path: 'file', status: 'attached', content: 'ş', bytes: 2, totalBytes: 2, truncated: false };
  reply(attached); expect(await client().attachWorkspaceFile(attachment)).toEqual(attached);
});
it('rejects excess file results, wrong UTF-8 byte counts and attachments above the request bound', async () => {
  reply({ schemaVersion: 1, paths: ['a', 'b'], truncated: false, incomplete: false });
  await expect(client().findWorkspaceFiles(query)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_TRANSPORT' });
  for (const [content, bytes] of [['ş', 1], ['abcde', 5]] as const) {
    reply({ schemaVersion: 1, path: 'file', status: 'attached', content, bytes, totalBytes: bytes, truncated: false });
    await expect(client().attachWorkspaceFile(attachment)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_TRANSPORT' });
  }
});
it.each(['executeOperation', 'compensateOperation'] as const)('preserves %s routing, delivery bound and command correlation', async method => {
  const c = client(); reply(outcome);
  expect(await c[method](command, { maxResultBytes: 2048 })).toEqual(outcome);
  expect(transport).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ operation: method, input: command,
    delivery: { maxResultBytes: 2048 } }), undefined);
  for (const changed of [{ commandId: 'other' }, { scopeId: 'other' }, { operation: { id: 'other', version: 1 } }]) {
    reply({ ...outcome, ...changed });
    await expect(c[method](command)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_TRANSPORT' });
  }
});
it('preserves empty inspections, rejects malformed records and preserves typed transport failures', async () => {
  const c = client(), input = { schemaVersion: 1 as const, scopeId: 'scope', commandId: 'command' };
  reply({ schemaVersion: 1, record: null }); expect(await c.inspectOperation(input)).toEqual({ schemaVersion: 1, record: null });
  reply({ schemaVersion: 1, record: {} }); await expect(c.inspectOperation(input)).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_TRANSPORT' });
  transport.mockResolvedValue({ ok: false, error: { code: 'POLICY_DENIED' } });
  await expect(c.inspectOperation(input)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});
