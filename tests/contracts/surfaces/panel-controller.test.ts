import { describe, expect, it } from 'vitest';
import { createPanelController } from '#surfaces/core/terminal-kit/index.js';
import type { PanelContext, PanelExecution, PanelPort, TerminalLocalContext, ExactContext, PanelApprovalView } from '#surfaces/core/terminal-kit/index.js';

const local: TerminalLocalContext = { kind: 'terminal-local', installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'fixture-scope', sessionId: 'fixture-session' };
const service: ExactContext = { ...local, kind: 'service-session', sessionRevision: 7 };
function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture<C extends PanelContext>(context: C, history: PanelPort<C>['history']) {
  const executions: PanelExecution<C>[] = [], turns: ReturnType<typeof gate>[] = [], decisions: { view: PanelApprovalView<C>; decision: 'allow' | 'deny' }[] = [];
  const replies: ReturnType<typeof gate>[] = [], retired: string[] = [];
  const ports: PanelPort<C> = { kind: context.kind, context, history, now: () => 100,
    execute: execution => { executions.push(execution); const pending = gate(); turns.push(pending); return pending.promise; },
    decideApproval: (view, intent) => { decisions.push({ view, decision: intent.decision }); const pending = gate(); replies.push(pending); return pending.promise; },
    retireApproval: view => { retired.push(view.cardHandle); },
  };
  return { ports, executions, turns, decisions, replies, retired };
}
function bind<C extends PanelContext>(execution: PanelExecution<C>, turnId = 'fixture-turn') {
  return execution.onTurnBound({ scopeId: execution.input.context.scopeId, sessionId: execution.input.context.sessionId, turnId, phase: 'command-generated' });
}
function card<C extends PanelContext>(context: C, revision = 1, cardHandle = 'fixture-card'): PanelApprovalView<C> {
  return { context, turnId: 'fixture-turn', approvalId: 'fixture-approval', revision, expiresAt: 1000, cardHandle, presentationHandle: 'fixture-private-presentation' };
}

describe('shared panel controller (host fixtures, no production Desktop acceptance)', () => {
  for (const surface of ['Terminal adapter fixture', 'host panel fixture'] as const) {
    it(`${surface}: serializes text and slash intents, edits only queued addresses and keeps mentions private`, async () => {
      const f = fixture(local, { kind: 'disabled', port: null }); const controller = createPanelController(f.ports);
      const mentions = ['fixture-file'];
      expect(controller.send({ kind: 'submit', context: local, inputId: 'a', text: 'first' })).toBe(true);
      controller.send({ kind: 'submit', context: local, inputId: 'b', text: '/await', mentions });
      controller.send({ kind: 'submit', context: local, inputId: 'c', text: '/immediate' });
      mentions.push('mutated');
      expect(controller.send({ kind: 'edit-queued', context: local, inputId: 'a', text: 'wrong' })).toBe(false);
      expect(controller.send({ kind: 'edit-queued', context: local, inputId: 'b', text: '/edited' })).toBe(true);
      expect(controller.send({ kind: 'submit', context: local, inputId: 'b', text: 'duplicate' })).toBe(false);
      expect(controller.snapshot().queued).toEqual([{ inputId: 'b' }, { inputId: 'c' }]);
      expect(JSON.stringify(controller.snapshot())).not.toContain('/edited');
      f.turns[0]!.resolve(); await tick();
      expect(f.executions.map(e => e.input.text)).toEqual(['first', '/edited']);
      expect(f.executions[1]!.input.mentions).toEqual(['fixture-file']);
      f.turns[1]!.reject(new Error('fixture-slash-failure')); await tick();
      expect(f.executions.map(e => e.input.text)).toEqual(['first', '/edited', '/immediate']);
      f.turns[2]!.resolve(); await tick();
      expect(controller.snapshot().phase).toBe('idle');
      expect(controller.snapshot().last).toEqual({ inputId: 'c', outcome: 'returned' });
    });
  }
  it('uses the same implementation with an exact service stub; local history cannot select service custody', () => {
    const f = fixture(service, { kind: 'unavailable', read: null }); const c = createPanelController(f.ports);
    expect(c.send({ kind: 'submit', context: service, inputId: 'a', text: 'fixture' })).toBe(true);
    expect(c.send({ kind: 'submit', context: local as unknown as ExactContext, inputId: 'b', text: 'forged' })).toBe(false);
    expect(c.send({ kind: 'submit', context: { ...service, sessionRevision: 8 }, inputId: 'b', text: 'stale' })).toBe(false);
    expect(c.snapshot().context.sessionRevision).toBe(7); c.send({ kind: 'close-view', context: service });
  });
  it('rejects malformed contexts and mismatched port branches at construction', () => {
    const f = fixture(local, { kind: 'disabled', port: null });
    expect(() => createPanelController({ ...f.ports, context: { ...local, projectId: '' } })).toThrow(TypeError);
    expect(() => createPanelController({ ...f.ports, history: { kind: 'enabled', port: null } } as unknown as PanelPort<TerminalLocalContext>)).toThrow(TypeError);
    expect(() => createPanelController({ ...f.ports, history: { kind: 'forged', port: null } } as unknown as PanelPort<TerminalLocalContext>)).toThrow(TypeError);
    expect(() => createPanelController({ ...f.ports, context: { ...local, sessionRevision: 1 } } as unknown as PanelPort<TerminalLocalContext>)).toThrow(TypeError);
    expect(() => createPanelController({ ...f.ports, kind: 'service-session' } as unknown as PanelPort<TerminalLocalContext>)).toThrow(TypeError);
    expect(() => createPanelController({ ...fixture(service, { kind: 'unavailable', read: null }).ports,
      context: { ...service, sessionRevision: -1 } })).toThrow(TypeError);
  });
  it('binds only the captured input context once, and cancels that exact active signal without retrying', async () => {
    const f = fixture(local, { kind: 'unavailable', port: null }); const c = createPanelController(f.ports);
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' }); const a = f.executions[0]!;
    expect(a.onTurnBound({ scopeId: 'other', sessionId: local.sessionId, turnId: 'wrong', phase: 'command-generated' })).toBe(false);
    expect(bind(a)).toBe(true); expect(bind(a, 'other')).toBe(false);
    expect(c.snapshot().active?.binding?.phase).toBe('command-generated');
    expect(c.send({ kind: 'cancel', context: local, turnId: 'other' })).toBe(false);
    expect(c.send({ kind: 'cancel', context: local, turnId: 'fixture-turn' })).toBe(true);
    expect(a.signal.aborted).toBe(true); expect(c.snapshot().phase).toBe('cancelling');
    expect(c.send({ kind: 'cancel', context: local, turnId: 'fixture-turn' })).toBe(false);
    f.turns[0]!.resolve(); await tick(); expect(c.snapshot().last?.outcome).toBe('unknown');
    expect(f.executions).toHaveLength(1); expect(bind(a)).toBe(false);
  });
  it('close aborts an unbound preflight and never drains queued work or accepts late binding', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'preflight' });
    c.send({ kind: 'submit', context: local, inputId: 'b', text: 'queued' });
    c.send({ kind: 'close-view', context: local }); c.send({ kind: 'close-view', context: local });
    expect(f.executions[0]!.signal.aborted).toBe(true); expect(bind(f.executions[0]!)).toBe(false);
    f.turns[0]!.resolve(); await tick(); expect(f.executions).toHaveLength(1);
    expect(c.snapshot()).toMatchObject({ phase: 'closed', active: null, queued: [], approval: null });
    expect(c.send({ kind: 'submit', context: local, inputId: 'c', text: 'late' })).toBe(false);
  });
});

describe('panel approval custody, session selection and observer lifecycle (host fixtures)', () => {
  it('keeps capability/display custody private, single-flights decisions, and retries an assurance refusal', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' }); const execution = f.executions[0]!; bind(execution);
    const transported = { ...card(local), decisionCapability: 'fixture-capability-canary', summary: 'fixture-raw-secret', preview: 'fixture-raw-preview' };
    const custody = new Map([['fixture-card', transported]]); // Private adapter fixture, never a Windows broker.
    f.ports.decideApproval = async (view, intent) => {
      const raw = custody.get(view.cardHandle)!; expect(raw.revision).toBe(view.revision);
      expect(raw.decisionCapability).toBe('fixture-capability-canary'); f.decisions.push({ view, decision: intent.decision });
      const pending = gate(); f.replies.push(pending); await pending.promise;
    };
    expect(execution.onApproval(transported)).toBe(true);
    const serialized = JSON.stringify(c.snapshot());
    for (const canary of ['fixture-capability-canary', 'fixture-raw-secret', 'fixture-raw-preview', 'decisionCapability', 'summary', 'preview']) expect(serialized).not.toContain(canary);
    const decision = { kind: 'decide-approval' as const, context: local, cardHandle: 'fixture-card', decision: 'allow' as const, reason: 'fixture reason' };
    expect(c.send(decision)).toBe(true); expect(c.send(decision)).toBe(false); expect(f.decisions).toHaveLength(1);
    f.replies[0]!.reject(new Error('fixture-insufficient-assurance')); await tick(); expect(c.snapshot().approval?.phase).toBe('pending');
    expect(c.send(decision)).toBe(true); f.replies[1]!.resolve(); await tick(); expect(c.snapshot().approval).toBeNull();
    expect(c.send(decision)).toBe(false); expect(f.retired).toEqual(['fixture-card']); c.send({ kind: 'close-view', context: local });
  });
  it('late decisions and settlements cannot close a newer revision; expired/wrong cards never dispatch', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' }); const e = f.executions[0]!; bind(e);
    expect(e.onApproval({ ...card(local), turnId: 'wrong' })).toBe(false);
    e.onApproval(card(local));
    expect(c.send({ kind: 'decide-approval', context: local, cardHandle: 'wrong', decision: 'allow', reason: '' })).toBe(false);
    c.send({ kind: 'decide-approval', context: local, cardHandle: 'fixture-card', decision: 'allow', reason: '' });
    expect(e.onApproval(card(local, 2, 'fixture-card-2'))).toBe(true);
    f.replies[0]!.resolve(); await tick(); expect(c.snapshot().approval?.revision).toBe(2);
    expect(e.onApprovalSettled({ ...card(local), outcome: 'unsettled' })).toBe(false);
    expect(e.onApprovalSettled({ ...card(local, 2, 'fixture-card-2'), outcome: 'unsettled' })).toBe(true);
    expect(c.snapshot().approval?.phase).toBe('unknown');
    expect(e.onApproval({ ...card(local, 3, 'expired'), expiresAt: 99 })).toBe(false);
    c.send({ kind: 'close-view', context: local });
    expect(f.retired).toEqual(['fixture-card', 'fixture-card-2']);
  });
  it('refuses a retired approval replay within the captured turn lifetime', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' }); const e = f.executions[0]!; bind(e);
    e.onApproval(card(local)); c.send({ kind: 'decide-approval', context: local, cardHandle: 'fixture-card', decision: 'deny', reason: '' });
    f.replies[0]!.resolve(); await tick();
    expect(e.onApproval(card(local))).toBe(false);
    expect(e.onApproval(card(local, 2, 'fixture-card'))).toBe(false);
    expect(e.onApproval(card(local, 1, 'readdressed-old-revision'))).toBe(false);
    expect(e.onApproval(card(local, 2, 'fixture-card-2'))).toBe(true);
    c.send({ kind: 'close-view', context: local });
  });
  it('cleanup/observer failures do not prevent abort or a closed view, and old decision replies are ignored', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.subscribe(() => { throw new Error('fixture-render-failure'); });
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' }); const e = f.executions[0]!; bind(e);
    e.onApproval(card(local));
    c.send({ kind: 'decide-approval', context: local, cardHandle: 'fixture-card', decision: 'allow', reason: '' });
    f.ports.retireApproval = () => { throw new Error('fixture-cleanup-failure'); };
    expect(c.send({ kind: 'close-view', context: local })).toBe(true); expect(e.signal.aborted).toBe(true);
    f.replies[0]!.resolve(); f.turns[0]!.resolve(); await tick();
    expect(c.snapshot()).toMatchObject({ phase: 'closed', active: null, approval: null });
    expect(e.onApproval(card(local, 2, 'new'))).toBe(false);
  });
  it('close during a running-state notification prevents adapter dispatch', () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.subscribe(s => { if (s.active) c.send({ kind: 'close-view', context: local }); });
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' });
    expect(f.executions).toHaveLength(0); expect(c.snapshot().phase).toBe('closed');
  });
  it('shares one picker gate, validates addresses and releases it exactly once on selection/cancel/close', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.send({ kind: 'submit', context: local, inputId: 'a', text: '/resume' }); const e = f.executions[0]!;
    const view = { pickerHandle: 'fixture-picker', items: [{ itemHandle: 'fixture-session-choice', presentationHandle: 'fixture-private-row', label: 'fixture-raw-canary' }] };
    const picked = e.pick(view); expect(JSON.stringify(c.snapshot())).not.toContain('fixture-raw-canary');
    expect(await e.pick(view)).toBeNull();
    expect(c.send({ kind: 'choose-item', context: local, pickerHandle: 'wrong', itemHandle: 'fixture-session-choice' })).toBe(false);
    expect(c.send({ kind: 'choose-item', context: local, pickerHandle: view.pickerHandle, itemHandle: 'wrong' })).toBe(false);
    expect(c.send({ kind: 'choose-item', context: local, pickerHandle: view.pickerHandle, itemHandle: 'fixture-session-choice' })).toBe(true);
    expect(await picked).toBe('fixture-session-choice');
    const again = e.pick({ ...view, pickerHandle: 'fixture-picker-2' }); bind(e); e.onApproval(card(local));
    expect(c.send({ kind: 'choose-item', context: local, pickerHandle: 'fixture-picker-2', itemHandle: null })).toBe(false);
    expect(c.send({ kind: 'cancel', context: local, turnId: 'fixture-turn' })).toBe(true); expect(await again).toBeNull();
    f.turns[0]!.resolve(); await tick();
    c.send({ kind: 'submit', context: local, inputId: 'b', text: '/resume' }); const closed = f.executions[1]!.pick(view);
    c.send({ kind: 'close-view', context: local }); expect(await closed).toBeNull(); expect(c.snapshot().picker).toBeNull();
    expect(await e.pick(view)).toBeNull();
  });
  it('session replacement waits for idle, invalidates old callbacks and protects exact context', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' }); const old = f.executions[0]!;
    const next = { ...local, sessionId: 'fixture-resumed-session' };
    expect(c.selectSession(local, next)).toBe(false); f.turns[0]!.resolve(); await tick();
    expect(c.selectSession(local, { ...next, scopeId: 'other' })).toBe(false);
    expect(c.selectSession(local, next)).toBe(true); expect(bind(old)).toBe(false);
    expect(c.send({ kind: 'submit', context: local, inputId: 'b', text: 'stale' })).toBe(false);
    expect(c.send({ kind: 'submit', context: next, inputId: 'b', text: 'current' })).toBe(true);
    c.send({ kind: 'close-view', context: next });
  });
  it('publishes immutable shared snapshots, supports unsubscribe/reentrancy and releases listeners on close', async () => {
    const f = fixture(local, { kind: 'disabled', port: null }); const c = createPanelController(f.ports);
    const terminal: unknown[] = [], host: unknown[] = [];
    const unsubscribe = c.subscribe(s => terminal.push(s)); c.subscribe(s => host.push(s));
    const initial = c.snapshot(); expect(Object.isFrozen(initial.context)).toBe(true);
    c.subscribe(s => { if (s.active?.inputId === 'a' && !s.queued.length) c.send({ kind: 'submit', context: local, inputId: 'b', text: 'reentrant' }); });
    c.send({ kind: 'submit', context: local, inputId: 'a', text: 'fixture' });
    expect(terminal).toEqual(host); expect(Object.isFrozen(c.snapshot().queued)).toBe(true);
    expect(c.snapshot().queued).toEqual([{ inputId: 'b' }]); unsubscribe(); const count = terminal.length;
    c.send({ kind: 'close-view', context: local }); f.turns[0]!.resolve(); await tick();
    expect(terminal).toHaveLength(count); expect(f.executions).toHaveLength(1);
  });
});

// Compiled by the retained targeted tsc config; Vitest alone does not verify these negatives.
function contextTypeProof(localPort: PanelPort<TerminalLocalContext>, servicePort: PanelPort<ExactContext>) {
  // @ts-expect-error Required service revision cannot be absent.
  const missingRevision: ExactContext = { ...local, kind: 'service-session' };
  // @ts-expect-error Local contexts cannot fabricate a numeric service revision.
  const fabricatedRevision: TerminalLocalContext = { ...local, sessionRevision: 0 };
  // @ts-expect-error Canonical local history is not a service-session history port.
  const wrongHistory: PanelPort<ExactContext> = { ...servicePort, history: localPort.history };
  // @ts-expect-error Local context/port cannot be passed to the exact service controller API.
  createPanelController(servicePort).send({ kind: 'submit', context: local, inputId: 'type-fixture', text: 'fixture' });
  // @ts-expect-error The local controller cannot receive service custody.
  createPanelController(localPort).send({ kind: 'submit', context: service, inputId: 'type-fixture', text: 'fixture' });
  void missingRevision; void fabricatedRevision; void wrongHistory;
}
void contextTypeProof;
