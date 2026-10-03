#!/usr/bin/env node
// Development-host entry only; excluded from customer packages.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const invoked = process.argv[1] ? basename(process.argv[1]) : undefined;
const args = process.argv.slice(2);
const surface = invoked === 'deckent-mcp' ? 'mcp' : invoked === 'deckent' ? 'cli' : args.shift();
if (!['cli', 'mcp', 'node'].includes(surface)) { process.stderr.write('NEXT_ENTRY_SURFACE_REQUIRED\n'); process.exit(2); }
// DEV-U2-0 (owner U2 option C, 2026-09-30): the code comes from the staged version `current` points to (dev-release.mjs stage/switch),
// resolved here to its real path, so a process keeps loading its own version directory for its whole life (ESM resolves and caches
// real-path URLs) and a switch never exposes a half-built tree. Without `current` the checkout's dist runs as before. A `current` that does
// not name a staged version outside the checkout is refused, never replaced by the checkout (that would reopen the rebuild window).
const installRoot = resolve(process.env.DECKENT_NEXT_INSTALL_ROOT || resolve(homedir(), '.local/share/deckent-next-dev'));
function codeRoot() {
  const pointer = resolve(installRoot, 'current');
  try { lstatSync(pointer); } catch { return root; }
  try {
    const real = realpathSync(pointer), versions = realpathSync(resolve(installRoot, 'versions'));
    const release = JSON.parse(readFileSync(resolve(real, 'release.json'), 'utf8'));
    if (dirname(real) === versions && release.versionId === basename(real) && !`${real}${sep}`.startsWith(`${root}${sep}`)
      && existsSync(resolve(real, 'dist/build-identity.json'))) return real;
  } catch { /* refused below */ }
  process.stderr.write(`NEXT_ENTRY_CURRENT_INVALID ${pointer}\n`); process.exit(2);
}
// The global root must live outside the checkout: the runtime copies the bundled bubblewrap there, and a launcher inside the project is
// refused (a sandboxed command could replace it) — live switch 2026-09-29 fell back to Landlock because of this.
const env = { ...process.env, DECKENT_GLOBAL_HOME: resolve(homedir(), '.local/state/deckent-next-dev') };
// Legacy root overrides must not redirect this checkout's execution or monitoring.
delete env.DECKENT_HOME;
delete env.DECKENT_NEXT_INSTALL_ROOT;
const entry = surface === 'node' ? [] : [resolve(codeRoot(), `dist/composition/core/${surface}/internal/entry.js`)];
// cwd stays the project root (its config and live data) whichever tree the code comes from.
const child = spawn(process.execPath, [...entry, ...args], { cwd: root, env, stdio: 'inherit' });
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('NEXT_ENTRY_FAILED\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
