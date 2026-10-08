import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../fixtures/cli-input.js';
import type { ProviderSpendManagementCommand } from '#domain/index.js';
import { createGovernedProviderSpendAccount, createProviderSpendAccount, createProviderSpendCheckpoint, providerSpendEvidenceDigest,
  type ProviderSpendAccountInspection, type ProviderSpendManagementResult } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';

// Stage 1 (owner 2026-10-08): `deckent models create-budget|revise-budget --scope --usd` build the governed spend command themselves (no JSON).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-budget-cli-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ cli: { invocationInputMaxBytes: 1024 } }));
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
const actor = { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'os-user' as const };
/** A result as the governed store records it (the receipt's after state follows the command). */
function recorded(command: ProviderSpendManagementCommand, before: ProviderSpendAccountInspection['checkpoint']): ProviderSpendManagementResult {
  const after = command.kind === 'budget-create' ? createGovernedProviderSpendAccount(command) : command.kind === 'budget-revision'
    ? { ...before!.account, budget: command.budget, budgetRevisionDigest: providerSpendEvidenceDigest(command), budgetRevisionCommandId: command.commandId } : before!.account;
  const body = { schemaVersion: 1 as const, command, actor, authorization: { revision: 'p', ruleId: 'spend' }, recordedAtMs: 1, before, after };
  return { replayed: false, receipt: { ...body, digest: providerSpendEvidenceDigest(body) } as never };
}
function current(limitMinorUnits = 2500): ProviderSpendAccountInspection {
  const checkpoint = createProviderSpendCheckpoint(createProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits }), 3, 0);
  return { schemaVersion: 2, scopeId: 'scope', budgetId: 'scope-budget', budgetRevision: 1, checkpoint, audit: null, spendingHistoryIntegrity: 'not-recorded' };
}

it('create-budget builds budget-create (revision 1, whole dollars as cents, USD) and prints one line; revise-budget reads the current account', async () => {
  const f = await fixture(), sent: ProviderSpendManagementCommand[] = [];
  let output = '';
  const context = { ...f, stdout: { write(value: string) { output += value; } },
    manageProviderSpend: async (_root: string, command: ProviderSpendManagementCommand) => { sent.push(command); return recorded(command, command.kind === 'budget-create' ? null : current().checkpoint); },
    inspectProviderSpendAccount: async (_root: string, query: unknown) => { expect(query).toEqual({ schemaVersion: 1, scopeId: 'scope', current: true }); return current(); } };
  expect(await main(['models', 'create-budget', '--scope', 'scope', '--usd', '25', '--command-id', 'c-1'], context)).toBe(0);
  expect(sent[0]).toMatchObject({ kind: 'budget-create', scopeId: 'scope', commandId: 'c-1', budgetId: 'scope-budget', budgetRevision: 1,
    budget: { scopeId: 'scope', budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: 2500 } });
  expect(output).toBe('Budget created for scope scope: 25 USD (revision 1).\n');
  output = '';
  expect(await main(['models', 'revise-budget', '--scope', 'scope', '--usd', '50', '--unfreeze', '--lang', 'tr'], context)).toBe(0);
  expect(sent[1]).toMatchObject({ kind: 'budget-revision', budgetId: 'scope-budget', budgetRevision: 1, expectedCheckpointDigest: current().checkpoint!.digest,
    budget: { revision: 2, limitMinorUnits: 5000 }, unfreeze: true });
  expect(output).toBe('scope kapsamının bütçesi değişti: 50 USD (revizyon 2). Aşım dondurması kaldırıldı.\n');
});

it('refuses typed amounts outside whole dollars 1..1000, mixed forms and a revision without a budget (negative)', async () => {
  const f = await fixture(), sent: unknown[] = [];
  const context = { ...f, stdout: { write() {} }, stderr: { write() {} }, manageProviderSpend: async (_root: string, command: unknown) => { sent.push(command); throw new Error('unreached'); },
    inspectProviderSpendAccount: async () => ({ ...current(), checkpoint: null }) };
  for (const argv of [['--usd', '0'], ['--usd', '2.5'], ['--usd', '1001'], ['--usd', '-5'], ['--usd', 'ten'], [], ['--usd', '5', '--unfreeze'], ['--usd', '5', '--input', '-']]) {
    expect(await main(['models', 'create-budget', '--scope', 'scope', ...argv], context)).not.toBe(0);
  }
  expect(await main(['models', 'revise-budget', '--usd', '5'], context)).not.toBe(0);
  let errors = '';
  expect(await main(['models', 'revise-budget', '--scope', 'scope', '--usd', '5'], { ...context, stderr: { write(value: string) { errors += value; } } })).not.toBe(0);
  expect(errors).toContain('deckent models create-budget --scope scope --usd <amount>');
  expect(sent).toEqual([]);
});
