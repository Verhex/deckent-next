import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { resolveProductPaths } from '#platform/index.js';

const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'layout' };
const identityArgs = ['--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a', '--generation', '1', '--layout-revision', 'layout'];
const layout = resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } });

it('executes only the exact reserved identity and never presents process exit as acceptance', async () => {
  let received: unknown, text = '';
  const response = { schemaVersion: 1 as const, layout, execution: { identity, status: 'terminal' as const, terminal: { exitCode: 0, signal: null }, outputRecorded: true } };
  const context = { env: { NO_COLOR: '1' }, stdout: { write(value: string) { text += value; } },
    async executeTask(_root: string, value: unknown) { received = value; return response; } };
  expect(await main(['task', 'execute', ...identityArgs], context)).toBe(0); expect(received).toEqual(identity);
  expect(text).toContain('exitCode=0'); expect(text).toContain('signal=none'); expect(text).toMatch(/not task acceptance/i);
  text = ''; expect(await main(['task', 'execute', ...identityArgs, '--json'], context)).toBe(0); expect(JSON.parse(text)).toEqual(response);
});

it.each([
  ['prevented', null, 'Execution was prevented before launch permission was granted.'],
  ['unresolved', null, 'the outcome is unknown'],
] as const)('renders %s without inventing terminal evidence', async (status, terminal, phrase) => {
  let text = '';
  const context = { stdout: { write(value: string) { text += value; } },
    async executeTask() { return { schemaVersion: 1 as const, layout, execution: { identity, status, terminal, outputRecorded: false } }; } };
  expect(await main(['task', 'execute', ...identityArgs], context)).toBe(0); expect(text).toContain(phrase); expect(text).toMatch(/not task acceptance/i);
});

it('evaluates with a strict command and emits the composition response unchanged as JSON', async () => {
  let received: unknown, text = '';
  const response = { schemaVersion: 1 as const, layout, evaluation: { schemaVersion: 1 as const, commandId: 'evaluate',
    run: { revision: 4, tasks: [{ id: 't', phase: 'accepted' }] } as never } };
  const context = { stdout: { write(value: string) { text += value; } }, async evaluateTask(_root: string, value: unknown) { received = value; return response; } };
  const args = ['task', 'evaluate', ...identityArgs, '--command-id', 'evaluate', '--expected-revision', '3'];
  expect(await main([...args, '--json'], context)).toBe(0);
  expect(received).toEqual({ schemaVersion: 1, commandId: 'evaluate', identity, expectedRevision: 3 }); expect(JSON.parse(text)).toEqual(response);
});

it.each([
  ['task', 'execute', ...identityArgs, '--argv', 'unsafe'],
  ['task', 'execute', ...identityArgs, '--generation', '2'],
  ['task', 'evaluate', ...identityArgs, '--command-id', 'evaluate', '--expected-revision', '0', '--verdict', 'pass'],
  ['task', 'evaluate', ...identityArgs, '--command-id', 'evaluate', '--expected-revision', '-1'],
])('rejects private execution fields, duplicates, caller verdicts and invalid counters: %j', async args => {
  let calls = 0; const stderr = { write() {} };
  expect(await main(args, { stderr, async executeTask() { calls++; throw new Error(); }, async evaluateTask() { calls++; throw new Error(); } })).toBe(2);
  expect(calls).toBe(0);
});
