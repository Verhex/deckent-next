import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { expect, it } from 'vitest';

// Execute the real ancestor-pin implementation in a separate process with Windows path semantics. A synchronous loop cannot be
// interrupted by Vitest's in-process deadline; the child deadline kills it and preserves a bounded regression on the Linux proof host.
it('bounds ancestor pin traversal at Windows drive and UNC roots and keeps POSIX protection pins intact', () => {
  const source = readFileSync(new URL('../../../src/adapters/core/shell-sandbox-bwrap/internal/arguments.ts', import.meta.url), 'utf8')
    .replace("import { dirname } from 'node:path';", "import { win32 } from 'node:path'; const dirname = win32.dirname;");
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const view = { projectRoot: String.raw`D:\fixture\project`, scratchDir: String.raw`D:\fixture\state\scratch`, home: null,
    systemPaths: [], toolchainPaths: [], readOnlyPaths: [String.raw`D:\fixture\project\.git`], maskedDirectories: [], maskedFiles: [] };
  const uncView = { ...view, projectRoot: String.raw`\\host\share\project`, scratchDir: null, readOnlyPaths: [String.raw`\\host\share\project\.git`] };
  const posixView = { ...view, projectRoot: '/tmp/x/project', scratchDir: null, readOnlyPaths: ['/tmp/x/project/docs/private'] };
  const driver = `import {ancestorPins} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify([ancestorPins(${JSON.stringify(view)}),ancestorPins(${JSON.stringify(uncView)}),ancestorPins(${JSON.stringify(posixView)})]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL' });
  expect(result.error?.message ?? result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([[], [], ['/tmp/x/project/docs']]); // Unsupported drive view grants no POSIX containment; it must only finish.
}, 30_000);
