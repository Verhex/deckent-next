// Test-only stdout player. Never executes a recorded tool, reads login state, or connects to MCP.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const scenario = JSON.parse(readFileSync(self + '.json', 'utf8'));
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') {
  process.stdout.write(scenario.version + '\n');
} else if (scenario.cli === 'claude' ? argv.includes('--print') && argv.includes('stream-json') : argv[0] === 'exec' && argv.includes('--json')) {
  // Consume input without retaining prompts, environment, argv or credentials in logs.
  process.stdin.resume();
  const wire = readFileSync(join(dirname(self), 'stdout.jsonl'));
  if (createHash('sha256').update(wire).digest('hex') !== scenario.sha256) throw new Error('A0_FAKE_WIRE_DIGEST_MISMATCH');
  const write = async bytes => {
    for (let start = 0; start < bytes.length; start += scenario.chunkBytes) {
      await new Promise((resolve, reject) => process.stdout.write(bytes.subarray(start, start + scenario.chunkBytes), error => error ? reject(error) : resolve()));
    }
  };
  if (scenario.mode === 'interrupt') {
    let timer;
    const stopped = new Promise((resolve, reject) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      // Portable test control only; not a vendor event or MCP frame.
      process.once('message', message => { if (message === 'A0_FAKE_INTERRUPT') resolve(); });
      timer = setTimeout(() => reject(new Error('A0_FAKE_INTERRUPT_NOT_RECEIVED')), scenario.waitTimeoutMs);
    });
    try {
      await write(wire.subarray(0, scenario.pendingBytes));
      await stopped;
      await write(wire.subarray(scenario.pendingBytes));
      process.exitCode = scenario.exitCode;
    } finally {
      clearTimeout(timer);
      if (process.connected) process.disconnect();
    }
  } else {
    await write(wire);
    process.exitCode = scenario.exitCode;
  }
} else {
  process.stderr.write(`${basename(self)}: A0_FAKE_UNRECORDED_INVOCATION\n`);
  process.exitCode = 2;
}
