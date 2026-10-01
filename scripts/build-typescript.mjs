import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// Execute this checkout's installed compiler with Node, without npx's Windows .cmd launcher or a shell.
export function buildTypeScript(root) {
  const compiler = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [compiler, '-p', 'tsconfig.json'],
    { cwd: root, stdio: 'inherit' });
}
