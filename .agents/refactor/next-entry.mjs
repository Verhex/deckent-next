#!/usr/bin/env node
// Development-host entry only; excluded from customer packages.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const invoked = process.argv[1]?.split('/').at(-1);
const args = process.argv.slice(2);
const surface = invoked === 'deckent-mcp' ? 'mcp' : invoked === 'deckent' ? 'cli' : args.shift();
if (!['cli', 'mcp', 'node'].includes(surface)) { process.stderr.write('NEXT_ENTRY_SURFACE_REQUIRED\n'); process.exit(2); }
const env = { ...process.env, DECKENT_GLOBAL_HOME: resolve(root, '.deckent/host/global') };
// Legacy root overrides must not redirect this checkout's execution or monitoring.
delete env.DECKENT_HOME;
const entry = surface === 'node' ? [] : [resolve(root, `dist/composition/core/${surface}/internal/entry.js`)];
const child = spawn(process.execPath, [...entry, ...args], { cwd: root, env, stdio: 'inherit' });
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('NEXT_ENTRY_FAILED\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
