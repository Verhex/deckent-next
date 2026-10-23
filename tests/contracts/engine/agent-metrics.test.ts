import { describe, expect, it } from 'vitest';
import { bindTaskAcceptance, deckentMetricsSchema, type RunSnapshot } from '#domain/index.js';
import { deriveAcceptanceMetrics, dispatchRecordSchema } from '#engine/index.js';
import { evaluating, evidence, identity } from '../domain/acceptance-fixture.js';

// S8-1b (S8-DESIGN §4 fold B, §5): metrics v2 rows copy the agent (id, revision) and the real skill set digest from the Run's FROZEN task —
// never from the live catalog — and a failed task row carries `failureCause`, derived only from the sealed evaluation, dispatch and lifecycle
// write. Only `criteria-failed`, `worker-report-failed` and `human-rejected` are attributable; an infrastructure, model, dependency or operator
// failure is its own bucket, so a container crash can never count against an agent.
const actor = { id: 'actor', issuer: 'test', subject: 'author' };
const d = (c: string) => c.repeat(64);
const seal = { schemaVersion: 1, agentId: 'auditor', revision: 2, workClass: 'business', personaDigest: d('b'), skillSetDigest: d('c'), skills: [{ skillId: 'k', revision: 1, digest: d('a') }],
  standing: 'candidate', standingRevision: 1, selection: { eligible: 1, position: 0, reason: 'first-candidate' } };
function withAgent(run: RunSnapshot): RunSnapshot { const copy = JSON.parse(JSON.stringify(run)); copy.execution.tasks[0].agent = seal; return copy; }
const terminal = { handle: 'handle', exitCode: 0, interrupted: false };
function dispatch(end: object = terminal, extra: object = {}) {
  return dispatchRecordSchema.parse({ schemaVersion: 2, owner: 'worker-owner', launch: 'granted', profile: { schemaVersion: 1, adapterId: 'test', adapterVersion: 1, parameters: {} },
    request: { protocolVersion: 1, identity, workspace: '/fixture', argv: ['fixture-command'] }, grant: { generation: 1, grantedAt: 1, principal: actor },
    terminal: end, output: { schemaVersion: 1, scopeId: identity.scopeId, digest: 'a'.repeat(64), byteLength: 10 }, ...extra });
}
const command = (run: RunSnapshot, verdict: 'pass' | 'fail' | 'unknown', extra: Record<string, unknown> = {}, end?: object, record: object = {}) => JSON.stringify({ action: 'apply-task-evaluation',
  commandId: 'evaluation', actor, expectedRevision: run.revision, evaluation: { ...bindTaskAcceptance(run, evidence(verdict)), ...extra }, dispatch: dispatch(end, record) });
const ended = (run: RunSnapshot, phase: 'accepted' | 'failed'): RunSnapshot => ({ ...run, revision: run.revision + 1, progress: run.progress.map(row => ({ ...row, phase })) }) as RunSnapshot;
const failedRow = (extra: Record<string, unknown> = {}, end?: object, verdict: 'pass' | 'fail' | 'unknown' = 'fail', record?: object) => {
  const { run } = evaluating(), before = withAgent(run);
  const [row] = deriveAcceptanceMetrics(command(before, verdict, extra, end, record), ended(before, 'failed'));
  expect(deckentMetricsSchema.parse(row)).toEqual(row);
  return row!;
};

describe('agent and skill set from the frozen task', () => {
  it('N18: a system row carries the frozen agent revision and its sealed skill set digest; a row without an agent stays as before', () => {
    const { run } = evaluating(), before = withAgent(run);
    const [row] = deriveAcceptanceMetrics(command(before, 'pass'), ended(before, 'accepted'));
    expect(row).toMatchObject({ agent: { agentId: 'auditor', revision: 2 }, skillSetDigest: d('c'), outcome: { kind: 'task', status: 'accepted' } });
    expect(row).not.toHaveProperty('failureCause');
    const [plain] = deriveAcceptanceMetrics(command(run, 'pass'), ended(run, 'accepted'));
    expect(plain).not.toHaveProperty('agent'); expect(plain!.skillSetDigest).toBeNull();
  });
  it('N27/N18: a human decision row carries the same frozen agent, whatever happened to the catalog since admission', () => {
    const { run } = evaluating(), before = withAgent(run), after = { ...ended(before, 'failed'), revision: before.revision + 2 } as RunSnapshot;
    const lifecycle = JSON.stringify({ operation: 'run-lifecycle', schemaVersion: 1, commandId: 'decide', scopeId: identity.scopeId, runId: identity.runId, expectedRevision: after.revision,
      action: 'reject', taskId: identity.taskId, actor: { ...actor, assurance: 'os-user' }, now: 200, timeoutMs: 1000 });
    const [human] = deriveAcceptanceMetrics(lifecycle, after, null);
    expect(human).toMatchObject({ agent: { agentId: 'auditor', revision: 2 }, skillSetDigest: d('c'), outcome: { decision: 'human', status: 'failed' }, failureCause: 'human-rejected' });
    expect(deckentMetricsSchema.parse(human)).toEqual(human);
  });
});

describe('failureCause (fixed precedence; only attributable causes can ever count against an agent)', () => {
  it('attributable: an installed evaluator failed with a clean exit → criteria-failed; the worker\'s own report says not passed → worker-report-failed', () => {
    expect(failedRow().failureCause).toBe('criteria-failed');
    expect(failedRow({ report: { status: 'reported', acceptanceChecks: 'not-passed' } }, undefined, 'unknown').failureCause).toBe('worker-report-failed');
    expect(failedRow({ report: { status: 'missing' } }, undefined, 'unknown').failureCause).toBe('worker-report-failed');
  });
  it('N30: stall, no clean exit, a signal, an interruption, a model substitution, an invalid handoff, an operator cancel or an unavailable evidence source are not the agent\'s', () => {
    expect(failedRow({ stall: { cause: 'inactivity', backoffMs: 10 } }).failureCause).toBe('infra');
    expect(failedRow({}, { ...terminal, exitCode: 2 }).failureCause).toBe('infra');
    expect(failedRow({}, { handle: 'handle', exitCode: null, signal: 'SIGKILL', interrupted: false }).failureCause).toBe('infra');
    expect(failedRow({}, { ...terminal, interrupted: true }).failureCause).toBe('infra');
    expect(failedRow({ report: { status: 'reported', acceptanceChecks: 'not-run' } }, undefined, 'unknown').failureCause).toBe('infra');
    const model = { provider: 'claude', requested: { channelId: 'claude', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] }, init: 'claude-fable-5-1', usage: ['claude-fable-5-1'],
      verdict: 'substituted', unexpected: ['claude-fable-5-1'], evidence: 'sealed', evidenceCapability: 'session-events' };
    expect(failedRow({ model }).failureCause).toBe('model');
    expect(failedRow({ handoff: { status: 'invalid', code: 'HANDOFF_INVALID' } }).failureCause).toBe('dependency');
    expect(failedRow({}, undefined, 'fail', { cancellation: actor }).failureCause).toBe('operator');
    const unavailable = { ...evidence('fail').criteria[0]!, reason: 'OPERATION_EVIDENCE_UNAVAILABLE' };
    expect(failedRow({ criteria: [unavailable] }).failureCause).toBe('infra');
  });
  it('N31: a failure the sealed evaluation cannot place is unattributed (read by no rule); an earlier v2 row without the field still parses', () => {
    expect(failedRow({}, undefined, 'unknown').failureCause).toBe('unattributed');
    const { run } = evaluating(), [plain] = deriveAcceptanceMetrics(command(run, 'fail'), ended(run, 'failed'));
    const legacy = { ...plain! } as Record<string, unknown>; delete legacy['failureCause'];
    expect(deckentMetricsSchema.parse(legacy)).toEqual(legacy);
  });
  it('negative: a cause on an accepted, awaiting or Run row is a schema refusal', () => {
    const { run } = evaluating(), [accepted] = deriveAcceptanceMetrics(command(run, 'pass'), ended(run, 'accepted'));
    expect(deckentMetricsSchema.safeParse({ ...accepted, failureCause: 'infra' }).success).toBe(false);
  });
});
