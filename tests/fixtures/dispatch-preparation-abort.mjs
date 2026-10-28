// Crash-loop breaker host proof (pilot1 2026-10-17): one start-up progression turn of the built composition in its own process, run from
// the fixture project directory (cwd). argv[2] = 'abort' replaces the secret gate's regex worker thread so this process is killed with
// SIGKILL (no core file) at the gate, standing in for the native abort pilot1 saw there; nothing after that point runs, nothing is settled.
// 'abort-2' (two concurrent Attempts): the first gate's worker stays silent and the second gate's kills, so both die inside the gate.
// The turn's own outcome is printed as one JSON line; a killed process prints nothing.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { advanceConfiguredRun } from '#composition/core/run-progression/index.js';
import { GitWorkspaceBroker } from '#adapters/index.js';

// 'refuse-die' (BeUser D-05): the attempt is refused typed and transient before any claim (workspace), the turn prints its outcome, then the
// process is killed — standing in for Node 26 ending the service for a FileHandle collected after the refusal had settled.
const refuseDie = process.argv[2] === 'refuse-die';
if (refuseDie) GitWorkspaceBroker.prototype.allocate = async () => { throw Object.assign(new Error('fixture workspace refusal'), { code: 'FIXTURE_WORKSPACE_REFUSED' }); };

const killAt = { abort: 1, 'abort-2': 2 }[process.argv[2]] ?? 0;
if (killAt) {
  const threads = createRequire(import.meta.url)('node:worker_threads'); let made = 0;
  threads.Worker = class {
    constructor() { if (++made >= killAt) process.kill(process.pid, 'SIGKILL'); }
    on() { return this; } unref() {} postMessage() {} terminate() { return Promise.resolve(0); }
  };
  syncBuiltinESMExports();
}
try {
  const result = await advanceConfiguredRun(process.cwd(), { schemaVersion: 1, scopeId: 's', runId: 'r' }, new AbortController().signal, { env: process.env });
  process.stdout.write(JSON.stringify({ ok: true, attempted: result.attempted }) + '\n');
} catch (error) {
  // A turn failure wraps the typed cause (the runtime's journal unwraps it the same way).
  const typed = error?.cause?.code ? error.cause : error;
  process.stdout.write(JSON.stringify({ ok: false, code: typed?.code ?? null, params: typed?.params ?? null }) + '\n');
}
if (refuseDie) process.kill(process.pid, 'SIGKILL');
