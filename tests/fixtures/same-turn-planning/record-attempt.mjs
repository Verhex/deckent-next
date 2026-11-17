// Fixture-only failure custody. No CLI imports: tests inject a fake runner.
export async function recordAttempt({ prepare, run, capture, cleanup }) {
  let attemptStage = 'prepare', invocationState = 'not-started', invocationCount = 0, result, failure = null;
  const cleanupFailures = [];
  const at = stage => { attemptStage = stage; };
  // Error messages/stacks may contain paths or secrets; retain only the typed code and stage.
  const failed = error => ({ stage: attemptStage, code: typeof error?.code === 'string' ? error.code : 'RECORDING_FAILED' });
  try {
    await prepare(at);
    at('runner'); invocationState = 'unknown'; invocationCount = null;
    result = await run();
    invocationState = result.started ? 'started' : 'not-started'; invocationCount = result.started ? 1 : 0;
    at('capture'); await capture(result);
  } catch (error) { failure = failed(error); }
  finally {
    for (const [stage, close] of cleanup) {
      at(stage);
      try { await close(); } catch (error) { cleanupFailures.push(failed(error)); }
    }
  }
  at(failure?.stage ?? cleanupFailures[0]?.stage ?? 'complete');
  return { attemptStage, invocationState, invocationCount, failure, cleanupFailures,
    process: result ? { reason: result.reason, exitCode: result.exitCode, signal: result.signal,
      stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, limit: result.limit, egress: result.egress } : null };
}
