import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { beuserEvaluatorPrincipalRef, verifiedPrincipalSchema, encodeCommandProjection, evaluatePolicy, type AuditRecord } from '#domain/index.js';
import { sha256, createHmacIntegrity } from '#platform/index.js';
import { beuserBindingSchema, beuserVerdictSchema } from '#domain/core/beuser/index.js';
import { pinBeuserLimits, pinBeuserWalkerSummary, type BeuserContext, type BeuserScreen } from '#engine/core/beuser-contract/index.js';
import { BeuserApplication, BeuserExecutionSupervisor, BeuserDispatch, pinBeuserCampaign, admitBeuserAttempt, recordBeuserRefusal, beuserRefusalEvent,
  type BeuserWalkPorts } from '#engine/core/beuser/index.js';
import { AuditApplication } from '#engine/core/audit/index.js';
import { NervousApplication, NERVOUS_RULES_SEED } from '#engine/core/nervous/index.js';
import type { ModelInvocationResult } from '#engine/core/model-invocation/index.js';
import type { ExecutionSupervisor, SupervisorProfileSource } from '#engine/core/supervisor/index.js';
import { DispatchApplication, type DispatchStore, type DispatchRecord } from '#engine/core/dispatch/index.js';

const summary = pinBeuserWalkerSummary({ schemaVersion: 1, personaId: 'persona', journeyId: 'journey', language: 'tr', role: 'buyer', goals: ['purchase'],
  knowledgeBoundary: ['customer'], accessibility: [], initialKnowledge: [], goal: 'request goods', competency: { computer: 1, domain: 4, product: 0 },
  preferences: [], riskAttitude: 'cautious', surface: 'terminal', organizationContext: { mode: 'enterprise' }, patience: { maxSteps: 4, maxWaitMs: 100 }, attentionMs: 1000 });
const limits = pinBeuserLimits({ schemaVersion: 1, revision: 'fixture', source: 'test-only', provisional: true, maxSteps: 5, maxWallMs: 3000,
  maxWaitMs: 100, maxCalls: 4, maxTokens: 100, maxCost: 1, currency: 'USD', maxReruns: 1, maxTranscriptBytes: 10000, maxArtifactBytes: 10000,
  cleanupDeadlineMs: 1000, criticalRepetitions: 2 });
const principal = verifiedPrincipalSchema.parse({ id: 'evaluator', ...beuserEvaluatorPrincipalRef({ issuer: 'host', subject: 'person' }), assurance: 'workload-verified', scopeIds: ['scope'] });
const binding = beuserBindingSchema.parse({ schemaVersion: 1, identity: { scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 },
  candidate: { adapter: 'erp', version: 'v1', evidenceRef: 'subject', stateDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }, candidateDigest: 'c'.repeat(64),
  personaDigest: sha256(encodeCommandProjection('beuser-persona:1', summary)), journeyDigest: 'd'.repeat(64), rubricDigest: 'e'.repeat(64), realmId: 'realm', nonce: '12345678-1234-4234-8234-123456789abc', transcriptId: 'transcript' });
function context(signal = new AbortController().signal): BeuserContext { return { binding, principal, limits, signal }; }
const invocation = { receipt: { outcome: { state: 'responded' } } } as unknown as ModelInvocationResult;
const green = beuserVerdictSchema.parse({ schemaVersion: 1, binding, transcriptDigest: 'f'.repeat(64), outcome: 'GREEN', authorization: 'pass', safety: 'pass', experience: 'pass', validity: 'valid', independence: 'independent', evidenceRefs: ['retained'] });
function harness() {
  let seq = 0, done = false;
  const screen = (): BeuserScreen => ({ binding, sequence: ++seq, text: done ? 'completed' : 'approval card', digest: (done ? '2' : '1').repeat(64) });
  const ports: { -readonly [K in keyof BeuserWalkPorts]: BeuserWalkPorts[K] } = {
    realm: { create: vi.fn(async () => ({ binding, state: 'created' as const, evidenceRefs: ['create'] })), admit: vi.fn(async () => ({ binding, state: 'admitted' as const, evidenceRefs: ['admit'] })),
      observe: vi.fn(async () => ({ binding, state: 'admitted' as const, evidenceRefs: ['observe'] })), destroy: vi.fn(async () => ({ binding, state: 'destroyed' as const, evidenceRefs: ['absence'] })), quarantine: vi.fn(async () => ({ binding, state: 'quarantined' as const, evidenceRefs: ['held'] })) },
    surface: { look: vi.fn(async () => screen()), press: vi.fn(async () => { done = true; return screen(); }), type: vi.fn(async () => screen()), wait: vi.fn(async () => screen()), argv: vi.fn(async () => screen()) },
    models: { walker: vi.fn(async () => ({ state: 'invoked' as const, receipt: { invocation, role: 'beuser-walker' as const, maker: 'maker' } })), evaluate: vi.fn(), cancel: vi.fn() },
    evidence: { append: vi.fn(), finalize: vi.fn(async () => ({ binding, transcriptDigest: green.transcriptDigest, evidenceRefs: ['retained'] })), readback: vi.fn(async () => ({ binding, verdict: green })) },
    decode: vi.fn(() => ({ schemaVersion: 1, binding, action: { kind: 'press', key: 'Enter' } })), finished: vi.fn(async s => s.text === 'completed'), record: vi.fn(), refusal: vi.fn(),
  };
  return { ports, app: new BeuserApplication(ports) };
}
function campaignInput() {
  return { run: { schemaVersion: 1, commandId: 'campaign', scopeId: 'scope', runId: 'run', graph: { schemaVersion: 4, revision: 1,
    tasks: [{ id: 'task', kind: 'journey-test', dependencies: [], acceptanceCriteria: ['journey'] }], criterionDefinitions: [{ id: 'journey', version: 1, description: 'retained journey', evaluator: { id: 'journey-walk', version: 1 }, parameters: {} }] } },
  candidate: binding.candidate, candidateDigest: binding.candidateDigest, limits, rubric: { schemaVersion: 1, journeyId: 'journey', version: 1, digest: binding.rubricDigest, parameters: {} },
  cells: [{ taskId: 'task', branchId: 'branch', journeyDigest: binding.journeyDigest, repeat: 1, summary }] };
}

it('pins one campaign Run and one Task per persona/branch/repeat without coding inputs or client workload assurance', () => {
  const profile = { taskKind: 'journey-test', evaluator: { id: 'journey-walk', version: 1 } };
  const input = campaignInput(), admitted = pinBeuserCampaign(input, profile);
  expect(admitBeuserAttempt(admitted, { binding, principal, signal: new AbortController().signal }).binding).toEqual(binding);
  expect(() => pinBeuserCampaign({ ...input, cells: [...input.cells, input.cells[0]] }, profile)).toThrow();
  expect(() => pinBeuserCampaign({ ...input, limits: {} }, profile)).toThrow('BEUSER_LIMITS_UNAVAILABLE');
  const exitOnly = campaignInput(); exitOnly.run.graph.criterionDefinitions[0]!.evaluator.id = 'process-exit';
  expect(() => pinBeuserCampaign(exitOnly, profile)).toThrow('BEUSER_INPUT_INVALID');
  expect(() => admitBeuserAttempt(admitted, { binding: { ...binding, journeyDigest: '0'.repeat(64) }, principal, signal: new AbortController().signal })).toThrow();
  expect(() => admitBeuserAttempt(admitted, { binding, principal: { ...principal, assurance: 'os-user' }, signal: new AbortController().signal })).toThrow();
  input.run.graph.tasks[0] = { ...input.run.graph.tasks[0]!, workClass: 'coding' } as typeof input.run.graph.tasks[number];
  expect(() => pinBeuserCampaign(input, profile)).toThrow('BEUSER_INPUT_INVALID');
});

it('walks the actual approval-card Enter action and consumes harness readback, never model verdict text or argv', async () => {
  const h = harness();
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'completed', cleanup: 'destroyed', verdict: { outcome: 'GREEN' } });
  expect(h.ports.surface.press).toHaveBeenCalledWith(expect.anything(), 'Enter');
  expect(h.ports.surface.argv).not.toHaveBeenCalled();
  expect(h.ports.models.walker).toHaveBeenCalledWith(expect.anything(), summary, expect.objectContaining({ text: 'approval card' }));
  expect(h.ports.evidence.readback).toHaveBeenCalledOnce();
});

it('an explicit allow still refuses the same Enter action on another nonce before dispatching it; audit precedes cleanup', async () => {
  const h = harness(), order: string[] = [];
  const ref = { issuer: principal.issuer, subject: principal.subject };
  expect(evaluatePolicy({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'named-grant', principals: [ref], scopes: ['scope'], actions: ['create'], resource: { kind: 'beuser-sandbox', ids: ['realm'] }, effect: 'allow' }] },
    { principal, scopeId: 'scope', resource: { kind: 'beuser-sandbox', id: 'realm' }, action: 'create' })).toMatchObject({ decision: 'allow' });
  h.ports.decode = vi.fn(() => ({ schemaVersion: 1, binding: { ...binding, nonce: '22345678-1234-4234-8234-123456789abc' }, action: { kind: 'press', key: 'Enter' } }));
  h.ports.refusal = vi.fn(async () => { order.push('sealed-refusal'); });
  h.ports.realm.destroy = vi.fn(async () => { order.push('destroy'); return { binding, state: 'destroyed' as const, evidenceRefs: ['absence'] }; });
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'invalid', reason: 'BEUSER_TARGET_NOT_SANDBOX' });
  expect(order).toEqual(['sealed-refusal', 'destroy']);
  expect(h.ports.surface.press).not.toHaveBeenCalled();
  expect(h.ports.evidence.finalize).not.toHaveBeenCalled();
});

it('failed refusal audit prevents every following effect and leaves realm custody unresolved', async () => {
  const h = harness();
  h.ports.decode = () => ({ schemaVersion: 1, binding: { ...binding, nonce: undefined }, action: { kind: 'press', key: 'Enter' } });
  h.ports.refusal = vi.fn(async () => { throw new Error('AUDIT_UNAVAILABLE'); });
  await expect(h.app.walk(context(), summary)).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect(h.ports.surface.press).not.toHaveBeenCalled();
  expect(h.ports.realm.destroy).not.toHaveBeenCalled();
  expect(h.ports.realm.quarantine).not.toHaveBeenCalled();
});

it('prompt-injected extra tools or verdict fields make the walk invalid instead of granting shell authority', async () => {
  const h = harness();
  h.ports.decode = () => ({ schemaVersion: 1, binding, action: { kind: 'press', key: 'Enter' }, verdict: 'GREEN', argv: ['approval', 'decide'] });
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'invalid', reason: 'drift' });
  expect(h.ports.surface.press).not.toHaveBeenCalled();
  expect(h.ports.surface.argv).not.toHaveBeenCalled();
});

it('stops a same-screen/action loop and enforces persona wait and step patience before the next effect', async () => {
  const loop = harness();
  loop.ports.decode = () => ({ schemaVersion: 1, binding, action: { kind: 'look' } });
  expect(await loop.app.walk(context(), summary)).toMatchObject({ state: 'unknown' as const, reason: 'loop' });
  expect(loop.ports.surface.look).toHaveBeenCalledTimes(2);
  const wait = harness();
  wait.ports.decode = () => ({ schemaVersion: 1, binding, action: { kind: 'wait', ms: 101 } });
  expect(await wait.app.walk(context(), summary)).toMatchObject({ state: 'unknown' as const, reason: 'bound' });
  expect(wait.ports.surface.wait).not.toHaveBeenCalled();
});

it('cancellation reaches an in-flight model; destruction without absence proof quarantines and cannot retain GREEN', async () => {
  const h = harness(), abort = new AbortController();
  h.ports.models.walker = vi.fn(async ctx => { expect(ctx.signal.aborted).toBe(false); abort.abort(); return new Promise<never>(() => {}); });
  h.ports.realm.destroy = vi.fn(async () => ({ binding, state: 'unknown' as const, evidenceRefs: [] }));
  expect(await h.app.walk(context(abort.signal), summary)).toMatchObject({ state: 'unknown' as const, cleanup: 'quarantined' });
  expect(h.ports.realm.quarantine).toHaveBeenCalledOnce();
  expect(h.ports.surface.press).not.toHaveBeenCalled();
});

it('rejects foreign harness readback and unbound persona before allowing acceptance or starting a realm', async () => {
  const h = harness();
  h.ports.evidence.readback = async () => ({ binding: { ...binding, transcriptId: 'foreign' }, verdict: green });
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'invalid' });
  const fresh = harness();
  await expect(fresh.app.walk(context(), { ...summary, goal: 'changed' })).rejects.toThrow('BEUSER_INPUT_INVALID');
  expect(fresh.ports.realm.create).not.toHaveBeenCalled();
});

it('seals the real refusal then a findable Nervous detection once; promotion and live recovery cannot execute this rule', async () => {
  const rows: AuditRecord[] = [];
  const audit = new AuditApplication({ append: (_event, seal) => { const row = seal(rows.length + 1); rows.push(row); return row; },
    load: (scope, id) => rows.find(row => row.event.scopeId === scope && row.event.eventId === id) ?? null,
    page: () => rows, increment: () => { throw new Error('unused'); }, counters: () => [] }, createHmacIntegrity('fixture', randomBytes(32)));
  const seed = NERVOUS_RULES_SEED as { rules: { id: string; status: string }[] };
  const liveInput = { ...seed, rules: seed.rules.map(rule => ({ ...rule, status: 'live' })) };
  const approval = { schemaVersion: 1, decisionRef: 'approved-card', approvedBy: { issuer: 'host', subject: 'person', assurance: 'os-user' }, approvedAtMs: 1, scopeIds: ['scope'], actions: ['alert-brain'] };
  const execute = vi.fn(), nervous = new NervousApplication({ audit, now: () => 10 }, liveInput, { live: true, approval, executors: { 'alert-brain': execute } });
  const ports = { audit, nervous, now: () => 10, policyRevision: 'p', nervousContext: { owner: { issuer: 'host', subject: 'person' }, policyRevision: 'p', promoted: () => true } };
  await recordBeuserRefusal(context(), ports);
  await recordBeuserRefusal(context(), ports);
  expect(rows).toHaveLength(2);
  const refusal = rows[0]!, detection = rows[1]!;
  expect(refusal.event.subject).toMatchObject({ kind: 'beuser-target-refusal', nonce: binding.nonce, identity: binding.identity });
  expect(detection.event.subject).toMatchObject({ kind: 'recovery-detection', rule: { id: 'beuser-target-refusal', status: 'provisional' },
    target: { attemptId: 'attempt', generation: 1 }, evidence: { source: { kind: 'beuser-target-refusal', eventId: refusal.event.eventId, sequence: 1 } } });
  expect(audit.load('scope', detection.event.eventId)).toEqual(detection);
  expect(execute).not.toHaveBeenCalled();
  expect(beuserRefusalEvent(context(), 'p', 99).eventId).toBe(refusal.event.eventId);
});

it('supervisor returns only attributed terminal harness files and preserves cancellation after walk abort', async () => {
  const request = { protocolVersion: 1 as const, identity: binding.identity, workspace: 'sandbox-workspace', argv: ['registered-harness'] };
  const terminal = { handle: 'custody-handle', result: { kind: 'exited' as const, exitCode: 0 }, worker: { kind: 'container' as const, id: 'a'.repeat(64), startedAt: '2026-10-29T00:00:00Z' },
    outputCompleteness: 'complete' as const, stdout: '', stderr: '', interrupted: false };
  const delegate: ExecutionSupervisor & SupervisorProfileSource = { captureProfile: vi.fn(async () => ({ schemaVersion: 1 as const, adapterId: 'beuser-fixture', adapterVersion: 1, parameters: {} })),
    execute: vi.fn(async () => terminal), observe: vi.fn(async () => terminal), cancel: vi.fn(async () => terminal), recoverOutput: vi.fn(async () => ({ stdout: '', stderr: '', completeness: 'partial' as const })), release: vi.fn() };
  const abort = new AbortController(), custody = { context: vi.fn(async () => context(abort.signal)), request: vi.fn(async () => request), attributed: vi.fn(async () => true), collect: vi.fn(async () => [{ name: 'harness', status: 'collected' as const, bytes: new Uint8Array([1]) }]), refusal: vi.fn() };
  const supervisor = new BeuserExecutionSupervisor(delegate, custody);
  await expect(supervisor.collectOutputFiles(request)).resolves.toHaveLength(1);
  abort.abort();
  await expect(supervisor.cancel(request)).resolves.toMatchObject({ handle: 'custody-handle' });
  custody.attributed.mockResolvedValue(false);
  await expect(supervisor.collectOutputFiles(request)).rejects.toMatchObject({ code: 'SUPERVISOR_IDENTITY_CONFLICT' });
  expect(custody.collect).toHaveBeenCalledTimes(1);
});

it('the real dispatch owner replays an uncertain launch without invoking the supervisor twice; foreign generations never reach it', async () => {
  const request = { protocolVersion: 1 as const, identity: binding.identity, workspace: 'workspace', argv: ['registered-harness'] };
  let current: DispatchRecord | null = null;
  const store: DispatchStore = {
    readDispatch: async () => current,
    claimDispatch: async input => { current = { schemaVersion: 2, ...input, launch: 'pending', terminal: null }; return { acquired: true, record: current }; },
    grantLaunch: async ({ principal: actor }) => { current = { ...current!, launch: 'granted', grant: { generation: 1, grantedAt: 1, principal: { id: actor.id, issuer: actor.issuer, subject: actor.subject } } }; return { kind: 'granted', record: current }; },
    requestDispatchCancellation: async () => current!, retainDispatchOutput: vi.fn(), finishDispatch: vi.fn(),
  };
  const execute = vi.fn(async (): Promise<never> => { throw new Error('transport uncertain'); });
  const delegate: ExecutionSupervisor & SupervisorProfileSource = { execute, captureProfile: async () => ({ schemaVersion: 1, adapterId: 'fixture', adapterVersion: 1, parameters: {} }),
    observe: vi.fn(), cancel: vi.fn(), recoverOutput: vi.fn(), release: vi.fn() };
  const original = new DispatchApplication(store, delegate, { verify: async () => principal }, { authorize: async () => {} }, 'custody-owner', { put: vi.fn(), read: vi.fn() });
  const refusal = vi.fn(), adapter = new BeuserDispatch(original, refusal, async () => request);
  await expect(adapter.execute(context(), request, null)).rejects.toThrow('transport uncertain');
  await expect(adapter.execute(context(), request, null)).resolves.toMatchObject({ kind: 'unresolved', record: { launch: 'granted' } });
  expect(execute).toHaveBeenCalledOnce();
  await expect(adapter.execute(context(), { ...request, identity: { ...binding.identity, generation: 2 } }, null)).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(refusal).toHaveBeenCalledOnce();
  await expect(adapter.execute(context(), { ...request, argv: ['approval', 'decide'] }, null)).rejects.toThrow('SUPERVISOR_REQUEST_INVALID');
  expect(execute).toHaveBeenCalledOnce();
});
