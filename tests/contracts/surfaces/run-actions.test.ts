import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { resolveProductPaths } from '#platform/index.js';

const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'generated-a', generation: 1, layoutRevision: 'layout' };
const response = { schemaVersion: 1 as const, layout: resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } }),
  reservation: { schemaVersion: 1 as const, commandId: 'reserve', identities: [identity], run: {} as never } };
const args = ['run', 'reserve', '--scope', 's', '--id', 'r', '--command-id', 'reserve', '--expected-revision', '0'];

it('forwards the strict reservation command and prints every complete generated identity', async () => {
  let received: unknown, text = '';
  const context = { env: { NO_COLOR: '1' }, stdout: { write(value: string) { text += value; } },
    async reserveRunTasks(_root: string, command: unknown) { received = command; return response; } };
  expect(await main(args, context)).toBe(0);
  expect(received).toEqual({ schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r', expectedRevision: 0 });
  for (const value of Object.values(identity)) expect(text).toContain(String(value));
  text = ''; expect(await main([...args, '--json'], context)).toBe(0); expect(JSON.parse(text)).toEqual(response);
});

it('quotes shell-sensitive generated identity values in human output without executing them', async () => {
  const special = { scopeId: 'scope;echo-nope', runId: 'run name', taskId: 'task$HOME', attemptId: "attempt'quoted", generation: 1, layoutRevision: 'layout|rev' };
  let text = '', calls = 0;
  const context = { env: { NO_COLOR: '1' }, stdout: { write(value: string) { text += value; } },
    async reserveRunTasks() { calls++; return { ...response, reservation: { ...response.reservation, identities: [special] } }; } };
  expect(await main(args, context)).toBe(0); expect(calls).toBe(1);
  expect(text).toContain("'scope;echo-nope'"); expect(text).toContain("'run name'"); expect(text).toContain("'task$HOME'");
  expect(text).toContain("'attempt'\\''quoted'"); expect(text).toContain("'layout|rev'");
});

it.each([
  [...args, '--task', 't'], [...args, '--attempt', 'caller'], [...args, '--expected-revision', '1'],
  ['run', 'reserve', '--scope', 's', '--id', 'r', '--command-id', 'reserve', '--expected-revision', '-1'],
])('rejects caller selection, duplicate and invalid reservation arguments: %j', async invalid => {
  let calls = 0; const stderr = { write() {} };
  expect(await main(invalid, { stderr, async reserveRunTasks() { calls++; return response; } })).toBe(2); expect(calls).toBe(0);
});
