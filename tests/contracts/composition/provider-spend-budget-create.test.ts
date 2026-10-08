import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearConfigCache } from '#platform/index.js';
import { inspectRuntimeProviderSpendAccount, manageRuntimeProviderSpend } from '#composition/core/runtime-service/index.js';
import { scopeBudgetCreateCommand, scopeBudgetLine, scopeBudgetRevisionCommand } from '#surfaces/core/cli-models/index.js';
import { me, runtime } from '../support/chat-turn-harness.js';

// Stage 1 (owner 2026-10-08, Jev 459611ed): the scope's first budget through the governed spend command (`budget-create`), never hand-written
// JSON. Real configured runtime service and ledger; the scripted local server stands in for the provider. The profile carries a non-zero v2
// operator tariff (loopback), so the turn reserves a real maximum and settles the measured charge (`measured-tariff`), not a zero tariff.
const ask = (turnId: string) => ({ schemaVersion: 1 as const, scopeId: 'scope', turnId, messages: [{ role: 'user' as const, content: 'hi' }] });
const spendGrant = { id: 'spend', effect: 'allow', actions: ['inspect', 'audit', 'reconcile', 'budget-revision'], scopes: ['scope'], principals: me,
  resource: { kind: 'provider-spend-account', ids: 'all' } };
type Config = Record<string, unknown> & { provider_invocation_profiles: { profiles: { adapter: { definition: Record<string, unknown> } }[] } };
/** The harness without its configured budget, and with a priced (v2 operator) tariff on its loopback profile. */
async function unbudgeted(grants: Record<string, unknown>[]) {
  const f = await runtime({ extraGrants: grants });
  const path = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(path, 'utf8')) as Config;
  delete config['provider_spending'];
  config.provider_invocation_profiles.profiles[0]!.adapter.definition['tariff'] = { kind: 'operator-static', version: 2, currency: 'USD',
    inputMinorUnitsPerMillionTokens: 200, cachedInputMinorUnitsPerMillionTokens: 50, outputMinorUnitsPerMillionTokens: 1000 };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 }); clearConfigCache();
  return { ...f, options: { env: f.env } };
}
const account = (f: Awaited<ReturnType<typeof unbudgeted>>) => f.rows('SELECT record FROM provider_spend_accounts WHERE scope_id=\'scope\'')
  .map(row => JSON.parse(String(row['record'])) as { budget: { budgetId: string; revision: number; limitMinorUnits: number }; reservedMinorUnits: number; settledExactMinorUnits: string });

describe.skipIf(process.platform !== 'linux')('governed first budget (budget-create)', () => {
  it('no budget locks the turn; create unlocks it; the turn reserves and settles under the budget; a second create is refused', async () => {
    const f = await unbudgeted([spendGrant]); await f.start();
    const locked = await f.client().chatTurn(ask('t-locked'), () => undefined);
    expect(locked).toMatchObject({ finish: 'error', answer: null }); expect(locked.note).toContain('PROVIDER_SPEND_UNAVAILABLE');
    expect(f.state.requests).toEqual([]); expect(account(f)).toEqual([]);
    const current = await inspectRuntimeProviderSpendAccount(f.project, { schemaVersion: 1, scopeId: 'scope', current: true }, f.options);
    expect(current).toMatchObject({ budgetId: 'scope-budget', budgetRevision: 1, checkpoint: null });
    const created = await manageRuntimeProviderSpend(f.project, scopeBudgetCreateCommand('scope', 25, 'cli', 'create-1'), f.options);
    expect(created.receipt).toMatchObject({ before: null, after: { budget: { budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: 2500 },
      reservedMinorUnits: 0, budgetRevisionCommandId: 'create-1' } });
    expect(scopeBudgetLine(created, 'en')).toBe('Budget created for scope scope: 25 USD (revision 1).');
    // The same command id replays (no second account); a new create is refused with the revision as the next step.
    expect((await manageRuntimeProviderSpend(f.project, scopeBudgetCreateCommand('scope', 25, 'cli', 'create-1'), f.options)).replayed).toBe(true);
    await expect(manageRuntimeProviderSpend(f.project, scopeBudgetCreateCommand('scope', 50, 'cli', 'create-2'), f.options))
      .rejects.toMatchObject({ code: 'PROVIDER_SPEND_BUDGET_EXISTS' });
    // The ledger account unlocks the scope: the turn answers, reserves its maximum and settles the measured charge (20 in x $2 + 8 out x $10 per MTok).
    expect(await f.client().chatTurn(ask('t-open'), () => undefined)).toMatchObject({ answer: expect.any(String) });
    expect(account(f)).toEqual([expect.objectContaining({ budget: expect.objectContaining({ budgetId: 'scope-budget', limitMinorUnits: 2500 }), reservedMinorUnits: 0,
      settledExactMinorUnits: '0.012' })]);
    const reservation = f.rows('SELECT record FROM model_invocation_spend_reservations').map(row => JSON.parse(String(row['record'])) as { disposition: { state: string };
      descriptor: { budgetId: string; quote: { maxChargeMinorUnits: number } } });
    expect(reservation).toHaveLength(1);
    expect(reservation[0]).toMatchObject({ disposition: { state: 'settled-measured-tariff' }, descriptor: { budgetId: 'scope-budget' } });
    expect(reservation[0]!.descriptor.quote.maxChargeMinorUnits).toBeGreaterThan(0);
  }, 60_000);

  it('the created budget is raised and lowered by governed revisions on the current account; the next turn uses the new revision', async () => {
    const f = await unbudgeted([spendGrant]); await f.start();
    await manageRuntimeProviderSpend(f.project, scopeBudgetCreateCommand('scope', 10, 'terminal'), f.options);
    const current = () => inspectRuntimeProviderSpendAccount(f.project, { schemaVersion: 1, scopeId: 'scope', current: true }, f.options);
    const raised = await manageRuntimeProviderSpend(f.project, scopeBudgetRevisionCommand(await current(), 100, false, 'cli'), f.options);
    expect(raised.receipt.after.budget).toMatchObject({ revision: 2, limitMinorUnits: 10_000 });
    const lowered = await manageRuntimeProviderSpend(f.project, scopeBudgetRevisionCommand(await current(), 5, false, 'terminal'), f.options);
    expect(lowered.receipt.after.budget).toMatchObject({ revision: 3, limitMinorUnits: 500 });
    expect(scopeBudgetLine(lowered, 'tr')).toBe('scope kapsamının bütçesi değişti: 5 USD (revizyon 3).');
    expect(await current()).toMatchObject({ budgetRevision: 3, checkpoint: { account: { budget: { limitMinorUnits: 500 } } } });
    expect(await f.client().chatTurn(ask('t-rev'), () => undefined)).toMatchObject({ answer: expect.any(String) });
    const reservation = f.rows('SELECT record FROM model_invocation_spend_reservations').map(row => JSON.parse(String(row['record'])) as { descriptor: { budgetRevision: number } });
    expect(reservation.map(item => item.descriptor.budgetRevision)).toEqual([3]);
  }, 60_000);

  it('without the provider-spend-account rule the create is refused by policy and nothing is written; a configured budget refuses a second one (negative)', async () => {
    const denied = await unbudgeted([]); await denied.start();
    await expect(manageRuntimeProviderSpend(denied.project, scopeBudgetCreateCommand('scope', 25, 'cli'), denied.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(account(denied)).toEqual([]);
    expect(denied.rows('SELECT command_id FROM provider_spend_management')).toEqual([]);
    // The harness's own configured budget: its account opens at the first call, so a governed create beside it is refused.
    const configured = await runtime({ extraGrants: [spendGrant] }); await configured.start();
    await expect(manageRuntimeProviderSpend(configured.project, scopeBudgetCreateCommand('scope', 25, 'cli'), { env: configured.env }))
      .rejects.toMatchObject({ code: 'PROVIDER_SPEND_BUDGET_EXISTS' });
  }, 60_000);
});
