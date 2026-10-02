import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { resolveProductPaths, ErrorRegistry } from '#platform/index.js';

function host(state: 'clean' | 'incomplete' = 'clean') {
  let stops = 0;
  return { value: { endpoint: '/runtime.sock', layout: resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } }), done: Promise.resolve(),
    async stop() { stops++; return { state, remainingRequests: state === 'clean' ? 0 : 1, recoveryPending: false } as const; } }, stops: () => stops };
}
it('starts only through the explicit runtime host, renders ready/stopped JSON, and stops on the injected signal', async () => {
  const controller = new AbortController(); controller.abort(); const service = host(); const output: string[] = []; let starts = 0;
  const code = await main(['runtime', 'serve', '--json', '--no-color', '--lang', 'en'], { root: '/fixture/project', env: { HOME: '/fixture/home' }, signal: controller.signal,
    stdout: { write(value: string) { output.push(value); } }, async startRuntimeService(_root, observer) { starts++; await observer.onPage({ schemaVersion: 1, scopeId: 's', limit: 1, afterAttemptId: null }, { nextAfterAttemptId: null }); return service.value; } });
  expect(code).toBe(0); expect(starts).toBe(1); expect(service.stops()).toBe(1);
  expect(output.map(value => JSON.parse(value).event)).toEqual(['ready', 'stopped']);
});
it('returns a nonzero typed shutdown result without waiting for a host that still owns work', async () => {
  const controller = new AbortController(); controller.abort(); const service = host('incomplete');
  const code = await main(['runtime', 'serve', '--json'], { root: '/fixture/project', env: { HOME: '/fixture/home' }, signal: controller.signal,
    stderr: { write() {} }, async startRuntimeService() { return { ...service.value, done: new Promise<void>(() => {}) }; } });
  expect(code).not.toBe(0); expect(service.stops()).toBe(1);
});

it('stops an already-started host when ready output fails and surfaces an unexpected host completion', async () => {
  const controller = new AbortController(); const service = host();
  const readyFailure = await main(['runtime', 'serve'], { root: '/fixture/project', env: { HOME: '/fixture/home' }, signal: controller.signal,
    stdout: { write() { throw new Error('output-failed'); } }, stderr: { write() {} }, async startRuntimeService() { return service.value; } });
  expect(readyFailure).not.toBe(0); expect(service.stops()).toBe(1);
  const completed = host();
  const doneFailure = await main(['runtime', 'serve'], { root: '/fixture/project', env: { HOME: '/fixture/home' }, signal: new AbortController().signal,
    stderr: { write() {} }, async startRuntimeService() { return { ...completed.value, done: Promise.reject(new Error('host-failed')) }; } });
  expect(doneFailure).not.toBe(0); expect(completed.stops()).toBe(0);
});

it.each([[true, 'en'], [false, 'en'], [false, 'tr']] as const)('logs a typed lifecycle refusal for its exact Run (json=%s, locale=%s)', async (json, locale) => {
  const controller = new AbortController(); controller.abort(); const service = host(), errors: string[] = [];
  const query = { scopeId: 's', runId: 'due-without-cancel' };
  const code = await main(['runtime', 'serve', ...(json ? ['--json'] : []), '--lang', locale], {
    root: '/fixture/project', env: { HOME: '/fixture/home' }, signal: controller.signal,
    stdout: { write() {} }, stderr: { write(value: string) { errors.push(value); } },
    async startRuntimeService(_root, observer) {
      await observer.onRunProgressionError?.(query, ErrorRegistry.createError('POLICY_DENIED'));
      return service.value;
    },
  });
  expect(code).toBe(0); expect(service.stops()).toBe(1);
  if (json) expect(JSON.parse(errors.join(''))).toMatchObject({ event: 'run-progression-failed', query, code: 'POLICY_DENIED' });
  else { expect(errors.join('')).toContain(query.runId); expect(errors.join('')).toContain('POLICY_DENIED'); }
});
