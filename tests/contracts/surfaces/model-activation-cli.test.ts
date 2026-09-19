import { expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import type { ModelActivationInspection, ModelActivationResult } from '#engine/index.js';

const reference = { providerId: 'provider-a', providerVersion: 2, modelId: 'model-a', modelVersion: 3 };
const digest = 'a'.repeat(64);
const inspection: ModelActivationInspection = { schemaVersion: 1, scopeId: 'scope-a', reference, activation: null, availability: 'not-observed' };
const admission = {
  replayed: false,
  receipt: { schemaVersion: 1, command: { schemaVersion: 1, action: 'activate', commandId: 'command-a', scopeId: 'scope-a', reference,
    expectedRevision: 0, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest }, catalogRevision: 'catalog-a' },
  actor: { id: 'actor-a', issuer: 'local-os', subject: '1000', assurance: 'os-user' }, authorization: { revision: 'policy-a', ruleId: 'grant-a' },
  previousRevision: null, admittedAtMs: 100,
  record: { schemaVersion: 1, scopeId: 'scope-a', reference, revision: 1, state: 'active', catalogRevision: 'catalog-a',
    definition: { encodingVersion: 1, provider: { id: 'provider-a', version: 2 }, model: { id: 'model-a', version: 3, nativeId: 'vendor/model-a', protocols: [] } },
    binding: { encodingVersion: 1, algorithm: 'sha256', digest } } },
} as ModelActivationResult;
function sink() { const values: string[] = []; return { values, output: { write(value: string) { values.push(value); } } }; }
const common = ['--scope', 'scope-a', '--provider', 'provider-a', '--provider-version', '2', '--model', 'model-a', '--model-version', '3'];
const mutation = ['--command-id', 'command-a', '--expected-revision', '0', '--binding-digest', digest];

it('delegates exact immutable activation inspection without provider capability claims', async () => {
  const target = sink(); let received: unknown;
  const code = await main(['models', 'activation', ...common, '--json'], { root: '/project', env: { HOME: '/home/private' }, initialize() {}, stdout: target.output, stderr: target.output,
    async inspectModelActivation(root, query, options) { received = { root, query, home: options.env?.HOME }; return inspection; } });
  expect(code).toBe(0);
  expect(received).toEqual({ root: '/project', query: { schemaVersion: 1, scopeId: 'scope-a', reference }, home: '/home/private' });
  expect(JSON.parse(target.values.join(''))).toEqual(inspection);
});

it('constructs fixed protocol command fields and never invents actor, grant, binding, or catalog fields', async () => {
  const target = sink(); const calls: unknown[] = [];
  const code = await main(['models', 'activate', ...common, ...mutation, '--catalog-revision', 'catalog-a', '--json'], {
    root: '/project', initialize() {}, stdout: target.output, stderr: target.output,
    async admitModelActivation(root, command, options) { calls.push({ root, command, env: options.env }); return admission; },
  });
  expect(code).toBe(0); expect(calls).toEqual([{ root: '/project', env: process.env, command: {
    schemaVersion: 1, action: 'activate', commandId: 'command-a', scopeId: 'scope-a', reference, expectedRevision: 0,
    expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest }, catalogRevision: 'catalog-a',
  } }]);
  expect(JSON.parse(target.values.join(''))).toEqual(admission);

  await main(['models', 'deactivate', ...common, ...mutation.map(value => value === '0' ? '1' : value), '--json'], {
    root: '/project', initialize() {}, stdout: target.output, stderr: target.output,
    async admitModelActivation(_root, command) { calls.push(command); return admission; },
  });
  expect(calls[1]).toEqual({ schemaVersion: 1, action: 'deactivate', commandId: 'command-a', scopeId: 'scope-a', reference,
    expectedRevision: 1, expectedBinding: { encodingVersion: 1, algorithm: 'sha256', digest } });
});

it('rejects incomplete, duplicated, unsafe, malformed, and unknown input before either handler', async () => {
  const target = sink(); let inspectCalls = 0, admitCalls = 0;
  const context = { initialize() {}, stdout: target.output, stderr: target.output,
    async inspectModelActivation() { inspectCalls++; return inspection; },
    async admitModelActivation() { admitCalls++; return admission; } };
  const invalid = [
    ['models', 'activation', ...common.filter(value => value !== 'scope-a')],
    ['models', 'activation', ...common, '--scope', 'scope-b'],
    ['models', 'activate', ...common, ...mutation],
    ['models', 'activate', ...common, ...mutation, '--catalog-revision', 'catalog-a', '--expected-revision', '01'],
    ['models', 'deactivate', ...common, ...mutation, '--expected-revision', String(Number.MAX_SAFE_INTEGER + 1)],
    ['models', 'deactivate', ...common, ...mutation.slice(0, -1), 'A'.repeat(64)],
    ['models', 'activation', ...common, '--unknown'],
  ];
  for (const argv of invalid) expect(await main(argv, context)).toBe(2);
  expect({ inspectCalls, admitCalls }).toEqual({ inspectCalls: 0, admitCalls: 0 });
});

it('permits help without action fields and does not invoke handlers', async () => {
  const target = sink(); let calls = 0;
  const code = await main(['models', 'activation', '--help', '--lang', 'tr'], { initialize() {}, stdout: target.output, stderr: target.output,
    async inspectModelActivation() { calls++; return inspection; } });
  expect(code).toBe(0); expect(calls).toBe(0);
});
