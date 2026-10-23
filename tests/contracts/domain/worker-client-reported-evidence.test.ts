import { describe, expect, it } from 'vitest';
import { modelUsageEvidenceSchema, modelVerificationSchemaVersion, readLegacyModelUsageEvidence, readWorkerModelPin, summarizeWorkerEvents, taskEvaluationModelSchema,
  taskModelConclusion, verifyWorkerModels, viewWorkerModels, workerEventSchema, workerModelPinSchema } from '#domain/index.js';

/** Owner Q4 2026-10-23: the Codex client's own log names the model (`turn_context.model`). The worker can rewrite that log, so the name is
 * its own evidence label `client-reported` — never `verified`, never `start-name-matched`; a differing name is held, never a substitution fail. */
describe('client-reported model evidence verdict (alpha.54 CX, owner Q4)', () => {
  const admitted = { modelId: 'gpt-6-luna', auxiliaryModelIds: [] as string[] };
  const verify = (startedModel: string | null, pin: Parameters<typeof verifyWorkerModels>[0]['admitted'] = admitted) =>
    verifyWorkerModels({ evidenceCapability: 'client-reported', admitted: pin, startedModel, usedModels: null });
  it('is a capability of its own next to the shipped three', () => {
    expect(modelUsageEvidenceSchema.options).toEqual(['session-events', 'session-start-name', 'client-reported', 'none']);
  });
  it('labels a name equal to the admitted exact id client-reported, never verified', () => {
    expect(verify('gpt-6-luna')).toEqual({ status: 'client-reported', admitted: 'gpt-6-luna', observed: ['gpt-6-luna'], unexpected: [] });
  });
  it('also labels a name the catalog records for the admitted model client-reported', () => {
    expect(verify('gpt-6-luna-2026', { ...admitted, reportedNames: ['gpt-6-luna-2026'] })).toMatchObject({ status: 'client-reported', unexpected: [] });
  });
  it('marks a differing name client-reported-mismatch, listing it, even when the catalog places it on another model (never substituted)', () => {
    expect(verify('gpt-6-astra')).toEqual({ status: 'client-reported-mismatch', admitted: 'gpt-6-luna', observed: ['gpt-6-astra'], unexpected: ['gpt-6-astra'] });
    expect(verify('gpt-6-astra', { ...admitted, reportedNames: ['gpt-6-luna'], otherReportedNames: ['gpt-6-astra'] })).toMatchObject({ status: 'client-reported-mismatch' });
    // An auxiliary id is no excuse: the client log names the session model.
    expect(verify('gpt-6-astra', { ...admitted, auxiliaryModelIds: ['gpt-6-astra'] })).toMatchObject({ status: 'client-reported-mismatch' });
  });
  it('is unverified without a reported name or without an admitted model', () => {
    expect(verify(null)).toEqual({ status: 'unverified', admitted: 'gpt-6-luna', observed: [], unexpected: [] });
    expect(verify('gpt-6-luna', null)).toEqual({ status: 'unverified', admitted: null, observed: ['gpt-6-luna'], unexpected: [] });
  });
});

describe('recorded compatibility of the client-reported verdicts', () => {
  const base = { sequence: 9, atMs: 1, kind: 'model.verification', admitted: 'gpt-6-luna', observed: ['gpt-6-luna'], unexpected: [] };
  it('seals only the two new statuses as v4; unverified stays v2', () => {
    expect(modelVerificationSchemaVersion({ status: 'client-reported', admitted: 'a', observed: [], unexpected: [], evidenceCapability: 'client-reported' })).toBe(4);
    expect(modelVerificationSchemaVersion({ status: 'client-reported-mismatch', admitted: 'a', observed: ['b'], unexpected: ['b'], evidenceCapability: 'client-reported' })).toBe(4);
    expect(modelVerificationSchemaVersion({ status: 'unverified', admitted: 'a', observed: [], unexpected: [], evidenceCapability: 'client-reported' })).toBe(2);
  });
  it('v4 accepts only the new statuses under client-reported; v2/v3 refuse them', () => {
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 4, evidenceCapability: 'client-reported', status: 'client-reported' }).success).toBe(true);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 4, evidenceCapability: 'client-reported', status: 'verified' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 4, evidenceCapability: 'session-events', status: 'client-reported' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 2, evidenceCapability: 'client-reported', status: 'client-reported' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 3, evidenceCapability: 'session-start-name', status: 'client-reported-mismatch' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...base, schemaVersion: 2, evidenceCapability: 'client-reported', status: 'unverified' }).success).toBe(true);
  });
  it('summarizes and views the sealed verdict', () => {
    const sealed = workerEventSchema.parse({ ...base, schemaVersion: 4, evidenceCapability: 'client-reported', status: 'client-reported-mismatch', observed: ['x'], unexpected: ['x'] });
    const summary = summarizeWorkerEvents([sealed]);
    expect(summary.modelVerification).toEqual({ status: 'client-reported-mismatch', unexpected: ['x'] });
    const pin = workerModelPinSchema.parse({ channelId: 'codex-cli-subscription', modelId: 'gpt-6-luna', auxiliaryModelIds: [] });
    expect(viewWorkerModels({ provider: 'codex', pin, evidenceCapability: 'client-reported', summary, evidence: 'sealed' })).toMatchObject({ verdict: 'client-reported-mismatch', unexpected: ['x'] });
  });
  it('reads a stamped client-reported pin; an unstamped legacy Codex pin predates the capability and reads as none', () => {
    const plain = { channelId: 'codex-cli-subscription', modelId: 'gpt-6-luna', auxiliaryModelIds: [] };
    expect(readWorkerModelPin({ nativeSubscription: { schemaVersion: 2, provider: 'codex', model: plain, modelUsageEvidence: 'client-reported' } }))
      .toMatchObject({ evidenceCapability: 'client-reported' });
    expect(readWorkerModelPin({ nativeSubscription: { schemaVersion: 2, provider: 'codex', model: plain } })).toMatchObject({ evidenceCapability: 'none' });
    expect(readLegacyModelUsageEvidence('codex')).toBe('none');
  });
});

describe('evaluation conclusion of client-reported evidence (owner Q4: match accepted as today, mismatch held, missing as today)', () => {
  const record = (verdict: string, evidenceCapability = 'client-reported') => taskEvaluationModelSchema.parse({ provider: 'codex',
    requested: { channelId: 'codex-cli-subscription', modelId: 'gpt-6-luna', auxiliaryModelIds: [] }, init: 'gpt-6-luna', usage: null, verdict,
    unexpected: verdict === 'client-reported-mismatch' ? ['gpt-6-astra'] : [], evidence: 'sealed', evidenceCapability });
  it('accepts a client-reported name by criteria, holds a differing name for a human, keeps a missing name accepted-unverified', () => {
    expect(taskModelConclusion(record('client-reported'))).toBe(null);
    expect(taskModelConclusion(record('client-reported-mismatch'))).toBe('unknown');
    expect(taskModelConclusion(record('unverified'))).toBe(null);
  });
  it('never fails an attempt on a forgeable client name, whatever capability the record names', () => {
    expect(taskModelConclusion(record('client-reported-mismatch', 'none'))).toBe('unknown');
  });
});
