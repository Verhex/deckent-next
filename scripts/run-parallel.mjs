#!/usr/bin/env node
// Runs independent verification commands concurrently; prints each command's output as one block, fails if any fails.
import { spawn } from 'node:child_process';

const commands = process.argv.slice(2);
if (commands.length === 0) { console.error('usage: run-parallel.mjs "<command>" ...'); process.exit(2); }
const results = await Promise.all(commands.map(command => new Promise(resolve => {
  const started = Date.now(); let output = '';
  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('close', code => resolve({ command, code: code ?? 1, output, ms: Date.now() - started }));
})));
for (const r of results) {
  process.stdout.write(`\n> ${r.command} (${(r.ms / 1000).toFixed(1)} s, exit ${r.code})\n${r.output}`);
}
process.exit(results.some(r => r.code !== 0) ? 1 : 0);
