import { describe, expect, it } from 'vitest';
import { AUTONOMY_HOLD_REASONS, AUTONOMY_RULE, DELIVERY_MODEL_VERDICTS, DELIVERY_RISK_DATA, DeliverySummaryApplication, autonomyFacts, autonomyRuleDigest,
  deliverySummarySchema, evaluateAutonomy, planQueueCommit, projectDeliverySummary, queueCommitMetadata, workspacePatchChangeFacts, classifyPatchScope,
  type AutonomyFacts, type DeliverySummaryFacts, type DeliveryChangeFacts } from '#engine/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { INSTRUCTION_SURFACE_PATHS, type RunSnapshot, TargetQueueRecord, VerifiedPrincipal, WorkerFinalReportResult, WorkerModelView } from '#domain/index.js';

/** TESLIM-KARTI-OZET + OTONOM-TESLIM shadow rule (alpha.53 A1): one generic envelope, typed withheld/unavailable sections, rule as data. */
const identity = { scopeId: 'scope', runId: 'run', layoutRevision: 'layout', taskId: 'task', attemptId: 'attempt', generation: 1 };
type RunOptions = { title?: string | null; task?: string | null; phase?: string; acceptedEvidence?: string; workClass?: string | null; evaluator?: string };
function run(options: RunOptions = {}): RunSnapshot {
  const workInput = options.task === null ? undefined : { task: options.task ?? 'Fix the login banner\nthen run tests', ...(options.title === null ? {} : { title: options.title ?? 'Login banner fix' }),
    acceptance: 'tests pass', scope: { paths: ['src/**'] } };
  return { identity: { scopeId: 'scope', runId: 'run', layoutRevision: 'layout' }, revision: 7,
    graph: { tasks: [{ id: 'task', kind: 'small', dependencies: [], acceptanceCriteria: ['c1', 'c2'], ...(workInput ? { workInput } : {}) }],
      criterionDefinitions: [{ id: 'c1', version: 1, description: 'exit', evaluator: { id: options.evaluator ?? 'process-exit', version: 1 } },
        { id: 'c2', version: 1, description: 'exit again', evaluator: { id: options.evaluator ?? 'process-exit', version: 1 } }] },
    progress: [{ taskId: 'task', phase: options.phase ?? 'accepted', unresolvedEffects: false, ...(options.acceptedEvidence ? { acceptedEvidence: options.acceptedEvidence } : {}) }],
    execution: { tasks: [{ taskId: 'task', profile: { id: 'profile', version: 1, parameters: {} },
      ...(options.workClass === null ? {} : { acceptance: { workClass: options.workClass ?? 'small', policyRevision: 'r1', profileVersion: 1, criteria: [] } }) }] },
    bindings: [{ identity }] } as unknown as RunSnapshot;
}
const report = (summary = 'Banner fixed.', checks: { outcome: 'passed' | 'failed' | 'not-run' | 'unknown' }[] = [{ outcome: 'passed' }, { outcome: 'passed' }]): WorkerFinalReportResult =>
  ({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1, summary, changedFiles: [], openIssues: [],
    checks: checks.map((row, index) => ({ command: `check-${index}`, ...row })) } });
const model = (verdict: WorkerModelView['verdict'], evidence: WorkerModelView['evidence'] = 'sealed'): WorkerModelView => ({ provider: 'native-a' as WorkerModelView['provider'],
  evidenceCapability: 'session-events' as WorkerModelView['evidenceCapability'], requested: { channelId: 'channel', modelId: 'model-x', auxiliaryModelIds: [] },
  init: 'model-x', usage: ['model-x'], verdict, unexpected: [], evidence });
const change = (paths = ['src/a.ts', 'src/b.ts'], outOfScope: string[] = [], scope: DeliveryChangeFacts['scope'] = outOfScope.length ? 'out-of-scope' : 'in-scope'): DeliveryChangeFacts =>
  ({ adapter: 'workspace-patch', paths, added: 10, removed: 2, scope, outOfScope });
const verificationRun = (phase = 'accepted') => ({ runId: 'queue-verify-1', run: run({ phase }) });
function facts(overrides: Partial<DeliverySummaryFacts> = {}): DeliverySummaryFacts {
  return { operation: 'deliver', identity, run: run(), target: { id: 'refs/heads/feature', protected: false }, report: report(), model: model('verified'),
    verification: verificationRun(), change: change(), ...overrides };
}

describe('DeliverySummary projector', () => {
  it('projects every section of an accepted, verified, in-scope small delivery', () => {
    const summary = projectDeliverySummary(facts());
    expect(deliverySummarySchema.parse(summary)).toEqual(summary);
    expect(summary).toMatchObject({ schemaVersion: 1, operation: 'deliver', subject: identity, target: { state: 'available', id: 'refs/heads/feature', protected: false },
      title: { source: 'work-input', text: 'Login banner fix' }, outcome: { state: 'available', claim: true, summary: 'Banner fixed.', truncated: false },
      acceptance: { verdict: 'accepted', criteriaCount: 2, evidence: [{ evaluator: { id: 'process-exit', version: 1 }, kind: 'exit-code', independent: false }] },
      tests: { worker: { state: 'available', claim: true, passed: 2, failed: 0, notRun: 0, unknown: 0 },
        verification: { state: 'available', runId: 'queue-verify-1', phase: 'accepted', evidence: [{ kind: 'exit-code', independent: false }] } },
      model: { state: 'available', requested: { channelId: 'channel', modelId: 'model-x' }, verdict: 'verified' },
      risk: { class: 'small', workClass: 'small', protectedTarget: false, sizeBucket: 'tiny', flags: ['evidence-not-independent'] },
      actions: { yes: 'publish-candidate', no: 'nothing-published' },
      change: { state: 'available', adapter: 'workspace-patch', files: 2, added: 10, removed: 2, topPaths: ['src/a.ts', 'src/b.ts'], topPathsOmitted: 0, scope: 'in-scope', outOfScope: [], outOfScopeCount: 0 } });
    expect(Object.isFrozen(summary)).toBe(true);
  });
  it('title falls back from the work-input title to the first instruction line to untitled', () => {
    expect(projectDeliverySummary(facts({ run: run({ title: null }) })).title).toEqual({ source: 'instruction', text: 'Fix the login banner' });
    expect(projectDeliverySummary(facts({ run: run({ title: null, task: '\n  \nSecond line first' }) })).title).toEqual({ source: 'instruction', text: 'Second line first' });
    expect(projectDeliverySummary(facts({ run: run({ task: null }) })).title).toEqual({ source: 'untitled' });
  });
  it('types withheld (not readable) and unavailable (no evidence) per section, never inventing a claim', () => {
    const withheld = projectDeliverySummary(facts({ report: 'withheld', model: 'withheld', verification: 'withheld', change: 'withheld' }));
    expect([withheld.outcome, withheld.tests.worker, withheld.model, withheld.tests.verification, withheld.change]).toEqual(Array(5).fill({ state: 'withheld' }));
    expect(withheld.risk.sizeBucket).toBeNull();
    expect(projectDeliverySummary(facts({ model: model('pending', 'denied') })).model).toEqual({ state: 'withheld' });
    const absent = projectDeliverySummary(facts({ report: null, model: null, verification: null, change: null, target: null }));
    expect([absent.outcome, absent.tests.worker, absent.model, absent.tests.verification, absent.change, absent.target]).toEqual(Array(6).fill({ state: 'unavailable' }));
    expect(absent.risk.flags).toContain('verification-missing');
    const unreported = projectDeliverySummary(facts({ report: { schemaVersion: 1, kind: 'native-worker-report', status: 'unavailable', reason: 'missing' } }));
    expect([unreported.outcome, unreported.tests.worker]).toEqual([{ state: 'unavailable' }, { state: 'unavailable' }]);
    expect(projectDeliverySummary(facts({ verification: { runId: 'queue-verify-1', run: null } })).tests.verification).toEqual({ state: 'unavailable' });
  });
  it('keeps accepted-unverified, failed checks, protected target and a non-independent verification visible as flags', () => {
    const summary = projectDeliverySummary(facts({ run: run({ acceptedEvidence: 'model-unverified' }), report: report('x', [{ outcome: 'failed' }, { outcome: 'not-run' }, { outcome: 'unknown' }]),
      target: { id: 'refs/heads/main', protected: true }, verification: verificationRun('failed') }));
    expect(summary.acceptance.verdict).toBe('accepted-unverified');
    expect(summary.tests.worker).toEqual({ state: 'available', claim: true, passed: 0, failed: 1, notRun: 1, unknown: 1 });
    expect(summary.risk.flags).toEqual(['acceptance-unverified', 'evidence-not-independent', 'worker-checks-failed', 'verification-not-accepted', 'protected-target']);
    expect(projectDeliverySummary(facts({ run: run({ evaluator: 'operation-evidence' }) })).acceptance.evidence).toEqual([{ evaluator: { id: 'operation-evidence', version: 1 }, kind: 'operation-record', independent: true }]);
    expect(projectDeliverySummary(facts({ run: run({ evaluator: 'ext-evaluator' }) })).acceptance.evidence).toEqual([{ evaluator: { id: 'ext-evaluator', version: 1 }, kind: 'unknown', independent: null }]);
    expect(projectDeliverySummary(facts({ run: run({ phase: 'failed' }) })).acceptance.verdict).toBe('not-accepted');
    expect(projectDeliverySummary(facts({ run: run({ phase: 'evaluating' }) })).acceptance.verdict).toBe('pending');
  });
  it.each(DELIVERY_MODEL_VERDICTS)('carries the %s model verdict and flags every verdict except verified', verdict => {
    const summary = projectDeliverySummary(facts({ model: model(verdict) }));
    expect(summary.model).toMatchObject({ state: 'available', verdict });
    expect(summary.risk.flags.includes('model-not-verified')).toBe(verdict !== 'verified');
  });
  it('bounds out-of-scope paths and top paths, counts the rest and classifies risk from the frozen work class only', () => {
    const paths = Array.from({ length: 30 }, (_, index) => `lib/file-${index}.ts`);
    const summary = projectDeliverySummary(facts({ change: change(paths, paths), topPaths: 4, run: run({ workClass: 'feature' }) }));
    expect(summary.change).toMatchObject({ files: 30, topPaths: paths.slice(0, 4), topPathsOmitted: 26, scope: 'out-of-scope', outOfScope: paths.slice(0, 16), outOfScopeCount: 30 });
    expect(summary.risk).toMatchObject({ class: 'other', workClass: 'feature', sizeBucket: 'medium', flags: expect.arrayContaining(['out-of-scope']) });
    expect(projectDeliverySummary(facts({ run: run({ workClass: null }) })).risk).toMatchObject({ class: 'other', workClass: null });
    expect(projectDeliverySummary(facts({ change: change(['a'], [], 'unscoped') })).risk.flags).toContain('scope-undeclared');
    expect(projectDeliverySummary(facts({ change: { ...change(paths), added: 5000 } })).risk.sizeBucket).toBe(DELIVERY_RISK_DATA.overflowBucket);
  });
  it('redacts secrets before bounding and strips terminal controls in every string', () => {
    const known = snapshotKnownSecrets([{ name: 'SERVICE_TOKEN', value: 'hunter2-very-secret' }]);
    const summary = projectDeliverySummary(facts({ known, run: run({ title: 'Rotate ghp_abcdefghijklmnop key \u001b[31mnow' }),
      report: report(`done with hunter2-very-secret ${'x'.repeat(400)}`), target: { id: 'refs/heads/\u0007bell', protected: false },
      change: change(['src/hunter2-very-secret.ts']) }));
    const text = JSON.stringify(summary);
    expect(text).not.toContain('ghp_abcdefghijklmnop'); expect(text).not.toContain('hunter2-very-secret'); expect(text).not.toMatch(/\\u00[0-1]|\\[nrt]/u);
    expect(summary.outcome).toMatchObject({ truncated: true });
    if (summary.outcome.state !== 'available') throw new Error('expected outcome');
    expect(Array.from(summary.outcome.summary)).toHaveLength(240);
    expect(summary.target).toEqual({ state: 'available', id: 'refs/heads/bell', protected: false });
  });
  it('fills the workspace change section from the patch and its K6 scope classification', () => {
    const file = (text: string) => ({ mode: '100644' as const, text, digest: 'd'.repeat(64) });
    const patch = { changes: [{ path: 'src/a.ts', before: file('a\nb\n'), after: file('a\nc\nd\n') }, { path: 'docs/x.md', before: null, after: file('x\n') }] };
    expect(workspacePatchChangeFacts(patch, classifyPatchScope(patch, ['src/**'], 'warn', INSTRUCTION_SURFACE_PATHS))).toEqual({ adapter: 'workspace-patch', paths: ['src/a.ts', 'docs/x.md'],
      added: 4, removed: 2, scope: 'out-of-scope', outOfScope: ['docs/x.md'] });
    expect(workspacePatchChangeFacts(patch, classifyPatchScope(patch, null, 'warn', INSTRUCTION_SURFACE_PATHS))).toMatchObject({ scope: 'unscoped', outOfScope: [] });
  });
  it('G1: carries instruction-surface writes from the scope classification into the change facts and flags them on the risk line', () => {
    const file = (text: string) => ({ mode: '100644' as const, text, digest: 'd'.repeat(64) });
    const patch = { changes: [{ path: 'AGENTS.md', before: file('a\n'), after: file('b\n') }, { path: 'src/a.ts', before: null, after: file('x\n') }] };
    const facts_ = workspacePatchChangeFacts(patch, classifyPatchScope(patch, ['src/**'], 'warn', INSTRUCTION_SURFACE_PATHS));
    expect(facts_).toMatchObject({ scope: 'out-of-scope', outOfScope: ['AGENTS.md'], instructionSurface: ['AGENTS.md'] });
    expect(projectDeliverySummary(facts({ change: facts_ })).risk.flags).toContain('instruction-surface');
    const named = workspacePatchChangeFacts(patch, classifyPatchScope(patch, ['src/**', 'AGENTS.md'], 'warn', INSTRUCTION_SURFACE_PATHS));
    expect(named).not.toHaveProperty('instructionSurface');
    expect(projectDeliverySummary(facts({ change: named })).risk.flags).not.toContain('instruction-surface');
  });
});

describe('autonomy@1 rule (data, pure, shadow only)', () => {
  const base: AutonomyFacts = { operation: 'deliver', targetProtected: false, acceptanceVerdict: 'accepted', verificationPhase: 'accepted', modelVerdict: 'verified',
    riskClass: 'small', sizeBucket: 'small', scope: 'in-scope', outOfScopeCount: 0 };
  it('reads the owner Q1 eligible model verdicts and thresholds from the versioned asset', () => {
    expect(AUTONOMY_RULE).toMatchObject({ rule: { id: 'autonomy', version: 1 }, modelVerdicts: ['verified', 'start-name-matched'], operations: ['deliver'], maxSizeBucket: 'small' });
    expect(evaluateAutonomy(base)).toEqual({ rule: { id: 'autonomy', version: 1, digest: autonomyRuleDigest() }, verdict: 'would-deliver', reasons: [] });
  });
  it.each([
    [{ operation: 'adopt' }, 'operation-not-eligible'], [{ operation: 'rollback' }, 'operation-not-eligible'],
    [{ targetProtected: true }, 'target-protected'], [{ targetProtected: null }, 'target-unknown'],
    [{ acceptanceVerdict: 'accepted-unverified' }, 'acceptance-not-eligible'], [{ acceptanceVerdict: 'pending' }, 'acceptance-not-eligible'],
    [{ verificationPhase: null }, 'verification-missing'], [{ verificationPhase: 'failed' }, 'verification-not-accepted'], [{ verificationPhase: 'pending' }, 'verification-not-accepted'],
    [{ verificationPhase: 'withheld' }, 'evidence-withheld'], [{ modelVerdict: 'withheld' }, 'evidence-withheld'], [{ scope: 'withheld', sizeBucket: null }, 'evidence-withheld'],
    [{ modelVerdict: null }, 'model-verdict-missing'], [{ riskClass: 'other' }, 'risk-class-not-eligible'],
    [{ sizeBucket: null }, 'size-unknown'], [{ sizeBucket: 'medium' }, 'size-over-bound'], [{ sizeBucket: 'large' }, 'size-over-bound'], [{ sizeBucket: 'not-a-bucket' }, 'size-unknown'],
    [{ scope: 'unscoped' }, 'scope-undeclared'], [{ scope: 'out-of-scope', outOfScopeCount: 1 }, 'out-of-scope-changes'],
  ] as [Partial<AutonomyFacts>, string][])('holds %j with %s', (change, reason) => {
    const result = evaluateAutonomy({ ...base, ...change });
    expect(result.verdict).toBe('would-hold'); expect(result.reasons).toContain(reason);
    expect(result.reasons.every(code => (AUTONOMY_HOLD_REASONS as readonly string[]).includes(code))).toBe(true);
  });
  it.each(DELIVERY_MODEL_VERDICTS)('model verdict %s is eligible only when the rule data lists it', verdict => {
    const result = evaluateAutonomy({ ...base, modelVerdict: verdict });
    expect(result.verdict).toBe(['verified', 'start-name-matched'].includes(verdict) ? 'would-deliver' : 'would-hold');
    if (result.verdict === 'would-hold') expect(result.reasons).toEqual(['model-verdict-not-eligible']);
  });
  it('changes behaviour through data, not code, and binds the exact data digest', () => {
    const wider = { ...AUTONOMY_RULE, modelVerdicts: [...AUTONOMY_RULE.modelVerdicts, 'provider-chosen' as const], maxSizeBucket: 'medium' };
    expect(evaluateAutonomy({ ...base, modelVerdict: 'provider-chosen', sizeBucket: 'medium' }, wider)).toMatchObject({ verdict: 'would-deliver', reasons: [] });
    expect(autonomyRuleDigest(wider)).not.toBe(autonomyRuleDigest());
    expect(autonomyRuleDigest()).toBe(autonomyRuleDigest({ ...AUTONOMY_RULE }));
  });
  it('collects every unmet condition once, deterministically', () => {
    const facts_: AutonomyFacts = { operation: 'rollback', targetProtected: true, acceptanceVerdict: 'not-accepted', verificationPhase: 'withheld', modelVerdict: 'withheld',
      riskClass: 'other', sizeBucket: null, scope: 'withheld', outOfScopeCount: null };
    expect(evaluateAutonomy(facts_).reasons).toEqual(['operation-not-eligible', 'target-protected', 'acceptance-not-eligible', 'evidence-withheld', 'risk-class-not-eligible', 'size-unknown']);
    expect(evaluateAutonomy(facts_)).toEqual(evaluateAutonomy(facts_));
  });
  it('evaluates the same envelope the card shows', () => {
    expect(evaluateAutonomy(autonomyFacts(projectDeliverySummary(facts()))).verdict).toBe('would-deliver');
    expect(evaluateAutonomy(autonomyFacts(projectDeliverySummary(facts({ model: model('provider-chosen') })))).reasons).toEqual(['model-verdict-not-eligible']);
    expect(evaluateAutonomy(autonomyFacts(projectDeliverySummary(facts({ verification: null, change: null })))).reasons).toEqual(['verification-missing', 'size-unknown']);
  });
});

describe('DeliverySummaryApplication (authorized reads only)', () => {
  const principal = { id: 'human', issuer: 'local', subject: 'human' } as unknown as VerifiedPrincipal;
  const deny = () => Promise.reject(Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }));
  const request = { schemaVersion: 1 as const, identity, operation: 'deliver' as const, target: { id: 'refs/heads/feature', protected: false }, verificationRunId: 'queue-verify-1' };
  function app(options: { inspect?: (runId: string) => Promise<void>; output?: () => Promise<void>; change?: () => Promise<DeliveryChangeFacts | null>; runs?: Record<string, RunSnapshot> } = {}) {
    const runs = options.runs ?? { run: run(), 'queue-verify-1': { ...run(), identity: { scopeId: 'scope', runId: 'queue-verify-1', layoutRevision: 'layout' } } as RunSnapshot };
    const reads: string[] = [];
    const application = new DeliverySummaryApplication({
      store: { async loadRun(_scope, runId) { reads.push(`run:${runId}`); return runs[runId] ?? null; },
        async loadBoundDispatch() { reads.push('dispatch'); return null; }, async loadWorkerEventLog() { reads.push('events'); return null; } },
      artifacts: { async read() { throw new Error('unexpected read'); } },
      runs: { authorize: (_action, query) => options.inspect?.(query.runId) ?? Promise.resolve() },
      attempts: { authorizeIdentity: () => options.output?.() ?? Promise.resolve() },
      change: options.change ?? (async () => change()) });
    return { application, reads };
  }
  it('refuses the whole summary when the Run may not be inspected, before any read', async () => {
    const { application, reads } = app({ inspect: deny });
    await expect(application.describe(request, principal)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(reads).toEqual([]);
  });
  it('withholds claim, checks and model when read-output is refused, and the verification Run when it may not be inspected', async () => {
    const { application, reads } = app({ output: deny, inspect: runId => runId === 'queue-verify-1' ? deny() : Promise.resolve() });
    const summary = await application.describe(request, principal);
    expect(summary).toMatchObject({ outcome: { state: 'withheld' }, tests: { worker: { state: 'withheld' }, verification: { state: 'withheld' } }, model: { state: 'withheld' },
      change: { state: 'available' }, title: { source: 'work-input' } });
    expect(reads).toEqual(['run:run']);
  });
  it('reads the verification Run and the adapter change under the caller authority; a refused change is withheld', async () => {
    const ok = await app().application.describe(request, principal);
    expect(ok).toMatchObject({ outcome: { state: 'unavailable' }, model: { state: 'unavailable' }, tests: { verification: { state: 'available', runId: 'queue-verify-1', phase: 'accepted' } } });
    expect((await app({ change: deny }).application.describe(request, principal))?.change).toEqual({ state: 'withheld' });
    expect((await app({ change: async () => null }).application.describe({ ...request, verificationRunId: null }, principal))).toMatchObject({ change: { state: 'unavailable' },
      tests: { verification: { state: 'unavailable' } } });
    await expect(app({ change: () => Promise.reject(new Error('STORE_BROKEN')) }).application.describe(request, principal)).rejects.toThrow('STORE_BROKEN');
  });
  it('answers null for a missing Run or an Attempt that is not bound to it', async () => {
    expect(await app({ runs: {} }).application.describe(request, principal)).toBeNull();
    expect(await app().application.describe({ ...request, identity: { ...identity, attemptId: 'other' } }, principal)).toBeNull();
  });
});

describe('queue commit title (queue-custody)', () => {
  const record = (candidateVersion: string | null) => ({ request: { identity, acceptedRevision: 7, submittedAt: 1000 },
    candidate: candidateVersion === null ? null : { candidateVersion } }) as unknown as TargetQueueRecord;
  const plan = async (metadata: { title: string }) => ({ commit: `commit:${metadata.title}` });
  it('uses the work-input title, else the task id', () => {
    expect(queueCommitMetadata(record(null), run())).toEqual({ title: 'Login banner fix', acceptance: { phase: 'accepted', criteria: 2, runRevision: 7, modelUnverified: false }, deliveredAtMs: 1000 });
    expect(queueCommitMetadata(record(null), run({ title: null })).title).toBe('task');
  });
  it('replays a candidate planned before alpha.53 (task-id title) and never weakens the commit match', async () => {
    expect(await planQueueCommit(record(null), run(), plan)).toEqual({ commit: 'commit:Login banner fix' });
    expect(await planQueueCommit(record('commit:Login banner fix'), run(), plan)).toEqual({ commit: 'commit:Login banner fix' });
    expect(await planQueueCommit(record('commit:task'), run(), plan)).toEqual({ commit: 'commit:task' });
    // Neither title matches: the caller's exact `plan.commit === candidateVersion` check still refuses.
    expect(await planQueueCommit(record('commit:other'), run(), plan)).not.toEqual({ commit: 'commit:other' });
  });
});
