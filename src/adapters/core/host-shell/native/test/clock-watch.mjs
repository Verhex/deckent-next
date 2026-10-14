import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const helper = resolve(import.meta.dirname, '../build/Release/shell-clock-watch');
// The watch answers "armed" before anything else and, at stdin end of file, "steady" when the realtime clock was not set meanwhile (bytes
// written to stdin before the end are ignored). Setting the clock needs CAP_SYS_TIME (a user namespace does not grant it for the host
// clock), so the "stepped" answer is covered by the adapter tests through an injected watch and by the owner-run step check.
function run(input, delayMs) {
  return new Promise((done, reject) => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      out += chunk;
      if (out === 'armed\n') setTimeout(() => { if (input) child.stdin.write(input); child.stdin.end(); }, delayMs);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => done({ code, out, err }));
  });
}
test('clock watch: armed first, steady at end of file without a clock set, input ignored', async () => {
  assert.deepEqual(await run('', 0), { code: 0, out: 'armed\nsteady\n', err: '' });
  assert.deepEqual(await run('anything\n', 300), { code: 0, out: 'armed\nsteady\n', err: '' });
});
