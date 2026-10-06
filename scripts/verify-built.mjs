import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBuild } from './ci-build-artifact.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
validateBuild(root);
for (const script of ['lint:checks', 'test:native', 'test', 'test:host', 'smoke']) {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], { cwd: root, stdio: 'inherit' });
}
