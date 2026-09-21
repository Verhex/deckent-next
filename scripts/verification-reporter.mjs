import { verificationContext } from './verify-context.mjs';

// Uses actual collected outcomes, not a source regex guessing the truth of skipIf predicates.
export default class VerificationReporter {
  onTestRunEnd(modules, unhandledErrors, reason) {
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
    let collectionErrors = 0;
    for (const module of modules) {
      collectionErrors += module.errors().length;
      for (const test of module.children.allTests()) {
        const result = test.result();
        counts[result.state]++;
        if (result.state === 'skipped' || result.state === 'pending') {
          console.log(`verify-not-run: ${JSON.stringify({ file: module.relativeModuleId,
            test: test.fullName, state: result.state,
            reason: result.note ?? 'not-reported-by-test; do-not-infer-platform-or-env-cause' })}`);
        }
      }
    }
    console.log(`verify-evidence: ${JSON.stringify({ schemaVersion: 1, context: verificationContext(),
      runReason: reason, collectedModules: modules.length, counts, collectionErrors,
      unhandledErrors: unhandledErrors.length, coverage: 'collected-tests-only' })}`);
  }
}
