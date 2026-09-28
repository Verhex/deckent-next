import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runKernelCommand } from '#surfaces/core/cli/index.js';

// SCR-B (owner 2026-09-28): doctor shows the recognized first-run policy template id/version (or null), wired
// through `context.inspectPolicyTemplate` the same optional-handler way as `inspectToolchainCurrency`.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() { const root = await mkdtemp(join(tmpdir(), 'deckent-doctor-policy-template-')); roots.push(root); return root; }

it('includes policyTemplate in doctor JSON when a template is recognized', async () => {
  const root = await project(); const lines: string[] = [];
  const context = { root, env: { HOME: join(root, '..', 'home') }, stdout: { write: (text: string) => { lines.push(text); return true; } },
    inspectPolicyTemplate: async () => ({ id: 'first-run-template', version: 1 }) };
  await runKernelCommand(['doctor', '--json'], context);
  expect(JSON.parse(lines.join(''))).toMatchObject({ policyTemplate: { id: 'first-run-template', version: 1 } });
});
it('is null, not a failure, when no handler is wired or no template is recognized', async () => {
  const root = await project(); const lines: string[] = [];
  const env = { HOME: join(root, '..', 'home') };
  await runKernelCommand(['doctor', '--json'], { root, env, stdout: { write: (text: string) => { lines.push(text); return true; } } });
  expect(JSON.parse(lines.join(''))).toMatchObject({ policyTemplate: null });
  lines.length = 0;
  const withHandler = { root, env, stdout: { write: (text: string) => { lines.push(text); return true; } }, inspectPolicyTemplate: async () => null };
  await runKernelCommand(['doctor', '--json'], withHandler);
  expect(JSON.parse(lines.join(''))).toMatchObject({ policyTemplate: null });
});
