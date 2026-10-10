import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { resolveProductPaths } from '#platform/index.js';
const layout = resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } });
const run = { runId: 'r', revision: 1, cancellationRequested: false, state: { kind: 'running' }, tasks: [], criteria: [] }; // RunView v3 (A1) always carries the Run state
function harness(value: unknown) {
  const out: string[] = []; const err: string[] = [];
  const context = { env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(v: string) { out.push(v); } }, stderr: { write(v: string) { err.push(v); } },
    async inspectRun() { return { schemaVersion: 1 as const, layout, run: value }; } };
  return { out, err, context: context as never };
}
it.each([['en', 'No recorded Run found: nope.'], ['tr', 'Kayıtlı Run bulunamadı: nope.']])('fails with RUN_NOT_FOUND for a missing Run (%s)', async (lang, message) => {
  const h = harness(null);
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'nope', '--lang', lang], h.context)).toBe(1);
  expect(h.out.join('')).toBe(''); expect(h.err.join('')).toContain(message);
  const j = harness(null);
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'nope', '--lang', lang, '--json'], j.context)).toBe(1);
  expect(j.out.join('')).toBe(''); expect(j.err.join('')).toContain('RUN_NOT_FOUND'); expect(j.err.join('')).toContain(message);
});
it('still prints an existing Run with exit 0', async () => {
  const h = harness(run);
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', 'en'], h.context)).toBe(0);
  expect(h.out.join('')).toContain('recorded revision'); expect(h.err.join('')).toBe('');
});


it.each(['en', 'tr'] as const)('shows the durable progression failure code and deadline on run inspect in %s', async locale => {
  const state = { kind: 'parked', reason: 'progression-failed', failureCode: 'SUPERVISOR_OPTIONS_INVALID', since: 10, deadline: 1010 };
  const out: string[] = [];
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], {
    env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(text: string) { out.push(text); } }, stderr: { write() {} },
    async inspectRun() { return { schemaVersion: 1, layout, run: { ...run, state } }; },
  } as never)).toBe(0);
  expect(out.join('')).toContain('SUPERVISOR_OPTIONS_INVALID'); expect(out.join('')).toContain('progression-failed');
  expect(out.join('')).toContain(locale === 'en' ? 'explicitly resume' : 'açıkça devam');
});
