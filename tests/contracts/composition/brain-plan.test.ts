import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planRun, inspectRun, inspectRunProposal, configuredApproval, reserveRunTasks } from '../../../src/index.js';
import { inspectConfiguredProviderSpendAccount } from '#composition/core/provider-spend/index.js';
import { completeTerminalChatTurn } from '#composition/core/terminal-chat/index.js';
import { invokeConfiguredModel } from '#composition/core/model-invocation/index.js';
import { exitCodeFor } from '#platform/index.js';
import { brainRunId } from '#engine/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { proposalFixture } from '../support/run-proposal.js';
import { brainProposalLines } from '#surfaces/core/run-planning/index.js';
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
    // BeUser D-02: the refusal names the kind the model used and the registered kinds (EN/TR), so the person can ask again or register it.
    const refused = await planRun(f.project, command, f.options).then(() => null, (error: { code: string; params?: Record<string, unknown>; localize: (l: 'en' | 'tr') => { message: string } }) => error);
    expect(refused).toMatchObject({ code: 'BRAIN_GRAPH_INVALID', params: { rule: 'TASK_KIND_NOT_REGISTERED', kinds: 'invented-kind', registered: 'purchase' } });
    expect(refused!.localize('en').message).toContain('task kind invented-kind'); expect(refused!.localize('tr').message).toContain('/setup (İlk iş türü)');
    expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 0, proposals: 0 });
  });
  it('projects the actual scoped template worker model and billing through SDK without any prepared task prompt', async () => {
    const f = await fixture({ subscription: true, template: true, response: '{}' });
    // Worker models are offered only by a template that lets the Brain pin one (v2); the default v3 (ATAMA-1) offers none, checked below.
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ ...f.config, brain_planner: { selected: { id: 'run-proposal', version: 2 } } })); clearConfigCache();
    await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: 'BRAIN_OUTPUT_INVALID' });
    const context = JSON.parse(f.bodies[0]!).messages[1];
    const projection = JSON.parse(context.content).context.context;
    expect(projection.kinds).toEqual([{ kind: 'purchase', profile: { id: 'fixture-docker', version: 1 }, type: 'template', provider: 'claude', turnLimit: 'supported' }]);
    expect(projection.workerModels).toHaveLength(1);
    expect(projection.workerModels[0]).toMatchObject({ channelId: 'claude-cli-subscription', modelId: 'claude-sonnet-5-5',
      auxiliaryModelIds: [], availableAuxiliaryModelIds: ['claude-sonnet-5-5'], billing: 'subscription' });
    expect(projection).not.toHaveProperty('registry'); expect(projection.scopePaths.state).toBe('not-inspected');
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify(f.config)); clearConfigCache();
    await expect(planRun(f.project, { ...command, commandId: 'brain-v3' }, f.options)).rejects.toMatchObject({ code: 'BRAIN_OUTPUT_INVALID' });
    const v3 = JSON.parse(JSON.parse(f.bodies.at(-1)!).messages[1].content).context.context;
    expect(v3.kinds).toEqual(projection.kinds); expect(v3.workerModels).toEqual([]);
  });
  it('records a masked contribution and charged invocation; replay reads the same pending proposal without POST or Run', async () => {
    const f = await fixture(), input = { ...command, intent: command.intent + ' api_key=sk-fixture-do-not-send' };
    const first = await planRun(f.project, input, f.options);
    expect(first.planningSpending).toMatchObject({ class: 'metered', currency: 'USD', evidence: 'measured-tariff' });
    expect(first.planningSpending!.amountMinorUnits).toBeGreaterThan(0);
    expect(first.proposal.status).toBe('pending'); expect(first.run).toBeNull(); expect(f.posts).toBe(1);
    const source = first.proposal.proposal.source;
    expect(source).toMatchObject({ kind: 'model', receipt: { reference: f.reference }, contribution: { schemaVersion: 2, billingAxis: 'metered', activationRevision: 1,
      template: { version: 4 }, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
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
    const f = await fixture({ budget }); await expect(planRun(f.project, command, f.options)).rejects.toMatchObject({ code: budget === null ? 'RUN_PROPOSAL_BUDGET_MISSING' : 'RUN_PROPOSAL_BUDGET_EXCEEDED',
      ...(budget === 0 ? { params: { remaining: 0, currency: 'USD' } } : {}) });
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
    expect(first.planningSpending).toMatchObject({ class: 'not-metered', amountMinorUnits: null, evidence: 'unknown' });
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

it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] paid planning with subscription workers projects its own settled cost and read-only inspection reuses it', async () => {
  const f = await fixture({ subscription: true }), first = await planRun(f.project, command, f.options);
  expect(first).toMatchObject({ budgetSemantics: 'not-metered', planningSpending: { class: 'metered', currency: 'USD', evidence: 'measured-tariff' } });
  expect(first.planningSpending!.amountMinorUnits).toBeGreaterThan(0);
  const query = { schemaVersion: 1 as const, scopeId: 's', runId: first.proposal.proposal.runId, commandId: command.commandId };
  expect((await inspectRunProposal(f.project, query, f.options))!.planningSpending).toEqual(first.planningSpending);
  expect(await planRun(f.project, command, f.options)).toEqual(first); expect(f.posts).toBe(1);
});

it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] proposal inspection with denied invocation inspection withholds spending and sends no model request', async () => {
  const f = await fixture({ subscription: true }), first = await planRun(f.project, command, f.options);
  // First establish the fixture's admitted card, then remove only the spending observation grant.
  const path = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(path, 'utf8'));
  policy.revision = 'observation-denied';
  policy.grants = policy.grants.map((row: { id: string; actions: string[] }) => row.id === 'invocation' ? { ...row, actions: ['invoke'] } : row);
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  const inspected = await inspectRunProposal(f.project, { schemaVersion: 1, scopeId: 's', runId: first.proposal.proposal.runId, commandId: command.commandId }, f.options);
  expect(inspected!.planningSpending).toEqual({ class: 'unknown', currency: null, amountMinorUnits: null, evidence: 'unknown' });
  expect(first.planningSpending!.amountMinorUnits).toBeGreaterThan(0); expect(f.posts).toBe(1);
});

it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] the system narrows a Brain ceiling that copies the limit to the remaining money; the model number never widens and the prompt stays replay-stable', async () => {
  const { graph, requiredPermissions } = proposalFixture('business');
  // Live 2026-10-17: the model copied the 100 USD limit after 12.17 USD was spent and every plan was refused RUN_PROPOSAL_BUDGET_EXCEEDED.
  const f = await fixture({ standing: true, response: JSON.stringify({ graph, budgetCeiling: { currency: 'USD', limitMinorUnits: 1000 }, requiredPermissions }) });
  const first = await planRun(f.project, command, f.options), settled = first.planningSpending!.amountMinorUnits!;
  expect(settled).toBeGreaterThan(0);
  expect(first.proposal).toMatchObject({ status: 'accepted', proposal: { budgetCeiling: { currency: 'USD', limitMinorUnits: 1000 - settled } },
    binding: { admission: { budget: { remainingMinorUnits: 1000 - settled } } } });
  expect(JSON.parse(JSON.parse(f.bodies[0]!).messages[1].content).context.context.budget).toEqual({ currency: 'USD', limitMinorUnits: 1000 });
  expect(await planRun(f.project, command, f.options)).toEqual(first); expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 1, proposals: 1 });
});
it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] keeps a smaller Brain ceiling as authored', async () => {
  const { graph, requiredPermissions } = proposalFixture('business');
  const f = await fixture({ response: JSON.stringify({ graph, budgetCeiling: { currency: 'USD', limitMinorUnits: 7 }, requiredPermissions }) });
  expect((await planRun(f.project, command, f.options)).proposal.proposal.budgetCeiling).toEqual({ currency: 'USD', limitMinorUnits: 7 });
});
// Live 2026-10-18 (deepseek-flash): the model listed run/scope/model-invocation entries for a model the plan never uses, and the plan was refused
// POLICY_DENIED. The system derives what admission evaluates from the validated graph; the model's list is advisory and never a requirement.
const invented = (resourceId: string) => [{ kind: 'task', action: 'execute', resourceId: 'task' }, { kind: 'attempt', action: 'execute', resourceId: 'task' },
  { kind: 'run', action: 'create', resourceId: 'docs-version-label-update' }, { kind: 'run', action: 'reserve', resourceId: 'docs-version-label-update' },
  { kind: 'scope', action: 'inspect', resourceId: 'live' }, { kind: 'model-invocation', action: 'invoke', resourceId },
  // accept_mark (owner 2026-10-18): an unregistered kind and a repeated entry are marked on the card, never a refusal.
  { kind: 'erp-ledger', action: 'post', resourceId: 'invoice' }, { kind: 'scope', action: 'inspect', resourceId: 'live' }];
it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] invented model permissions are advisory: a policy that grants only the real needs admits the plan and the card names them', async () => {
  const { graph, budgetCeiling } = proposalFixture('business');
  const f = await fixture({ standing: true, response: JSON.stringify({ graph, budgetCeiling, requiredPermissions: invented('gpt-6.1-sol') }) });
  const first = await planRun(f.project, command, f.options);
  expect(first.proposal).toMatchObject({ status: 'accepted', reason: null }); expect(first.run).not.toBeNull();
  // The model's list is kept as authored (digest/replay unchanged); it is shown as advisory, never evaluated.
  expect(first.proposal.proposal.requiredPermissions).toEqual(invented('gpt-6.1-sol'));
  for (const locale of ['en', 'tr'] as const) {
    const lines = brainProposalLines(first, locale).join('\n');
    expect(lines).toContain(locale === 'tr' ? 'Başlatılırken policy\'nin denetlediği izinler: task/execute/task' : 'Permissions checked by policy at admission: task/execute/task');
    expect(lines).toContain(locale === 'tr' ? 'Modelin ayrıca andığı izinler (yalnız bilgi, değerlendirilmedi, yetki vermez)' : 'The model also mentioned (advisory, not evaluated, grants nothing)');
    expect(lines).toContain('model-invocation/invoke/gpt-6.1-sol'); expect(lines).toContain('scope/inspect/live');
    expect(lines).toContain(locale === 'tr' ? 'Bu kurulumda tanınmayan izinler (yalnız bilgi, değerlendirilmedi, yetki vermez): erp-ledger/post/invoice'
      : 'Not recognised by this installation (advisory, not evaluated, grants nothing): erp-ledger/post/invoice');
    for (const entry of ['scope/inspect/live', 'erp-ledger/post/invoice']) expect(lines.split(entry)).toHaveLength(2);
  }
  expect(first.unrecognisedPermissions).toEqual([{ kind: 'erp-ledger', action: 'post', resourceId: 'invoice' }]);
  expect(await planRun(f.project, command, f.options)).toEqual(first); expect(f.posts).toBe(1); expect(counts(f.path)).toEqual({ runs: 1, proposals: 1 });
});
// g4-cift-onay (owner-approved 2026-10-18): the task approval moves from plan time to execution time. The floor is kept, not dropped: the plan
// is admitted without a plan card, and the first reservation asks the task approval (TaskApprovalAdmission) and runs nothing until it is decided.
it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] a task require-approval is asked once, at reservation, not on the plan', async () => {
  const { graph, budgetCeiling } = proposalFixture('business');
  const f = await fixture({ standing: true, response: JSON.stringify({ graph, budgetCeiling, requiredPermissions: [] }) });
  const path = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(path, 'utf8')), owner = policy.grants[0].principals;
  policy.revision = 'task-asked'; policy.grants[0].actions.push('reserve');
  policy.grants.push({ id: 'ask-task', effect: 'require-approval', actions: ['execute'], scopes: ['s'], principals: owner, resource: { kind: 'task', ids: ['task'] } });
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  const list = () => configuredApproval(f.project, 'list', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 }, f.options) as Promise<{ status: string; request: Record<string, unknown> }[]>;
  const planned = await planRun(f.project, command, f.options);
  expect(planned.proposal).toMatchObject({ status: 'accepted', reason: null }); expect(planned.run).not.toBeNull(); expect(await list()).toEqual([]);
  const run = planned.run!;
  await expect(reserveRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: run.runId, expectedRevision: run.revision }, f.options))
    .rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
  expect(await list()).toEqual([expect.objectContaining({ status: 'pending', request: expect.objectContaining({ runId: run.runId, taskId: 'task' }) })]);
  expect((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: run.runId }, f.options)).run!.tasks.map(task => task.phase)).toEqual(['pending']);
});
it.skipIf(process.platform === 'win32')('[unsupported on Windows: managed private ledger files] a real need the policy denies still refuses the plan, even when the model lists nothing', async () => {
  const { graph, budgetCeiling } = proposalFixture('business');
  const f = await fixture({ standing: true, response: JSON.stringify({ graph, budgetCeiling, requiredPermissions: [] }) });
  const path = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(path, 'utf8')), owner = policy.grants[0].principals;
  policy.revision = 'task-denied';
  policy.grants.push({ id: 'no-task', effect: 'deny', actions: ['execute'], scopes: ['s'], principals: owner, resource: { kind: 'task', ids: ['task'] } });
  await writeFile(path, JSON.stringify(policy), { mode: 0o600 });
  const refused = await planRun(f.project, command, f.options);
  expect(refused.proposal).toMatchObject({ status: 'rejected', reason: 'POLICY_DENIED' }); expect(refused.run).toBeNull();
  expect(counts(f.path)).toEqual({ runs: 0, proposals: 1 });
});
