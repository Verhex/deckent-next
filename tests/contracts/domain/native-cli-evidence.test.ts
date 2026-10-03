import { expect, it } from 'vitest';
import { nativeCliIds, nativeCliIdSchema, providerIdSchema, readWorkerModelPin, taskEvaluationModelSchema, taskModelConclusion, verifyWorkerModels, workerEventSchema } from '#domain/index.js';

const requested = { channelId: 'native', modelId: 'exact-model', auxiliaryModelIds: [] };
const pin = (provider: string, modelUsageEvidence?: string) => ({ nativeSubscription: { schemaVersion: 2, provider, model: requested,
  ...(modelUsageEvidence === undefined ? {} : { modelUsageEvidence }) } });
const model = { provider: 'codex', requested, init: null, usage: null, verdict: 'unverified', unexpected: [], evidence: 'absent' };

it('derives the accepted native ids from the registry and refuses unknown ids', () => {
  for (const id of nativeCliIds) expect(nativeCliIdSchema.parse(id)).toBe(id);
  expect(nativeCliIdSchema.safeParse('unknown-cli').success).toBe(false);
  const injected = providerIdSchema(['installed-extra']);
  expect(injected.parse('installed-extra')).toBe('installed-extra');
  expect(injected.safeParse(nativeCliIds[0]).success).toBe(false);
  expect(() => providerIdSchema([])).toThrow('PROVIDER_ID_VOCABULARY_INVALID');
  expect(() => providerIdSchema(['duplicate', 'duplicate'])).toThrow('PROVIDER_ID_VOCABULARY_INVALID');
});
it('verifies using explicit capability even when the provider id disagrees', () => {
  const input = { provider: 'codex' as const, evidenceCapability: 'session-events' as const, admitted: requested, startedModel: 'exact-model', usedModels: ['exact-model'] };
  expect(JSON.stringify(verifyWorkerModels(input))).toBe('{"status":"verified","admitted":"exact-model","observed":["exact-model"],"unexpected":[]}');
  expect(verifyWorkerModels({ ...input, provider: 'claude', evidenceCapability: 'none' }).status).toBe('unverified');
});
it('reads stamped capabilities and migrates only absent legacy profile evidence', () => {
  expect(readWorkerModelPin(pin('codex', 'session-events'))).toMatchObject({ evidenceCapability: 'session-events' });
  expect(readWorkerModelPin(pin('claude', 'none'))).toMatchObject({ evidenceCapability: 'none' });
  for (const provider of nativeCliIds) expect(readWorkerModelPin(pin(provider))).toMatchObject({ evidenceCapability: provider === 'claude' ? 'session-events' : 'none' });
  expect(readWorkerModelPin(pin('codex', 'invalid'))).toBe(null);
  expect(readWorkerModelPin(pin('unknown-cli'))).toBe(null);
});
it('gates task model evidence by input capability, with a bounded legacy record read migration', () => {
  expect(taskModelConclusion(taskEvaluationModelSchema.parse({ ...model, evidenceCapability: 'session-events' }))).toBe('unknown');
  expect(taskModelConclusion(taskEvaluationModelSchema.parse({ ...model, provider: 'claude', evidenceCapability: 'none' }))).toBe(null);
  expect(taskEvaluationModelSchema.parse(model)).toMatchObject({ evidenceCapability: 'none' });
  expect(taskEvaluationModelSchema.parse({ ...model, provider: 'claude' })).toMatchObject({ evidenceCapability: 'session-events' });
  expect(taskEvaluationModelSchema.safeParse({ ...model, evidenceCapability: 'invalid' }).success).toBe(false);
});
it('keeps recorded v1 events readable byte-for-byte and requires capability for host verdict v2', () => {
  const legacy = { schemaVersion: 1, sequence: 1, atMs: 1, kind: 'model.verification', status: 'unverified', admitted: 'exact-model', observed: [], unexpected: [] };
  expect(JSON.stringify(workerEventSchema.parse(legacy))).toBe(JSON.stringify(legacy));
  expect(workerEventSchema.safeParse({ ...legacy, schemaVersion: 2 }).success).toBe(false);
  expect(workerEventSchema.parse({ ...legacy, schemaVersion: 2, evidenceCapability: 'none' })).toMatchObject({ evidenceCapability: 'none' });
});


it('preserves the shipped CLI verification and evaluation conclusion fixture bytes', () => {
  const fixtures = [
    { provider: 'claude' as const, status: 'verified', conclusion: null },
    { provider: 'codex' as const, status: 'unverified', conclusion: null },
    { provider: 'cursor' as const, status: 'unverified', conclusion: null },
  ];
  for (const fixture of fixtures) {
    const migrated = readWorkerModelPin(pin(fixture.provider))!;
    const verdict = verifyWorkerModels({ provider: fixture.provider, evidenceCapability: migrated.evidenceCapability, admitted: requested,
      startedModel: 'exact-model', usedModels: ['exact-model'] });
    expect(JSON.stringify(verdict)).toBe(JSON.stringify({ status: fixture.status, admitted: 'exact-model', observed: ['exact-model'], unexpected: [] }));
    const conclusion = taskModelConclusion(taskEvaluationModelSchema.parse({ ...model, provider: fixture.provider, verdict: fixture.status,
      evidenceCapability: migrated.evidenceCapability }));
    expect(JSON.stringify({ conclusion })).toBe(JSON.stringify({ conclusion: fixture.conclusion }));
  }
});
