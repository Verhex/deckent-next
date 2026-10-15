// Platform verification (macOS/Windows) shard: the same checks as `npm run verify`, with the Vitest suite split across shards.
// Every shard builds for itself (no shared artifact across operating systems); shard 1 also runs the non-Vitest checks once.
// Unlike `npm run verify` the remaining steps still run after a failure, so one red check never hides the others' results.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The ordered steps of one shard; `stopOnFailure` steps gate everything after them (no build, no tests). */
export function shardPlan(index, count) {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || index < 1 || index > count) throw new Error(`invalid shard ${index}/${count}`);
  const node = (...args) => ({ command: 'node', args });
  const npm = name => ({ command: 'npm', args: ['run', name] });
  return [
    { name: 'verify-context', ...node('scripts/verify-context.mjs'), stopOnFailure: true },
    { name: 'build', ...npm('build'), stopOnFailure: true },
    { name: 'native test variants', ...node('scripts/test-native.mjs', '--build-test-variants'), stopOnFailure: true },
    { name: `vitest shard ${index}/${count}`, ...node('node_modules/vitest/vitest.mjs', 'run', '--shard', `${index}/${count}`) },
    ...(index === 1 ? [{ name: 'lint:checks', ...npm('lint:checks') }, { name: 'test:native', ...npm('test:native') },
      { name: 'test:host', ...npm('test:host') }, { name: 'smoke', ...npm('smoke') }] : []),
  ];
}

/** Runs the plan; returns the first non-zero exit code (0 when all passed) and each step's outcome. */
export function runShard(plan, execute) {
  const outcomes = [];
  let exitCode = 0;
  for (const step of plan) {
    const status = execute(step);
    outcomes.push({ name: step.name, status });
    if (status !== 0 && exitCode === 0) exitCode = status;
    if (status !== 0 && step.stopOnFailure) break;
  }
  return { exitCode, outcomes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [index, count] = process.argv.slice(2).map(Number);
  const { exitCode, outcomes } = runShard(shardPlan(index, count), step => {
    process.stdout.write(`platform-shard: ${step.name}\n`);
    // npm is a .cmd shim on Windows, which Node only spawns through a shell; the arguments are fixed literals above.
    const command = step.command === 'node' ? process.execPath : step.command;
    const result = spawnSync(command, step.args, { stdio: 'inherit', shell: step.command === 'npm' && process.platform === 'win32' });
    if (result.error) process.stderr.write(`platform-shard: ${step.name}: ${result.error.message}\n`);
    return result.status ?? 1;
  });
  process.stdout.write(`platform-shard: ${outcomes.map(item => `${item.name}=${item.status}`).join(', ')}\n`);
  process.exitCode = exitCode;
}
