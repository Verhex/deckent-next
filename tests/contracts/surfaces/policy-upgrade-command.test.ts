import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';

// Owner request 2026-10-07: `deckent policy upgrade --template v5` — preview by default (writes nothing), `--apply [--expect <revision>]`, `--rollback`;
// the surface only words the engine's result (what would be added, what the person lacks) in EN/TR.
function context(result: Record<string, unknown>, calls: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'deckent-policy-upgrade-')); mkdirSync(join(root, '.deckent'));
  const out: string[] = [], errors: string[] = [];
  return { out, errors, ctx: { root, env: { HOME: root }, stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { errors.push(value); } },
    async upgradePolicyTemplate(_root: string, scopeId: string, input: unknown) { calls.push([scopeId, input]); return result; } } as never };
}
const PREVIEW = { schemaVersion: 1, status: 'preview', revision: 'first-run-template-v4+b', summary: 'policy.administer@1 · 3 changes\n+ grant first-run-mcp-servers: allow mcp-server*', missing: [], reason: null, rules: [] };

it('previews by default with the exact apply command, and applies only with --apply (and the previewed --expect)', async () => {
  const calls: unknown[] = [], { out, ctx } = context(PREVIEW, calls);
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--lang', 'en'], ctx)).toBe(0);
  expect(out.join('')).toContain('deckent policy upgrade --template current --scope scope --apply --expect first-run-template-v4+b');
  expect(out.join('')).toContain('+ grant first-run-mcp-servers');
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--apply', '--expect', 'first-run-template-v4+b'], ctx)).toBe(0);
  expect(calls).toEqual([['scope', { mode: 'preview', reason: expect.any(String) }], ['scope', { mode: 'apply', reason: expect.any(String), expect: 'first-run-template-v4+b' }]]);
});
it.each(['en', 'tr'] as const)('uses the same current handler for current and deprecated v5 selectors in %s, preserving JSON stdout', async locale => {
  const calls: unknown[] = [], { out, errors, ctx } = context(PREVIEW, calls);
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--json', '--lang', locale], ctx)).toBe(0);
  expect(errors).toEqual([]);
  const current = out.join(''); out.length = 0;
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--json', '--lang', locale], ctx)).toBe(0);
  expect(out.join('')).toBe(current); expect(JSON.parse(current)).toEqual(PREVIEW);
  expect(calls[0]).toEqual(calls[1]);
  expect(errors.join('')).toContain('deckent policy upgrade --template current --scope scope --preview');
  expect(errors.join('')).toContain(locale === 'en' ? 'deprecated' : 'kullanımdan kalkıyor');
});
it('says in words what the person lacks (TR), and refuses a wrong template or --expect without --apply', async () => {
  const { out, ctx } = context({ ...PREVIEW, missing: ['policy-administer', 'approval-decide', 'delegation'] });
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--lang', 'tr'], ctx)).toBe(0);
  expect(out.join('')).toContain('Uygulama reddedilir; eksik olan:');
  expect(out.join('')).toContain('policy.administer işlemi');
  expect(await main(['policy', 'upgrade', '--template', 'v4'], ctx)).toBe(2);
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--expect', 'x'], ctx)).toBe(2);
  expect(await main(['policy', 'upgrade', '--template', 'v5', '--scope', 'scope', '--apply', '--rollback'], ctx)).toBe(2);
});
