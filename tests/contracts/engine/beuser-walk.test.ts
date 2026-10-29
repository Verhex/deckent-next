import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { beuserEvaluatorPrincipalRef, verifiedPrincipalSchema, encodeCommandProjection, evaluatePolicy, type AuditRecord } from '#domain/index.js';
import { sha256, createHmacIntegrity } from '#platform/index.js';
import { beuserBindingSchema, beuserVerdictSchema } from '#domain/core/beuser/index.js';
import { BeuserContractError, pinBeuserLimits, pinBeuserWalkerSummary, type BeuserContext, type BeuserScreen } from '#engine/core/beuser-contract/index.js';
import { BeuserApplication, beuserWalkSandboxResult, BeuserExecutionSupervisor, BeuserDispatch, pinBeuserCampaign, admitBeuserAttempt, recordBeuserRefusal, beuserRefusalEvent, readBeuserControllerAudit,
  correctBeuserModelOutput, type BeuserWalkPorts } from '#engine/core/beuser/index.js';
import { BeuserRealmApplication, type BeuserRealmLease } from '#engine/index.js';
import { sealApproval, verifyApproval } from '#engine/core/approval/index.js';
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
    controllerAudit: vi.fn(async () => 'valid' as const),
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
  vi.mocked(h.ports.realm.destroy).mockResolvedValue({ binding, state: 'destroyed', evidenceRefs: ['absence'], filesystemProof: { schemaVersion: 1, source: 'daemon-attested' } });
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'completed', cleanup: 'destroyed', filesystemProof: { schemaVersion: 1, source: 'daemon-attested' }, verdict: { outcome: 'GREEN' } });
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
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'invalid', verdict: null });
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

it('C2 created observation must reach C4 admission before the first surface action', async () => {
  let lease: BeuserRealmLease | null = null;
  const inspect = vi.fn(async () => ({ valid: true, evidenceRefs: ['fixture-containment', 'fixture-kernel'] }));
  const handle = { binding, incarnation: 'fixture-incarnation', containerId: 'a'.repeat(64), controlDirectory: '/fixture/private', controlIdentity: '1:2' };
  const realm = new BeuserRealmApplication({ async create(_ctx, publish) { await publish(handle); return handle; }, inspect,
    async remove() { return { processesAbsent: true, cgroupAbsent: true, filesystemAbsent: true, evidenceRefs: ['fixture-absence'] }; } },
    { async reserve() { lease = { handle: null, observation: { binding, state: 'created', evidenceRefs: [] } }; },
      async publish(_ctx, value) { lease = { handle: value, observation: lease!.observation }; },
      async load() { return lease; }, async settle(_ctx, observation) { lease = { handle: lease?.handle ?? null, observation }; } });
  // Test-only fallible ports: this reproduces the real C2→C4 call sequence, never a real realm or successful walk.
  const unused = new Proxy({}, { get() { return async () => { throw new Error('FIXTURE_SURFACE_UNAVAILABLE'); }; } });
  const ports = { realm, surface: unused, models: unused, evidence: unused, decode() {}, finished: async () => false,
    record: async () => {}, refusal: async () => {} } as BeuserWalkPorts;
  const result = await new BeuserApplication(ports).walk(context(), summary);
  console.info('R1 observed', { state: result.state, cleanup: result.cleanup, admissionInspections: inspect.mock.calls.length });
  expect(inspect).toHaveBeenCalledOnce();
});

it('reads retained acceptance only after destruction, and never reads a verdict for quarantined cleanup', async () => {
  const h = harness(), order: string[] = [];
  const destroy = h.ports.realm.destroy, readback = h.ports.evidence.readback;
  h.ports.realm.destroy = async ctx => { order.push('destroy'); return destroy(ctx); };
  h.ports.evidence.readback = async ctx => { order.push('readback'); return readback(ctx); };
  expect(await h.app.walk(context(), summary)).toMatchObject({ cleanup: 'destroyed', state: 'completed' });
  expect(order).toEqual(['destroy', 'readback']);
  const uncertain = harness();
  uncertain.ports.realm.destroy = async () => ({ binding, state: 'quarantined', evidenceRefs: ['fixture-unknown'] });
  expect(await uncertain.app.walk(context(), summary)).toMatchObject({ cleanup: 'quarantined', state: 'unknown', verdict: null });
  expect(uncertain.ports.evidence.readback).not.toHaveBeenCalled();
});

it('reads controller A after the walk, invalidates an attributed authority row and emits a real Nervous detection', async () => {
  const rows: AuditRecord[] = [];
  const audit = new AuditApplication({ append: (_event, seal) => { const row = seal(rows.length + 1); rows.push(row); return row; },
    load: (scope, id) => rows.find(row => row.event.scopeId === scope && row.event.eventId === id) ?? null,
    page: (scope, after, limit) => rows.filter(row => row.event.scopeId === scope && row.sequence > after).slice(0, limit),
    increment: () => { throw new Error('unused'); }, counters: () => [] }, createHmacIntegrity('fixture', randomBytes(32)));
  const nervous = new NervousApplication({ audit, now: () => 10 }, NERVOUS_RULES_SEED, { live: false, approval: null, executors: {} });
  const controllerPorts = { audit, approvals: () => [] };
  // Normal Run records attributed to the same workload are not person authority writes.
  audit.record({ schemaVersion: 1, eventId: 'ordinary-run', scopeId: 'scope', principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: 'p', atMs: 1,
    subject: { kind: 'run-lifecycle', action: 'hold', runId: 'run', commandId: 'hold', taskId: null, revision: 1, evidence: null } });
  // Audit principal is a strict reference, never a client's assurance.
  expect(await readBeuserControllerAudit(context(), controllerPorts)).toBe('valid');
  const h = harness(), read = vi.fn((ctx: BeuserContext) => readBeuserControllerAudit(ctx, controllerPorts));
  h.ports.controllerAudit = read;
  h.ports.refusal = ctx => recordBeuserRefusal(ctx, { audit, nervous, now: () => 10, policyRevision: 'p',
    nervousContext: { owner: { issuer: 'host', subject: 'person' }, policyRevision: 'p' } });
  const ref = { issuer: principal.issuer, subject: principal.subject };
  expect(evaluatePolicy({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'explicit-card', principals: [ref], scopes: ['scope'],
    actions: ['execute'], resource: { kind: 'operation', ids: ['policy.administer'] }, effect: 'allow' }] },
    { principal, scopeId: 'scope', resource: { kind: 'operation', id: 'policy.administer' }, action: 'execute' }).decision).toBe('deny');
  // The explicit grant cannot lower the workload floor. The injected row models a separate producer defect.
  // Simulate the end-of-walk audit row, not a safer substitute operation.
  const original = h.ports.realm.destroy;
  h.ports.realm.destroy = async ctx => {
    audit.record({ schemaVersion: 1, eventId: 'forbidden-authority', scopeId: 'scope', principal: ref, policyRevision: 'p', atMs: 2,
      subject: { kind: 'authority-change', operation: { id: 'policy.administer', version: 1 }, commandId: 'bad-write', approvalId: 'bad-card', decider: ref,
        inputDigest: 'a'.repeat(64), revision: { before: 'p', after: 'bad' }, counts: { grantsAdded: 1, grantsRemoved: 0, bindingsAdded: 0, bindingsRemoved: 0 } } });
    return original(ctx);
  };
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'invalid', reason: 'BEUSER_TARGET_NOT_SANDBOX' });
  expect(read).toHaveBeenCalledOnce();
  expect(rows.some(row => row.event.subject.kind === 'recovery-detection')).toBe(true);
  const missing = harness(); missing.ports.controllerAudit = async () => 'unknown';
  expect(await missing.app.walk(context(), summary)).toMatchObject({ state: 'unknown' });
  expect(await readBeuserControllerAudit(context(), { audit: { list() { throw new Error('AUDIT_INTEGRITY'); } }, approvals: () => [] })).toBe('unknown');
});

it('controller readback detects a sealed approval decision by BeUser and holds missing or bounded audit evidence', async () => {
  const integrity = createHmacIntegrity('fixture', randomBytes(32));
  const actor = { id: principal.id, issuer: principal.issuer, subject: principal.subject };
  const request = { schemaVersion: 1 as const, approvalId: 'controller-card', scopeId: 'scope', runId: 'run', taskId: 'task', requester: actor,
    actionDigest: 'a'.repeat(64), policyRevision: 'p', summary: 'same approval card', createdAt: 1, expiresAt: 10 };
  const ref = { issuer: principal.issuer, subject: principal.subject };
  const explicit = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'card-grant', principals: [ref], scopes: ['scope'],
    actions: ['decide'], resource: { kind: 'approval', ids: [request.approvalId] }, effect: 'allow' }] };
  expect(explicit.grants[0]?.resource.ids).toEqual([request.approvalId]);
  expect(evaluatePolicy(explicit, { principal, scopeId: 'scope', resource: { kind: 'approval', id: request.approvalId }, action: 'decide' }).decision).toBe('deny');
  const approval = sealApproval({ request, revision: 1, status: 'decided', decision: { commandId: 'card-answer', decision: 'allow', actor,
    sessionId: 'synthetic', channel: 'fixture', reason: 'fixture producer defect', decidedAt: 2, requestDigest: 'b'.repeat(64),
    commandDigest: 'c'.repeat(64), idempotencyKeyHash: 'd'.repeat(64) } }, integrity);
  const rows = () => [verifyApproval(approval, integrity)];
  expect(await readBeuserControllerAudit(context(), { audit: { list: () => [] }, approvals: rows })).toBe('invalid');
  const unknown = { ...context(), limits: { ...limits, maxArtifactBytes: 1 } };
  expect(await readBeuserControllerAudit(unknown, { audit: { list: () => [] }, approvals: rows })).toBe('unknown');
  const h = harness(); h.ports.controllerAudit = async () => { throw new Error('AUDIT_UNAVAILABLE'); };
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'unknown', verdict: null });
});

it('retains a realm refusal as the root terminal code while cleanup stays unproven, without fabricating a deadline', async () => {
  const h = harness();
  const error = new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
  error.message += ' /private/host credential=hidden';
  h.ports.realm.create = vi.fn(async () => { throw error; });
  h.ports.realm.destroy = vi.fn(async () => { throw new Error('unproven'); });
  const result = await h.app.walk(context(), summary);
  expect(result).toMatchObject({ state: 'invalid', reason: 'BEUSER_TARGET_NOT_SANDBOX', cleanup: 'quarantined' });
  const terminal = beuserWalkSandboxResult('fixture-handle', result);
  expect(terminal).toMatchObject({ result: { kind: 'unknown', reasonCode: 'BEUSER_TARGET_NOT_SANDBOX' }, interrupted: false });
  expect(terminal).not.toHaveProperty('interruptCause');
  expect(JSON.stringify(terminal)).not.toMatch(/private|hidden/);
  expect(h.ports.surface.look).not.toHaveBeenCalled();
  expect(h.ports.refusal).toHaveBeenCalledOnce();
});

it('distinguishes a real wall deadline from person cancellation at the terminal boundary', async () => {
  const h = harness(), ctx = context();
  h.ports.realm.create = vi.fn(async () => new Promise<never>(() => {}));
  const result = await h.app.walk({ ...ctx, limits: { ...ctx.limits, maxWallMs: 20, maxWaitMs: 10, cleanupDeadlineMs: 20 } }, summary);
  expect(result.reason).toBe('deadline');
  expect(beuserWalkSandboxResult('fixture-handle', result)).toMatchObject({ interrupted: true, interruptCause: 'deadline' });
  const cancelled = harness(), abort = new AbortController();
  cancelled.ports.realm.create = vi.fn(async () => { abort.abort(); return new Promise<never>(() => {}); });
  const stopped = await cancelled.app.walk(context(abort.signal), summary);
  expect(stopped.reason).toBe('cancelled');
  expect(beuserWalkSandboxResult('fixture-handle', stopped)).toMatchObject({ interrupted: true, interruptCause: 'cancel' });
});

it('corrects an invalid walker answer with typed feedback before executing the real approval-card action', async () => {
  const h = harness();
  vi.mocked(h.ports.decode).mockImplementationOnce(() => { throw new BeuserContractError('BEUSER_MODEL_OUTPUT_INVALID'); });
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'completed', cleanup: 'destroyed' });
  expect(h.ports.models.walker).toHaveBeenCalledTimes(2);
  expect(h.ports.models.walker).toHaveBeenLastCalledWith(expect.anything(), summary, expect.objectContaining({ text: 'approval card' }), 'BEUSER_MODEL_OUTPUT_INVALID');
  expect(h.ports.surface.press).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'Enter');
  expect(h.ports.surface.type).not.toHaveBeenCalled();
});
it('exhausts existing persona patience on invalid output with no action and retains the typed failure through cleanup', async () => {
  const h = harness();
  vi.mocked(h.ports.decode).mockImplementation(() => { throw new BeuserContractError('BEUSER_MODEL_OUTPUT_INVALID'); });
  expect(await h.app.walk(context(), summary)).toMatchObject({ state: 'unknown', reason: 'BEUSER_MODEL_OUTPUT_INVALID', cleanup: 'destroyed' });
  expect(h.ports.models.walker).toHaveBeenCalledTimes(summary.patience.maxSteps);
  expect(h.ports.surface.press).not.toHaveBeenCalled();
  expect(h.ports.evidence.readback).not.toHaveBeenCalled();
});
it('bounds evaluator format corrections by admitted calls and preserves cancellation and unrelated failures', async () => {
  const ctx = { ...context(), limits: { ...limits, maxCalls: 2 } }, call = vi.fn(async (error?: 'BEUSER_MODEL_OUTPUT_INVALID') => { expect(error).toBeOneOf([undefined, 'BEUSER_MODEL_OUTPUT_INVALID']); throw new BeuserContractError('BEUSER_MODEL_OUTPUT_INVALID'); });
  await expect(correctBeuserModelOutput(ctx, summary.patience, call)).rejects.toThrow('BEUSER_MODEL_OUTPUT_INVALID');
  expect(call.mock.calls).toEqual([[undefined], ['BEUSER_MODEL_OUTPUT_INVALID']]);
  call.mockClear();
  await expect(correctBeuserModelOutput({ ...ctx, signal: AbortSignal.abort() }, summary.patience, call)).rejects.toThrow();
  expect(call).not.toHaveBeenCalled();
  const refused = vi.fn(async () => { throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); });
  await expect(correctBeuserModelOutput(ctx, summary.patience, refused)).rejects.toThrow('BEUSER_TARGET_NOT_SANDBOX');
  expect(refused).toHaveBeenCalledOnce();
});
