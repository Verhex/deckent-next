import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Probe only: no downloads, installation, persistent namespaces or sandbox enforcement.
if (process.platform === 'linux') {
  const out = resolve(import.meta.dirname, 'build/Release/shell-capabilities');
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(process.env.CC ?? 'cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'shell_capabilities.c', '-o', out],
    { cwd: import.meta.dirname, stdio: 'inherit' });
}
