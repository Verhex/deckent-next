import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planRun, inspectRun, configuredApproval } from '../../../src/index.js';
import { inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import { completeTerminalChatTurn } from '#composition/core/terminal-chat/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { exitCodeFor } from '#platform/index.js';
import { brainRunId } from '#engine/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { proposalFixture } from '../support/run-proposal.js';
import { clearConfigCache } from '#platform/index.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks(); });
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'brain-business', intent: 'Prepare a purchase and durable business readback' };
async function fixture(options: Parameters<typeof brainProviderFixture>[0] = {}) { const f = await brainProviderFixture(options); cleanups.push(f.close); return f; }
function counts(path: string) { const db = new DatabaseSync(path, { readOnly: true }); try {
  return { runs: Number(db.prepare('SELECT count(*) AS n FROM runs').get()!.n), proposals: Number(db.prepare('SELECT count(*) AS n FROM run_proposals').get()!.n) };
} finally { db.close(); } }
describe.skipIf(process.platform === 'win32')('Brain through the public SDK and a local priced provider', () => {
  it.each([
    { contextWindow: 1000, tokenCount: { count: 993, max_model_len: 2000 } },
    { contextWindow: 2000, tokenCount: { count: 993, max_model_len: 1000 } },
    { contextWindow: 1000, tokenCount: null },
    { contextWindow: 1000 },
  ])('refuses context overflow before model POST or proposal: %j', async settings => {
    const f = await fixture(settings);
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'BRAIN_CONTEXT_TOO_LARGE' });
    expect(f.posts).toBe(0); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
    expect(f.counterBodies.length).toBe(settings.tokenCount === undefined ? 0 : 1);
  });
  it('counts exactly the sent prompt, preserves v1 proposal replay after selecting v2, and never recounts successful replay', async () => {
    const f = await fixture({ contextWindow: 2000, tokenCount: { count: 10, max_model_len: 1000 } });
    const configPath = join(f.project, '.deckent/config.json');
    await writeFile(configPath, JSON.stringify({ ...f.config, brain_planner: { selected: { id: 'run-proposal', version: 1 } } })); clearConfigCache();
    const first = await planRun(f.project, command, f.options);
    expect(first.proposal.proposal.source).toMatchObject({ contribution: { template: { version: 1 } } });
    await writeFile(configPath, JSON.stringify({ ...f.config, brain_planner: { selected: { id: 'run-proposal', version: 2 } } })); clearConfigCache();
    expect(JSON.parse(f.counterBodies[0]!).messages).toEqual(JSON.parse(f.bodies[0]!).messages);
    expect(await planRun(f.project, command, f.options)).toEqual(first); expect(f.counterBodies).toHaveLength(1); expect(f.posts).toBe(1);
  });
  it.each([400, 413])('shows a definite provider rejection %s without exposing its body or resending', async rejectStatus => {
    const f = await fixture({ rejectStatus });
    for (let i = 0; i < 2; i++) await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'BRAIN_PROVIDER_REJECTED', params: { reason: 'http-status', status: rejectStatus } });
    expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it('keeps the unknown kind rule before proposal storage', async () => {
    const { graph, budgetCeiling, requiredPermissions } = proposalFixture('business');
    const f = await fixture({ response: JSON.stringify({ graph: { ...graph, tasks: [{ ...graph.tasks[0]!, kind: 'invented-kind' }] }, budgetCeiling, requiredPermissions }) });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'BRAIN_GRAPH_INVALID', params: { rule: 'TASK_KIND_NOT_REGISTERED' } });
    expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it('projects the actual scoped template worker model and billing through SDK without any prepared task prompt', async () => {
    const f = await fixture({ subscription: true, template: true, response: '{}' });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'BRAIN_OUTPUT_INVALID' });
    const context = JSON.parse(f.bodies[0]!).messages[1];
    const projection = JSON.parse(context.content).context.context;
    expect(projection.kinds).toEqual([{ kind: 'purchase', profile: { id: 'fixture-docker', version: 1 }, type: 'template', provider: 'claude' }]);
    expect(projection.workerModels).toHaveLength(1);
    expect(projection.workerModels[0]).toMatchObject({ channelId: 'claude-cli-subscription', modelId: 'claude-sonnet-5-5',
      auxiliaryModelIds: [], availableAuxiliaryModelIds: ['claude-sonnet-5-5'], billing: 'subscription' });
    expect(projection).not.toHaveProperty('registry'); expect(projection.scopePaths.state).toBe('not-inspected');
  });
  it('records a masked contribution and charged invocation; replay reads the same pending proposal without POST or Run', async () => {
    const f = await fixture(), input = { ...command, intent: command.intent + ' api_key=sk-fixture-do-not-send' };
    const first = await planRun(f.project, input, f.options);
    expect(first.proposal.status).toBe('pending'); expect(first.run).toBeNull(); expect(f.posts).toBe(1);
    const source = first.proposal.proposal.source;
    expect(source).toMatchObject({ kind: 'model', receipt: { reference: f.reference }, contribution: { schemaVersion: 1, activationRevision: 1,
      template: { version: 2 }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
    expect(f.bodies[0]).not.toContain('sk-fixture-do-not-send'); expect(JSON.stringify(first)).not.toContain('sk-fixture-do-not-send');
    expect(f.bodies[0]).toContain('[REDACTED]');
    expect(await planRun(f.project, input, f.options)).toEqual(first); expect(f.posts).toBe(1);
    const account = await inspectConfiguredProviderSpendAccount(f.project, { schemaVersion: 1, scopeId: 's', current: true }, f.options);
    expect(account.checkpoint?.account.settledMinorUnits).toBeGreaterThan(0); expect(account.checkpoint?.account.reservedMinorUnits).toBe(0);
    expect(counts(f.path)).toEqual({ runs: 0, proposals: 1 });
    for (const decision of ['allow', 'deny']) await expect(configuredApproval(f.project, 'decide', { schemaVersion: 1, commandId: 'headless-' + decision,
      scopeId: 's', approvalId: first.proposal.approval!.approvalId, expectedRevision: 0, decision, reason: 'Headless Brain proposal' }, f.options))
      .rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
    expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: brainRunId(input) }, f.options)).run).toBeNull();
    await expect(planRun(f.project, { ...input, intent: 'Changed request' }, f.options)).rejects.toMatchObject({ code: 'RUN_PROPOSAL_COMMAND_CONFLICT' });
    expect(f.posts).toBe(1);
  });
  it('explicit registry standing admission creates one Run and replays it, with the same general graph and evidence criteria', async () => {
    const f = await fixture({ standing: true }), first = await planRun(f.project, command, f.options);
    expect(first.proposal.status).toBe('accepted'); expect(first.run?.runId).toBe(brainRunId(command));
    expect(first.runtimeTotalSpendEnforced).toBe(false); expect(await planRun(f.project, command, f.options)).toEqual(first);
    expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 1, proposals: 1 });
  });
  it('rejects accessor-bearing intent before config, authentication or provider effects', async () => {
    let reads = 0;
    const input = Object.defineProperty({ ...command }, 'intent', { enumerable: true, get() { reads++; throw new Error('GETTER_CALLED'); } });
    await expect(planRun('uninitialized-fixture', input)).rejects.toMatchObject({ code: 'BRAIN_INPUT_INVALID' });
    expect(reads).toBe(0);
  });
  it.each([['missing', 'TERMINAL_CHAT_NOT_CONFIGURED'], ['inactive', 'MODEL_NOT_ACTIVATED']] as const)('refuses %s model without fallback or POST', async (model, code) => {
    const f = await fixture({ model }); await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code });
    if (model === 'inactive') {
      const error = await planRun(f.project, command, f.options).catch(error => error);
      expect(error.params).toMatchObject({ scope: 's', provider: f.reference.providerId, model: f.reference.modelId, revision: 0 });
      expect(exitCodeFor(error)).toBe(1);
      for (const locale of ['en', 'tr'] as const) {
        const message = error.localize(locale).message;
        expect(message).toContain(`${f.reference.providerId}@1/${f.reference.modelId}@1`);
        expect(message).toContain(locale === 'tr' ? 'kapsamında etkin değil' : 'not active in scope');
        expect(message).toContain('deckent models activate --scope s'); expect(message).toContain('/model');
      }
      await expect(completeTerminalChatTurn({ projectRoot: f.project, scopeId: 's', messages: [{ role: 'user', content: 'hello' }], options: f.options },
        { invoke: invokeConfiguredModel, cancel: async () => { throw new Error('MUST_NOT_CANCEL'); } })).rejects.toMatchObject({ code, params: error.params });
    }
    expect(f.posts).toBe(0); expect(counts(f.path).runs).toBe(0);
  });
  it.each([null, 0])('refuses unavailable/exhausted budget %s before the model', async budget => {
    const f = await fixture({ budget }); await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: budget === null ? 'RUN_PROPOSAL_BUDGET_MISSING' : 'RUN_PROPOSAL_BUDGET_EXCEEDED' });
    expect(f.posts).toBe(0); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it.each([['bad-json', 'json'], ['{}', 'schema']] as const)('retains %s failure without Run; invocation replay makes no second POST', async (response, stage) => {
    const f = await fixture({ response });
    for (let i = 0; i < 2; i++) await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'BRAIN_OUTPUT_INVALID', params: { stage } });
    expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it('aborting while the provider is waiting creates neither proposal nor Run; remote charge certainty is not fabricated', async () => {
    const f = await fixture({ hold: true }), controller = new AbortController(), pending = planRun(f.project, command, f.options, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'BRAIN_CANCELLED' });
    while (!f.bodies.length) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(); await assertion; expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it.each([null, 0, 1000])('local zero-tariff planning with subscription workers passes budget %s and enters the same Run approval chain', async budget => {
    const f = await fixture({ budget, noCharge: true, subscription: true }), first = await planRun(f.project, command, f.options);
    expect(first).toMatchObject({ budgetSemantics: 'not-metered', proposal: { status: 'pending', binding: { admission: { budget: null } } } });
    expect(first.proposal.approval).not.toBeNull(); expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 0, proposals: 1 });
    const inspected = await inspectConfiguredProviderSpendAccount(f.project, { schemaVersion: 1, scopeId: 's', current: true }, f.options);
    expect(inspected.checkpoint).toBeNull();
    expect(await planRun(f.project, command, f.options)).toEqual(first); expect(f.posts).toBe(1);
  });
  it('configured budget without a ledger account supports local free planning and metered/unknown worker admission', async () => {
    const f = await fixture({ noCharge: true, standing: true }), first = await planRun(f.project, command, f.options);
    expect(first).toMatchObject({ budgetSemantics: 'admission-check-only', proposal: { status: 'accepted', binding: { admission: { budget: { source: 'configured' } } } } });
    expect(first.run).not.toBeNull(); expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 1, proposals: 1 });
    expect((await inspectConfiguredProviderSpendAccount(f.project, { schemaVersion: 1, scopeId: 's', current: true }, f.options)).checkpoint).toBeNull();
  });
  it('subscription workers do not waive a metered planning call budget', async () => {
    const f = await fixture({ subscription: true, budget: null });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'RUN_PROPOSAL_BUDGET_MISSING' });
    expect(f.posts).toBe(0); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it('subscription standing admission creates a durable Run despite a zero money ceiling', async () => {
    const f = await fixture({ subscription: true, noCharge: true, budget: 0, standing: true }), first = await planRun(f.project, command, f.options);
    expect(first).toMatchObject({ budgetSemantics: 'not-metered', proposal: { status: 'accepted' } });
    expect(first.run?.proposal?.admission).toMatchObject({ budgetSemantics: 'not-metered', budget: null });
    expect(counts(f.path)).toEqual({ runs: 1, proposals: 1 }); expect(await planRun(f.project, command, f.options)).toEqual(first);
  });

  it('local no-charge planning with only metered/unknown worker targets and no budget refuses before POST', async () => {
    const f = await fixture({ noCharge: true, budget: null });
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'RUN_PROPOSAL_BUDGET_MISSING' });
    expect(f.posts).toBe(0); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });

});
