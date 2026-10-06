import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verificationContext } from './verify-context.mjs';

// Uses actual collected outcomes, not a source regex guessing the truth of skipIf predicates.
export default class VerificationReporter {
  onTestRunEnd(modules, unhandledErrors, reason) {
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
    let collectionErrors = 0;
    const files = [];
    for (const module of modules) {
      const fileCounts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
      collectionErrors += module.errors().length;
      for (const error of module.errors()) {
        console.log(`verify-failed-test: ${JSON.stringify({ file: module.relativeModuleId,
          test: null, state: 'collection-error', reason: error.name ?? 'collection-error' })}`);
      }
      for (const test of module.children.allTests()) {
        const result = test.result();
        if (!(result.state in counts)) throw new Error('Unknown test outcome');
        counts[result.state]++;
        fileCounts[result.state]++;
        if (result.state === 'failed') {
          console.log(`verify-failed-test: ${JSON.stringify({ file: module.relativeModuleId,
            test: test.fullName, state: result.state })}`);
        }
        if (result.state === 'skipped' || result.state === 'pending') {
          console.log(`verify-not-run: ${JSON.stringify({ file: module.relativeModuleId,
            test: test.fullName, state: result.state,
            reason: result.note ?? 'not-reported-by-test; do-not-infer-platform-or-env-cause' })}`);
        }
      }
      files.push({ file: module.relativeModuleId.replaceAll('\\', '/'), state: module.state(), counts: fileCounts,
        collectionErrors: module.errors().length, durationMs: module.diagnostic().duration });
    }
    for (const error of unhandledErrors) {
      console.log(`verify-failed-test: ${JSON.stringify({ file: null, test: null,
        state: 'unhandled-error', reason: error.name ?? 'unhandled-error' })}`);
    }
    if (process.env.DECKENT_CI_EVIDENCE_DIR) writeFileSync(join(process.env.DECKENT_CI_EVIDENCE_DIR, 'files.json'),
      JSON.stringify({ runReason: reason, files, collectionErrors, unhandledErrors: unhandledErrors.length }) + '\n');
    console.log(`verify-evidence: ${JSON.stringify({ schemaVersion: 1, context: verificationContext(),
      runReason: reason, collectedModules: modules.length, counts, collectionErrors,
      unhandledErrors: unhandledErrors.length, coverage: 'collected-tests-only' })}`);
  }
}
