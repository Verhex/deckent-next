import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { ReconciliationRecoveryApplication, ReconciliationRuntimeLoop, RuntimeServiceLifecycle, type AttemptIdentity } from '#engine/index.js';
import { main } from '#surfaces/index.js';
import { resolveProductPaths } from '#platform/index.js';
import { waitForRecoveredOutput } from '../support/recovered-output-event.js';

const identity: AttemptIdentity = { scopeId: 'scope', runId: 'cancel', taskId: 'task', attemptId: 'attempt', generation: 1, layoutRevision: 'layout' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function event(changes: Record<string, unknown> = {}) {
  return JSON.stringify({ event: 'reconciliation', result: { outcomes: [{ identity, status: 'output-recovered', completeness: 'partial', ...changes }] } });
}

function recoveringCancelledAttempt() {
  const stdout = new PassThrough(), outputEntered = deferred(), output = deferred(), expiry = deferred(), controller = new AbortController();
  let outputRecorded = false;
  // The same durable state the installed test observed: cancelled worker is terminal, logs still absent.
  const app = new ReconciliationRecoveryApplication({ async inspect() { return { nextAfter: null, entries: [{
    identity, owner: 'owner', launch: 'granted' as const, terminal: { handle: 'container', exitCode: 137, interrupted: null },
    cancellationRequested: true, outputRecorded,
  }] }; } }, {
    async reconcile() { throw new Error('TERMINAL_ALREADY_RECORDED'); },
    async recoverOutput() { outputEntered.resolve(); await output.promise; outputRecorded = true; return { completeness: 'partial' as const }; },
  }, { maxPageSize: 1, maxConcurrentReconciliations: 1 });
  const observed = waitForRecoveredOutput(stdout, identity);
  const loop = new ReconciliationRuntimeLoop(command => app.recover(command), async (_milliseconds, signal) => {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, { now: () => 0 }, {
    onPage(command, result) { stdout.write(`${JSON.stringify({ event: 'reconciliation', command, result })}\n`); },
    onError(_command, error) { throw error; },
  }, { scopeIds: [identity.scopeId], pollIntervalMs: 20, failureBackoffMs: 20 });
  const running = loop.run(controller.signal);
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {
    controller.abort(); return running;
  }, { async wait(milliseconds) { expect(milliseconds).toBe(1000); await expiry.promise; } });
  return { stdout, outputEntered, output, expiry, observed, lifecycle, async close() {
    output.resolve(); await lifecycle.stop(1000); await lifecycle.whenSettled(); stdout.end();
  } };
}

it('reproduces incomplete shutdown when terminal cancellation is mistaken for completed output recovery', async () => {
  const f = recoveringCancelledAttempt();
  try {
    await f.outputEntered.promise;
    const stopping = f.lifecycle.stop(1000); f.expiry.resolve();
    await expect(stopping).resolves.toEqual({ state: 'incomplete', remainingRequests: 0, recoveryPending: true });
    // The existing product keeps recovery custody after expiry; it does not discard the output operation.
    let settled = false; void f.lifecycle.whenSettled().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    f.output.resolve(); await f.observed; await f.lifecycle.whenSettled(); expect(settled).toBe(true);
  } finally { await f.close(); }
});

it('waits for the completed recovery page before asking for clean shutdown with the unchanged grace', async () => {
  const f = recoveringCancelledAttempt();
  try {
    await f.outputEntered.promise;
    let ready = false; void f.observed.then(() => { ready = true; });
    f.stdout.write(`${event({ status: 'terminal' })}\n`);
    await Promise.resolve(); expect(ready).toBe(false);
    f.output.resolve(); await f.observed;
    await expect(f.lifecycle.stop(1000)).resolves.toEqual({ state: 'clean', remainingRequests: 0, recoveryPending: false });
  } finally { await f.close(); }
});

it('keeps an early event until awaited, accepts split lines and matches the entire attempt identity', async () => {
  const stdout = new PassThrough(), recovered = waitForRecoveredOutput(stdout, identity);
  let ready = false; void recovered.then(() => { ready = true; });
  stdout.write('not-json\nnull\n');
  for (const [key, value] of Object.entries(identity)) {
    stdout.write(`${event({ identity: { ...identity, [key]: typeof value === 'number' ? value + 1 : `${value}-other` } })}\n`);
  }
  for (const status of ['terminal', 'unresolved', 'failed', 'skipped']) stdout.write(`${event({ status })}\n`);
  stdout.write(`${event({ completeness: 'unavailable' })}\n`);
  stdout.write(event().slice(0, 12)); await Promise.resolve(); expect(ready).toBe(false);
  stdout.write(`${event().slice(12)}\n`); await recovered; expect(ready).toBe(true); stdout.end();
});

it('rejects a closed service output without the matching completed page', async () => {
  const stdout = new PassThrough(), recovered = waitForRecoveredOutput(stdout, identity);
  stdout.end(`${event({ status: 'failed' })}\n`);
  await expect(recovered).rejects.toThrow('RECOVERY_OUTPUT_EVENT_MISSING: attempt');
});

it('observes the real CLI recovery event even before ready and keeps draining subsequent diagnostics', async () => {
  const stdout = new PassThrough(), signal = new AbortController(), done = deferred(), chunks: string[] = [];
  stdout.on('data', chunk => { chunks.push(String(chunk)); });
  const recovered = waitForRecoveredOutput(stdout, identity);
  const serving = main(['runtime', 'serve', '--json'], {
    root: '/fixture/project', env: { HOME: '/fixture/home' }, signal: signal.signal, stdout, stderr: { write() {} },
    async startRuntimeService(_root, observer) {
      await observer.onReconciliationPage?.({ schemaVersion: 1, scopeId: identity.scopeId, after: null }, {
        nextAfter: null, outcomes: [{ identity, status: 'output-recovered', completeness: 'partial' }],
      });
      return { endpoint: '/runtime.sock', layout: resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } }),
        done: done.promise, async stop() { done.resolve(); return { state: 'clean', remainingRequests: 0, recoveryPending: false }; } };
    },
  });
  try {
    await Promise.race([recovered, serving.then(code => { throw new Error(`SERVICE_ENDED_${code}: ${chunks.join('')}`); })]);
    signal.abort(); expect(await serving).toBe(0);
    expect(chunks.join('').trim().split('\n').map(line => JSON.parse(line).event)).toEqual(['reconciliation', 'ready', 'stopped']);
  } finally { signal.abort(); await serving; stdout.end(); }
});
