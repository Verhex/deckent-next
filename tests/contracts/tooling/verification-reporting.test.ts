import { describe, expect, it } from 'vitest';
import VerificationReporter from '../../../scripts/verification-reporter.mjs';
import { verificationSummary } from '../../../scripts/ci-verification-summary.mjs';

describe('hosted verification evidence', () => {
  it('preserves failing tests, collection errors, typed skips and real counts from the reporter', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      new VerificationReporter().onTestRunEnd([{ relativeModuleId: 'tests/example.test.ts',
        errors: () => [{ name: 'ImportError' }], children: { allTests: () => [
          { fullName: 'fails', result: () => ({ state: 'failed' }) },
          { fullName: 'unsupported', result: () => ({ state: 'skipped', note: 'NATIVE_PLATFORM_UNSUPPORTED: fixture requires Linux' }) },
          { fullName: 'passes', result: () => ({ state: 'passed' }) },
        ] } }], [], 'failed');
    } finally { console.log = original; }
    const summary = verificationSummary(lines.join('\n'), 'failure', { sha: 'candidate' });
    expect(summary).toMatchObject({ collection: 'reported', verifyStepOutcome: 'failure', identity: { sha: 'candidate' },
      evidence: { counts: { passed: 1, failed: 1, skipped: 1, pending: 0 }, collectionErrors: 1 },
      failedTests: [{ file: 'tests/example.test.ts', test: null, state: 'collection-error', reason: 'ImportError' },
        { file: 'tests/example.test.ts', test: 'fails', state: 'failed' }],
      notRun: [{ reason: 'NATIVE_PLATFORM_UNSUPPORTED: fixture requires Linux' }] });
  });

  it('marks preparation/build interruption as unreported instead of successful zero tests', () => {
    expect(verificationSummary('build failed\n', 'skipped')).toMatchObject({ collection: 'not-reported',
      evidence: null, verifyStepOutcome: 'skipped', failedTests: [], reason: expect.stringContaining('VERIFY_OUTCOMES_UNAVAILABLE') });
    expect(() => verificationSummary('verify-evidence: {bad}', 'failure')).toThrow();
    expect(verificationSummary('not ok 2 - host journal refuses aliases\n', 'failure').failedTests)
      .toEqual([{ file: null, test: 'host journal refuses aliases', state: 'failed', runner: 'node-test' }]);
    expect(verificationSummary('ok 2 - private journal # SKIP JEV_JOURNAL_UNSUPPORTED: Windows\n', 'success').notRun)
      .toMatchObject([{ test: 'private journal', reason: 'JEV_JOURNAL_UNSUPPORTED: Windows', runner: 'node-test' }]);
    expect(verificationSummary('# verify-not-run: {"reason":"CAPABILITY_UNSUPPORTED"}\n', 'failure').notRun)
      .toEqual([{ reason: 'CAPABILITY_UNSUPPORTED' }]);
  });
});
