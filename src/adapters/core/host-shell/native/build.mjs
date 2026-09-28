import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Two helpers, no downloads or installation: the capability probe (S5) and the Landlock + seccomp launcher (S11).
if (process.platform === 'linux') {
  for (const [source, name] of [['shell_capabilities.c', 'shell-capabilities'], ['shell_sandbox.c', 'shell-sandbox']]) {
    const out = resolve(import.meta.dirname, 'build/Release', name);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync(process.env.CC ?? 'cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', out],
      { cwd: import.meta.dirname, stdio: 'inherit' });
  }
}
