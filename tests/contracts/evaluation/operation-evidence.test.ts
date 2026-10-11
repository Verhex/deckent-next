import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { effectRecordSchema, immutableJsonObjectSchema, type CriterionDefinition, type EffectRecord } from '#domain/index.js';
import { OPERATION_EVIDENCE_EVALUATOR, PROCESS_EXIT_EVALUATOR, createInstalledTerminalEvaluator,
  evaluateOperationEvidence, validateInstalledCriterion, validateInstalledEvaluator, type OperationEvidenceReader } from '#capabilities/index.js';

const identity = { scopeId: 'scope-a', runId: 'run-a', taskId: 'task-a', attemptId: 'attempt-a', layoutRevision: 'layout-a', generation: 1 };
const binding = { notBefore: 1, principals: [{ id: 'actor-a', issuer: 'host-a', subject: 'user-a' }] };
const criterion = { id: 'completed', version: 1, description: 'Operation completed',
  evaluator: { id: OPERATION_EVIDENCE_EVALUATOR.id, version: 1 }, parameters: { commandId: 'command-a' } } satisfies CriterionDefinition;
const record = (state: EffectRecord['state'] = 'settled'): EffectRecord => effectRecordSchema.parse({ sequence: 1, state,
  intent: { schemaVersion: 1, command: { schemaVersion: 1, commandId: 'command-a', scopeId: identity.scopeId,
    operation: { id: 'record.update', version: 1 }, target: { kind: 'record', id: 'item-a' }, idempotencyKey: 'key-a', input: {}, expectedVersion: '1' },
    descriptor: { schemaVersion: 1, operation: { id: 'record.update', version: 1 }, targetKind: 'record', effectClass: 'write',
      approval: 'policy', precondition: 'record-version', compensation: null, inputMaxBytes: 1024 },
    actor: { id: 'actor-a', issuer: 'host-a', subject: 'user-a' }, inputDigest: 'a'.repeat(64), idempotencyKeyHash: 'b'.repeat(64) },
  evidence: state === 'settled' ? { kind: 'idempotency-record', version: '2', observedAt: 1 } : null,
  refusal: state === 'refused' ? 'EFFECT_PRECONDITION_CHANGED' : null });
const observation = (original: unknown, undo: EffectRecord | null = null) => ({ commandId: 'command-a',
  digest: original === null ? null : createHash('sha256').update(JSON.stringify(original)).digest('hex'),
  compensation: undo ? { commandId: undo.intent.command.commandId, digest: createHash('sha256').update(JSON.stringify(undo)).digest('hex') } : null });
const evaluate = (value: unknown) => evaluateOperationEvidence({ async loadEffect() { return value; } }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding);

it('holds a settlement before the binding boundary and accepts the exact boundary', async () => {
  const input = record();
  expect(await evaluate({ ...input, evidence: { ...input.evidence!, observedAt: 0 } }))
    .toMatchObject({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_EARLIER' });
  expect((await evaluate(input)).verdict).toBe('pass');
});
it.each(['id', 'issuer', 'subject'] as const)('fails a foreign operation principal %s', async field => {
  const input = record();
  expect(await evaluate({ ...input, intent: { ...input.intent, actor: { ...input.intent.actor, [field]: 'foreign' } } }))
    .toMatchObject({ verdict: 'fail', reason: 'OPERATION_EVIDENCE_PRINCIPAL' });
});
it('holds missing durable authority/time context without accepting settlement', async () => {
  expect(await evaluateOperationEvidence({ async loadEffect() { return record(); } }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity))
    .toMatchObject({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_CONTEXT' });
});
it('reads the exact scoped command through the existing read method and returns a stable settlement reference', async () => {
  const loadEffect = vi.fn(async () => record());
  const reader: OperationEvidenceReader = { loadEffect };
  const result = await evaluateOperationEvidence(reader, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding);
  expect(loadEffect).toHaveBeenCalledExactlyOnceWith(identity.scopeId, 'command-a');
  expect(result).toEqual({ verdict: 'pass', effectEvidence: observation(record()), evidence: { kind: 'operation-settlement', scopeId: identity.scopeId, commandId: 'command-a',
    sequence: 1, inputDigest: 'a'.repeat(64), digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(await evaluate(record())).toEqual(result);
  expect(Object.isFrozen(result)).toBe(true);
});
it('binds the reference digest to sequence, input digest and target settlement evidence', async () => {
  const original = await evaluate(record());
  for (const next of [{ ...record(), sequence: 2 }, { ...record(), intent: { ...record().intent, inputDigest: 'c'.repeat(64) } },
    { ...record(), evidence: { kind: 'fence', version: '3', observedAt: 2 } },
    { ...record(), intent: { ...record().intent, command: { ...record().intent.command, target: { kind: 'record', id: 'item-b' } } } },
    { ...record(), intent: { ...record().intent, approval: { approvalId: 'approval-a', actionDigest: 'c'.repeat(64) } } }]) {
    expect(await evaluate(next)).not.toEqual(original);
  }
});
it.each(['claimed', 'unknown'] as const)('preserves %s as unknown with a state observation and no settlement proof', async state => {
  const result = await evaluate(record(state));
  expect(result).toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_UNSETTLED',
    effectEvidence: { commandId: 'command-a', digest: expect.stringMatching(/^[a-f0-9]{64}$/), compensation: null } });
  expect(result).not.toHaveProperty('evidence');
});
it('holds a missing intent (including approval pending before claim)', async () => {
  expect(await evaluate(null)).toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_MISSING', effectEvidence: observation(null) });
});
it('holds unavailable reads without retry or a pass from process exit', async () => {
  const loadEffect = vi.fn(async () => { throw new Error('unavailable'); });
  expect(await evaluateOperationEvidence({ loadEffect }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding))
    .toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_UNAVAILABLE' });
  expect(loadEffect).toHaveBeenCalledTimes(1);
});
it.each(['EFFECT_PRECONDITION_CHANGED', 'EFFECT_REJECTED'] as const)('fails a terminal refusal with %s', async refusal => {
  expect(await evaluate({ ...record('refused'), refusal })).toEqual({ verdict: 'fail', reason: refusal, effectEvidence: observation({ ...record('refused'), refusal }) });
});
it('holds a noncanonical held projection', async () => {
  expect(await evaluate({ ...record('claimed'), state: 'held' })).toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_INVALID' });
});
it('holds a noncanonical compensated projection without deleting original evidence', async () => {
  const input = { ...record('claimed'), state: 'compensated' }, before = JSON.stringify(input);
  expect(await evaluate(input)).toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_INVALID' });
  expect(JSON.stringify(input)).toBe(before);
});
it.each(['scopeId', 'commandId'] as const)('holds a read with mismatched %s', async field => {
  const input = record();
  expect(await evaluate({ ...input, intent: { ...input.intent, command: { ...input.intent.command, [field]: 'foreign' } } }))
    .toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_BINDING' });
});
it.each([undefined, {}, { ...record(), state: 'future-state' }, { ...record(), evidence: null },
  { ...record('claimed'), evidence: record().evidence }, { ...record('refused'), refusal: null },
  { ...record(), intent: { ...record().intent, inputDigest: 'invalid' } }])('holds malformed or contradictory read evidence (%#)', async input => {
  expect(await evaluate(input)).toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_INVALID' });
});
it('selects implementations by identity while preserving versioned registry aliases', () => {
  const alias = { id: 'configured-alias', version: 3, implementation: OPERATION_EVIDENCE_EVALUATOR.implementation };
  expect(validateInstalledEvaluator(alias)).toBeUndefined();
  expect(validateInstalledCriterion(alias, { ...criterion, evaluator: { id: alias.id, version: alias.version } })).toBeUndefined();
  expect(() => validateInstalledCriterion(alias, criterion)).toThrow('TASK_EVALUATOR_INVALID');
});
it('rejects unsupported implementation identities and versions before a read', async () => {
  const loadEffect = vi.fn(async () => record());
  for (const implementation of [{ id: 'unknown', version: 1 }, { id: 'operation-evidence', version: 2 }, { id: 'process-exit', version: 2 }]) {
    await expect(evaluateOperationEvidence({ loadEffect }, { ...OPERATION_EVIDENCE_EVALUATOR, implementation }, criterion, identity, binding)).rejects.toThrow();
  }
  expect(loadEffect).not.toHaveBeenCalled();
});
it.each([{}, { commandId: '' }, { commandId: 'command-a', scopeId: 'foreign' }, { commandId: 'command-a', extra: true }])('rejects invalid parameters before reading (%#)', async parameters => {
    const loadEffect = vi.fn(async () => record());
    await expect(evaluateOperationEvidence({ loadEffect }, OPERATION_EVIDENCE_EVALUATOR, { ...criterion, parameters: immutableJsonObjectSchema.parse(parameters) }, identity)).rejects.toThrow();
    expect(loadEffect).not.toHaveBeenCalled();
  });
it('rejects malformed Attempt context before reading', async () => {
  const loadEffect = vi.fn(async () => record());
  await expect(evaluateOperationEvidence({ loadEffect }, OPERATION_EVIDENCE_EVALUATOR, criterion, { ...identity, scopeId: '' })).rejects.toThrow();
  expect(loadEffect).not.toHaveBeenCalled();
});
it('holds missing Attempt context and binds authenticated context to structured settlement evidence', async () => {
  const loadEffect = vi.fn(async () => record()), installed = createInstalledTerminalEvaluator({ loadEffect });
  expect(await installed.evaluate(OPERATION_EVIDENCE_EVALUATOR, criterion, { exitCode: 0 })).toBe('unknown');
  expect(await installed.evaluate(OPERATION_EVIDENCE_EVALUATOR, criterion, { exitCode: 1 })).toBe('unknown');
  expect(loadEffect).not.toHaveBeenCalled();
  expect(await installed.evaluate(OPERATION_EVIDENCE_EVALUATOR, criterion, { exitCode: 0 }, { identity, binding })).toEqual({ verdict: 'pass',
    evidenceTypes: ['operation-settlement'], evidenceReferences: [{ id: 'command-a', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }], effectEvidence: observation(record()) });
  expect((await installed.evaluateOperation(OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding)).verdict).toBe('pass');
});
it('preserves process-exit behavior and rejects unknown implementations at the installed boundary', async () => {
  const loadEffect = vi.fn(async () => record()), installed = createInstalledTerminalEvaluator({ loadEffect });
  const exitCriterion = { ...criterion, evaluator: { id: PROCESS_EXIT_EVALUATOR.id, version: 1 }, parameters: { acceptedExitCodes: [0] } };
  expect(await installed.evaluate(PROCESS_EXIT_EVALUATOR, exitCriterion, { exitCode: 0 })).toBe('pass');
  expect(await installed.evaluate(PROCESS_EXIT_EVALUATOR, exitCriterion, { exitCode: 7 })).toBe('fail');
  await expect(installed.evaluate({ ...OPERATION_EVIDENCE_EVALUATOR, implementation: { id: 'unknown', version: 1 } }, criterion, { exitCode: 0 }))
    .rejects.toThrow('TASK_EVALUATOR_INVALID');
  expect(loadEffect).not.toHaveBeenCalled();
});

const compensable = () => effectRecordSchema.parse({ ...record(), intent: { ...record().intent,
  descriptor: { ...record().intent.descriptor, compensation: { id: 'record.undo', version: 1 } } } });
const compensation = (state: EffectRecord['state'] = 'settled') => effectRecordSchema.parse({ ...record(state), sequence: 2,
  intent: { ...record(state).intent, command: { ...record(state).intent.command, commandId: 'undo-a', operation: { id: 'record.undo', version: 1 }, compensates: 'command-a' },
    descriptor: { ...record(state).intent.descriptor, operation: { id: 'record.undo', version: 1 } } } });
it('holds compensable effects when no trusted compensation reader is installed', async () => {
  expect(await evaluate(compensable())).toEqual({ verdict: 'unknown', reason: 'OPERATION_COMPENSATION_UNAVAILABLE', effectEvidence: observation(compensable()) });
});
it.each([['settled', 'fail', 'OPERATION_EVIDENCE_COMPENSATED'], ['unknown', 'unknown', 'OPERATION_COMPENSATION_UNSETTLED'],
  ['claimed', 'unknown', 'OPERATION_COMPENSATION_UNSETTLED']] as const)('detects a canonical %s compensation of the original immutable effect', async (state, verdict, reason) => {
  const original = compensable(), bytes = JSON.stringify(original), loadEffectCompensation = vi.fn(async () => compensation(state));
  expect(await evaluateOperationEvidence({ async loadEffect() { return original; }, loadEffectCompensation }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding)).toEqual({ verdict, reason, effectEvidence: observation(original, compensation(state)) });
  expect(loadEffectCompensation).toHaveBeenCalledExactlyOnceWith(identity.scopeId, 'command-a'); expect(JSON.stringify(original)).toBe(bytes);
});
it.each([null, compensation('refused')])('accepts the original only when compensation is absent or terminally refused (%#)', async value => {
  const result = await evaluateOperationEvidence({ async loadEffect() { return compensable(); }, async loadEffectCompensation() { return value; } }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding);
  expect(result.verdict).toBe('pass');
});
it.each(['scopeId', 'compensates', 'target', 'operation'] as const)('holds a compensation with mismatched %s', async field => {
  const next = compensation(), command = { ...next.intent.command, [field]: field === 'target' ? { kind: 'record', id: 'foreign' } : field === 'operation' ? { id: 'foreign', version: 1 } : 'foreign' };
  const result = await evaluateOperationEvidence({ async loadEffect() { return compensable(); }, async loadEffectCompensation() { return { ...next, intent: { ...next.intent, command } }; } }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding);
  expect(result).toEqual({ verdict: 'unknown', reason: 'OPERATION_COMPENSATION_BINDING', effectEvidence: observation(compensable()) });
});
it('observes a settled compensation before returning a binding failure, so the acceptance transaction sees the same evidence', async () => {
  const original = { ...compensable(), evidence: { ...compensable().evidence!, observedAt: 0 } }, undo = compensation('settled');
  expect(await evaluateOperationEvidence({ async loadEffect() { return original; }, async loadEffectCompensation() { return undo; } }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding))
    .toEqual({ verdict: 'unknown', reason: 'OPERATION_EVIDENCE_EARLIER', effectEvidence: observation(original, undo) });
});
it('holds malformed compensation and reader failure without any retry', async () => {
  const loadEffectCompensation = vi.fn(async () => { throw new Error('unavailable'); });
  const reader = { async loadEffect() { return compensable(); }, loadEffectCompensation };
  expect(await evaluateOperationEvidence(reader, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding)).toEqual({ verdict: 'unknown', reason: 'OPERATION_COMPENSATION_UNAVAILABLE', effectEvidence: observation(compensable()) });
  expect(loadEffectCompensation).toHaveBeenCalledTimes(1);
  expect(await evaluateOperationEvidence({ ...reader, async loadEffectCompensation() { return {}; } }, OPERATION_EVIDENCE_EVALUATOR, criterion, identity, binding)).toEqual({ verdict: 'unknown', reason: 'OPERATION_COMPENSATION_INVALID', effectEvidence: observation(compensable()) });
});

it('shares an exact previously accepted settlement digest, never an unrelated command or changed digest', async () => {
  const input = record(), digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const reader = { async loadEffect() { return input; } };
  for (const reference of [{ commandId: 'command-a', digest }, { commandId: 'unrelated', digest }, { commandId: 'command-a', digest: 'f'.repeat(64) }]) {
    const result = await evaluateOperationEvidence(reader, OPERATION_EVIDENCE_EVALUATOR, criterion, identity,
      { ...binding, notBefore: 2, acceptedSettlements: [reference] });
    expect(result.verdict).toBe(reference.commandId === 'command-a' && reference.digest === digest ? 'pass' : 'unknown');
    if (result.verdict !== 'pass') expect(result.reason).toBe('OPERATION_EVIDENCE_EARLIER');
  }
});
