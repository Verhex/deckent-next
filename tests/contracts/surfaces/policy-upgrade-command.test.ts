import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { homeEnv } from '../support/host-platform.js';

// Owner request 2026-10-07: `deckent policy upgrade --template v5` — preview by default (writes nothing), `--apply [--expect <revision>]`, `--rollback`;
// the surface only words the engine's result (what would be added, what the person lacks) in EN/TR.
function context(result: Record<string, unknown>, calls: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'deckent-policy-upgrade-')); mkdirSync(join(root, '.deckent'));
  const out: string[] = [], errors: string[] = [];
  return { out, errors, ctx: { root, env: homeEnv(root), stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { errors.push(value); } },
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

// J3 (MON-NAMES item 3): a fresh first-run install has no upgrade to roll back; missing archive history is a refusal — neither is "not a first-run policy".
it.each([
  ['en', "Nothing to roll back: this policy is the first-run template's own version", 'Rollback refused: the earlier versions of this policy are not in the authority archive'],
  ['tr', 'Geri alınacak bir şey yok: bu policy ilk kurulum şablonunun kendi sürümü', 'Geri alma reddedildi: bu policy\'nin önceki sürümleri yetki arşivinde yok'],
] as const)('words a fresh-install rollback and a rollback without archived history with the next step (%s)', async (locale, fresh, refused) => {
  const installed = context({ ...PREVIEW, status: 'nothing-to-roll-back', revision: 'first-run-template-v13+first-run-template-v13-bindings', summary: null, reason: 'no-upgrade-recorded', conflicts: [] });
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--rollback', '--lang', locale], installed.ctx)).toBe(0);
  expect(installed.out.join('')).toContain(fresh); expect(installed.out.join('')).toContain('deckent policy status --scope scope');
  const missing = context({ ...PREVIEW, status: 'unavailable', revision: 'a-x+b', summary: null, reason: 'history-unavailable', conflicts: [] });
  expect(await main(['policy', 'upgrade', '--template', 'current', '--scope', 'scope', '--rollback', '--lang', locale], missing.ctx)).toBe(0);
  expect(missing.out.join('')).toContain(refused); expect(missing.out.join('')).toContain('deckent policy status --scope scope');
  for (const out of [installed.out, missing.out]) expect(out.join('')).not.toMatch(/not a first-run policy|ilk kurulum policy'si değil/u);
});
