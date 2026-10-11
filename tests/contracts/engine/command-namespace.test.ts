import { expect, it } from 'vitest';
import { clientCommandIdSchema, identitySchema, effectCommandSchema, commandEnvelopeSchema, CommandIdError, SYSTEM_COMMAND_PREFIXES } from '#domain/index.js';
import { runCommandSchema, runLifecycleCommandSchema, attemptCommandSchema, taskEvaluationCommandSchema } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { t, ErrorRegistry } from '#platform/index.js';
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 };
it.each([SYSTEM_COMMAND_PREFIXES.fence, SYSTEM_COMMAND_PREFIXES.release])('one reserved registry entry %s governs command writes, with readable historical ids', prefix => {
  const commandId = prefix + 'fixture';
  expect(identitySchema.parse(commandId)).toBe(commandId);
  expect(() => clientCommandIdSchema.parse(commandId)).toThrow(CommandIdError);
  const common = { schemaVersion: 1, commandId, scopeId: 's' };
  for (const [schema, command] of [
    [runCommandSchema, { ...common, runId: 'r', expectedRevision: 0, action: 'cancel' }],
    [runLifecycleCommandSchema, { ...common, runId: 'r', expectedRevision: 0, action: 'hold', holdReason: 'hold' }],
    [attemptCommandSchema, { ...common, schemaVersion: 2, action: { kind: 'create', identity } }],
    [taskEvaluationCommandSchema, { schemaVersion: 1, commandId, identity, expectedRevision: 0 }],
    [effectCommandSchema, { ...common, operation: { id: 'fixture', version: 1 }, target: { kind: 'fixture', id: 'x' }, idempotencyKey: commandId, input: {}, expectedVersion: null }],
    [commandEnvelopeSchema, { ...common, principalRef: { id: 'actor', issuer: 'test', subject: 'actor' }, idempotencyKeyHash: 'a'.repeat(64) }],
  ] as const) {
    expect(schema.parse({ ...command, commandId: 'admitted-fixture' })).toMatchObject({ commandId: 'admitted-fixture' });
    expect(() => schema.parse(command)).toThrow('COMMAND_ID_RESERVED');
  }
});
it('ordinary command ids are preserved and typed denial maps to both catalogs', () => {
  expect(clientCommandIdSchema.parse('customer-command')).toBe('customer-command');
  const error = queryFailure(new CommandIdError()); expect(error.code).toBe('COMMAND_ID_RESERVED');
  expect(t('error.COMMAND_ID_RESERVED', {}, 'tr')).toContain('ayrılmış');
  expect(t('error.COMMAND_ID_RESERVED', {}, 'en')).toContain('reserved');
  expect(ErrorRegistry.has('DISPATCH_FENCE_CONFLICT')).toBe(true);
});
