// Crash-loop breaker host proof (pilot1 2026-10-17): one start-up progression turn of the built composition in its own process, run from
// the fixture project directory (cwd). argv[2] = 'abort' replaces the secret gate's regex worker thread so this process is killed with
// SIGKILL (no core file) at the gate, standing in for the native abort pilot1 saw there; nothing after that point runs, nothing is settled.
// The turn's own outcome is printed as one JSON line; a killed process prints nothing.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { advanceConfiguredRun } from '#composition/core/run-progression/index.js';

if (process.argv[2] === 'abort') {
  const threads = createRequire(import.meta.url)('node:worker_threads');
  threads.Worker = class { constructor() { process.kill(process.pid, 'SIGKILL'); } };
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
