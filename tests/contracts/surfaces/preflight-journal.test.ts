import { expect, it } from 'vitest';
import { preflightSweptText } from '#surfaces/core/cli-admin/index.js';
// alpha.51 PRE7FU (b), Astra 2700 P2: the start journal names the real cause per held probe: removal not proven vs. the ledger release failing.
it('a proven-removed probe whose slot release failed is journaled with that cause and its code (EN/TR), never as "not proven removed"', () => {
  const result = { removed: 0, unsettled: [], released: 1, held: [], settlementFailed: [{ probes: ['deckent-env-a'], code: 'RUN_STORE_CONFLICT' }] };
  const en = preflightSweptText(result, 'en'), tr = preflightSweptText(result, 'tr');
  expect(en).toContain('deckent-env-a'); expect(en).toContain('RUN_STORE_CONFLICT'); expect(en).toContain('proven removed, but');
  expect(en).not.toContain('still not proven removed'); expect(en).toContain('1 task slot(s)');
  expect(tr).toContain('deckent-env-a'); expect(tr).toContain('RUN_STORE_CONFLICT'); expect(tr).not.toContain('hâlâ doğrulanamayan');
});
it('negative: an unproven removal keeps its own line; both causes in one start are named separately', () => {
  const result = { removed: 0, unsettled: [], released: 0, held: ['deckent-env-b'], settlementFailed: [{ probes: ['deckent-env-c'], code: 'ATTEMPT_STORE_BUSY' }] };
  const en = preflightSweptText(result, 'en');
  expect(en).toContain('Environment probes still not proven removed: deckent-env-b.'); expect(en).not.toMatch(/still not proven removed: [^.]*deckent-env-c/);
  expect(en).toContain('deckent-env-c'); expect(en).toContain('ATTEMPT_STORE_BUSY');
  expect(preflightSweptText({ removed: 2, unsettled: [] }, 'en')).toBe('Removed 2 environment-probe container(s) left by an earlier service run (proven gone).');
});
