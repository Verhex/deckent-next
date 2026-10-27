import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import type { InstallationPoolResult } from '#engine/index.js';

const configured = { schemaVersion: 1 as const, poolId: 'customer', capacity: { executionSlots: 4, inFlightSlots: 6 } };
it('requires scope and exactly one mode; refuses unrelated installer and governance flags without calling the handler', async () => {
  let calls = 0;
  const context = { async installConfiguredExecutionPool(): Promise<InstallationPoolResult> { calls++; return { schemaVersion: 1, scopeId: 's', status: 'preview', configured }; }, stderr: { write() {} } };
  for (const args of [[], ['--scope', 's'], ['--preview'], ['--scope', 's', '--preview', '--apply'], ['--scope', '-s', '--preview'],
    ['--scope', 's', '--apply', '--upgrade'], ['--scope', 's', '--apply', '--expect', 'r'], ['--scope', 's', '--apply', '--person', 'a/b'],
    ['--scope', 's', '--apply', '--profile', 'f'], ['--scope', 's', '--apply', '--allow-shutdown']]) {
    expect(await main(['init', 'pool', ...args], context)).toBe(2);
  }
  expect(calls).toBe(0);
  expect(await main(['init', 'pool', '--scope', 's', '--preview'], { stderr: { write() {} } })).toBe(2);
});
it.each(['en', 'tr'] as const)('renders %s pool/slots/next action and emits the exact typed JSON result', async language => {
  let output = ''; const calls: unknown[][] = [];
  let result: InstallationPoolResult = { schemaVersion: 1, scopeId: 's', status: 'preview', configured };
  const context = { root: '/fixture-project', stdout: { write(text: string) { output += text; } },
    async installConfiguredExecutionPool(...args: [string, string, boolean]) { calls.push(args); return result; } };
  expect(await main(['init', 'pool', '--scope', 's', '--preview', '--lang', language], context)).toBe(0);
  expect(output).toContain('customer'); expect(output).toContain('4'); expect(output).toContain('6'); expect(output).toContain('/do');
  expect(output).toContain('deckent init pool --scope s --apply'); expect(calls).toEqual([['/fixture-project', 's', false]]);
  for (const status of ['created', 'current', 'conflict', 'unavailable'] as const) {
    result = { ...result, status }; output = '';
    expect(await main(['init', 'pool', '--scope', 's', '--apply', '--json'], context)).toBe(0);
    expect(JSON.parse(output)).toEqual(result); expect(calls.at(-1)).toEqual(['/fixture-project', 's', true]);
  }
});
it('BeUser re-walk: a fresh install without an admission pool names the missing fields and the managed first step, not the same command again', async () => {
  for (const language of ['en', 'tr'] as const) {
    let output = '';
    const context = { root: '/fixture-project', stdout: { write(text: string) { output += text; } },
      async installConfiguredExecutionPool(): Promise<InstallationPoolResult> { return { schemaVersion: 1, scopeId: 's', status: 'unavailable', reason: 'invalid-admission', configured: null }; } };
    expect(await main(['init', 'pool', '--scope', 's', '--preview', '--lang', language], context)).toBe(0);
    expect(output).toContain('admission.poolId'); expect(output).toContain('/setup'); expect(output).toContain('deckent init registry --scope s');
    expect(output.indexOf('deckent init registry')).toBeLessThan(output.indexOf('deckent init pool --scope s --preview'));
  }
});
