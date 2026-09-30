import { describe, expect, it } from 'vitest';
import { compileNativeCodingDockerProfile, createNormalizerState, normalizeClaudeLine, resolveDockerTaskProfile } from '#adapters/index.js';
import { summarizeWorkerEvents, verifyWorkerModels, workerEventSchema } from '#domain/index.js';
import { prepareNativeCodingProfile } from '../../../src/index.js';

const template = () => ({ id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2,
  tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } });
const pinned = (provider = 'claude', modelId = 'claude-sonnet-5-5', auxiliaryModelIds: string[] = ['claude-haiku-4-5-20251001']) => ({
  schemaVersion: 4, provider, cliVersion: '2.1.285 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended',
  model: { channelId: 'claude-cli-subscription', modelId, auxiliaryModelIds }, prompt: 'Edit note.txt.' });
const legacy = (model: string) => ({ ...pinned(), schemaVersion: 3, model });

describe('native coding profile v4: exact catalog model reference', () => {
  it('writes the exact id to argv and the catalog reference to nativeSubscription v2; helper models are declared, never flags', () => {
    const profile = compileNativeCodingDockerProfile(template(), pinned());
    const { argv, nativeSubscription } = resolveDockerTaskProfile(profile);
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(nativeSubscription).toMatchObject({ schemaVersion: 2, provider: 'claude',
      model: { channelId: 'claude-cli-subscription', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: ['claude-haiku-4-5-20251001'] } });
    expect(argv).not.toContain('claude-haiku-4-5-20251001');
  });
  it.each(['codex', 'claude', 'cursor'])('never passes a fallback model for %s', provider => {
    const { argv } = resolveDockerTaskProfile(compileNativeCodingDockerProfile(template(), pinned(provider, 'exact-model-1', [])));
    expect(argv.filter(arg => arg.includes('fallback'))).toEqual([]);
    expect(argv.filter(arg => arg === '--model')).toHaveLength(1);
  });
  it.each([
    ['CLI alias as v4 model', pinned('claude', 'sonnet')], ['CLI alias as helper model', pinned('claude', 'claude-sonnet-5-5', ['haiku'])],
    ['moving -latest name', pinned('claude', 'claude-sonnet-latest')], ['1M alias', pinned('claude', 'opus[1m]')],
    ['CLI alias in a legacy v3 string', legacy('opus')], ['default is not a model', legacy('default')],
  ])('refuses %s with a typed code at compile and at prepare', (_name, invocation) => {
    expect(() => compileNativeCodingDockerProfile(template(), invocation)).toThrow('WORKER_MODEL_ALIAS_REFUSED');
    expect(() => prepareNativeCodingProfile({ schemaVersion: 1, template: template(), invocation })).toThrow(expect.objectContaining({ code: 'WORKER_MODEL_ALIAS_REFUSED' }));
  });
  it('keeps structural invalidity separate from alias refusal and never accepts an option-like model', () => {
    for (const invocation of [{ ...pinned(), model: 'claude-sonnet-5-5' }, { ...pinned(), schemaVersion: 3 }, pinned('claude', '--fallback-model')]) {
      expect(() => compileNativeCodingDockerProfile(template(), invocation)).toThrow('NATIVE_CODING_INVOCATION_INVALID');
    }
    // A nativeSubscription v2 without its model reference (or v1 with one) is not a valid profile.
    const profile = compileNativeCodingDockerProfile(template(), pinned());
    const withoutModel = Object.fromEntries(Object.entries(profile.parameters.nativeSubscription as Record<string, unknown>).filter(([key]) => key !== 'model'));
    expect(() => resolveDockerTaskProfile({ ...profile, parameters: { ...profile.parameters, nativeSubscription: withoutModel } })).toThrow('DOCKER_TASK_PROFILE_INVALID');
    expect(() => resolveDockerTaskProfile({ ...profile, parameters: { ...profile.parameters,
      nativeSubscription: { ...(profile.parameters.nativeSubscription as object), schemaVersion: 1 } } })).toThrow('DOCKER_TASK_PROFILE_INVALID');
  });
});

/** Real Claude Code result lines (proof ANTHROPIC-PROVIDER / PERSISTENT-APPROVALS 2026-09-28), usage values trimmed. */
const result = (modelUsage: Record<string, object>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 10,
  usage: { input_tokens: 1, output_tokens: 1 }, modelUsage });
const init = (model: string) => JSON.stringify({ type: 'system', subtype: 'init', model, claude_code_version: '2.1.285', cwd: '/w' });
const events = (model: string, usage: Record<string, object>) => {
  const state = createNormalizerState([], 0);
  return [...normalizeClaudeLine(init(model), state, 1), ...normalizeClaudeLine(result(usage), state, 2)].map(event => workerEventSchema.parse(event));
};
const admitted = { modelId: 'claude-sonnet-5-5', auxiliaryModelIds: ['claude-haiku-4-5-20251001'] };
const verdict = (list: ReturnType<typeof events>, admittedModel: typeof admitted | null = admitted, provider: 'claude' | 'codex' | 'cursor' = 'claude') => {
  const started = list.find(event => event.kind === 'session.started'), ended = list.find(event => event.kind === 'session.ended');
  return verifyWorkerModels({ provider, admitted: admittedModel, startedModel: started?.kind === 'session.started' ? started.model : null,
    usedModels: ended?.kind === 'session.ended' ? ended.models ?? null : null });
};

describe('post-run model verification (Claude result.modelUsage keys)', () => {
  it('records every modelUsage key on session.ended, sorted, and keeps old events without the field valid', () => {
    const list = events('claude-sonnet-5-5', { 'claude-sonnet-5-5': { costBasis: 'list' }, 'claude-haiku-4-5-20251001': { costBasis: 'list' } });
    expect(list.at(-1)).toMatchObject({ kind: 'session.ended', models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'], costBasis: 'list' });
    expect(workerEventSchema.safeParse({ schemaVersion: 1, sequence: 1, atMs: 0, kind: 'session.ended', outcome: 'success', turns: 1, durationMs: 1,
      apiDurationMs: null, costUsd: null, costBasis: null, tokens: null, permissionDenials: 0 }).success).toBe(true);
  });
  it('is verified for the admitted model plus its declared helper (the shape of 4 of 5 real runs)', () => {
    expect(verdict(events('claude-sonnet-5-5', { 'claude-sonnet-5-5': {}, 'claude-haiku-4-5-20251001': {} })))
      .toEqual({ status: 'verified', admitted: 'claude-sonnet-5-5', observed: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'], unexpected: [] });
  });
  it('flags WORKER_MODEL_SUBSTITUTED for an undeclared helper, a subagent model (the 5th real run) and a fallback start model', () => {
    const helper = events('claude-sonnet-5-5', { 'claude-sonnet-5-5': {}, 'claude-haiku-4-5-20251001': {} });
    expect(verdict(helper, { modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] })).toMatchObject({ status: 'substituted', unexpected: ['claude-haiku-4-5-20251001'] });
    expect(verdict(events('claude-sonnet-5-5', { 'claude-sonnet-5-5': {}, 'claude-fable-5-1': {} }))).toMatchObject({ status: 'substituted', unexpected: ['claude-fable-5-1'] });
    expect(verdict(events('claude-opus-5-5', { 'claude-opus-5-5': {} }))).toMatchObject({ status: 'substituted', unexpected: ['claude-opus-5-5'] });
    // Started on a declared helper instead of the admitted model: still a substitution.
    expect(verdict(events('claude-haiku-4-5-20251001', { 'claude-haiku-4-5-20251001': {} }))).toMatchObject({ status: 'substituted', unexpected: ['claude-haiku-4-5-20251001'] });
  });
  it('is unverified, never verified, without per-model evidence: Codex/Cursor, v1 profiles, or no modelUsage', () => {
    const list = events('claude-sonnet-5-5', { 'claude-sonnet-5-5': {} });
    expect(verdict(list, admitted, 'codex')).toMatchObject({ status: 'unverified', unexpected: [] });
    expect(verdict(list, admitted, 'cursor')).toMatchObject({ status: 'unverified' });
    expect(verdict(list, null)).toMatchObject({ status: 'unverified', admitted: null });
    expect(verifyWorkerModels({ provider: 'claude', admitted, startedModel: 'claude-sonnet-5-5', usedModels: null })).toMatchObject({ status: 'unverified' });
  });
  it('summarizes the reported models and the sealed host verdict', () => {
    const list = events('claude-sonnet-5-5', { 'claude-sonnet-5-5': {}, 'claude-fable-5-1': {} });
    const sealed = [...list, workerEventSchema.parse({ schemaVersion: 1, sequence: 99, atMs: 3, kind: 'model.verification', ...verdict(list) })];
    expect(summarizeWorkerEvents(sealed)).toMatchObject({ models: ['claude-fable-5-1', 'claude-sonnet-5-5'],
      modelVerification: { status: 'substituted', unexpected: ['claude-fable-5-1'] } });
    expect(summarizeWorkerEvents(list)).toMatchObject({ modelVerification: null });
  });
});
