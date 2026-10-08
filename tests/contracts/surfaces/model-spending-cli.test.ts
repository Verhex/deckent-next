import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { main } from '../../fixtures/cli-input.js';
import { createProviderSpendAccount, createProviderSpendAuditReceipt, createProviderSpendCheckpoint, type ProviderSpendAccountInspection, type ProviderSpendAuditResult } from '#engine/index.js';
import { clearConfigCache } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const query = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-spending-cli-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); await mkdir(join(root, '.deckent'));
  await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ cli: { invocationInputMaxBytes: 1024 } }));
  return { root, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '/usr/bin:/bin' } };
}
function inspection(): ProviderSpendAccountInspection {
  const account = createProviderSpendAccount({ schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100 });
  const checkpoint = createProviderSpendCheckpoint({ ...account, reservedMinorUnits: 10, settledExactMinorUnits: '0.02', settledMinorUnits: 1 }, 2, 1);
  return { ...query, schemaVersion: 2, checkpoint, audit: null, spendingHistoryIntegrity: 'not-recorded' };
}
function auditResult(): ProviderSpendAuditResult {
  const checkpoint = inspection().checkpoint!;
  const command = { schemaVersion: 1 as const, commandId: 'audit', ...query, expectedCheckpointDigest: checkpoint.digest };
  return { schemaVersion: 1, replayed: false, receipt: createProviderSpendAuditReceipt({ command,
    principal: { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'os-user', scopeIds: ['scope'] },
    authorization: { revision: 'policy', ruleId: 'audit' }, examinedCheckpoint: checkpoint, startedAtMs: 1, completedAtMs: 2 }) };
}

it('routes strict account input and truthfully renders held reservations and exact settlement in both locales', async () => {
  const f = await fixture(), path = join(f.root, 'account.json'); await writeFile(path, JSON.stringify(query));
  for (const [language, expected, heldAbsent, sourceAbsent] of [
    ['en', 'including held reservations', 'Hold reasons are not shown', 'source subtotals are not included'],
    ['tr', 'bekletilen rezervasyonlar da dahildir', 'bekletme nedenlerini göstermez', 'kaynak alt toplamları dahil değildir'],
  ] as const) {
    let output = '';
    expect(await main(['models', 'spending', '--input', path, '--lang', language], { ...f,
      stdout: { write(value) { output += value; } }, inspectProviderSpendAccount: async (_root, input) => {
        expect(input).toEqual(query); return inspection(); }, })).toBe(0);
    expect(output).toContain(expected); expect(output).toContain(language === 'en' ? 'Settled exact total: 0.02' : 'Kesinleşmiş tam toplam: 0.02');
    expect(output).toContain(language === 'en' ? 'rounded projection: 1' : 'yuvarlanmış gösterim: 1');
    expect(output).toContain(language === 'en' ? 'provider invoice' : 'sağlayıcı faturası değildir');
    expect(output).toContain(language === 'en' ? 'No persisted full-history audit result' : 'kalıcı tam geçmiş denetim sonucu kaydedilmemiştir');
    expect(output).toContain(heldAbsent); expect(output).toContain(sourceAbsent);
  }
});

it('rejects extended input and explains that a missing account is not zero', async () => {
  const f = await fixture(), bad = join(f.root, 'bad.json'), absent = join(f.root, 'absent.json');
  await Promise.all([writeFile(bad, JSON.stringify({ ...query, forged: true })), writeFile(absent, JSON.stringify(query))]);
  let calls = 0;
  expect(await main(['models', 'spending', '--input', bad], { ...f, inspectProviderSpendAccount: async () => { calls++; return inspection(); } })).toBe(2);
  let output = '';
  expect(await main(['models', 'spending', '--input', absent], { ...f, stdout: { write(value) { output += value; } },
    inspectProviderSpendAccount: async (_root, input) => ({ ...input, schemaVersion: 2, checkpoint: null, audit: null, spendingHistoryIntegrity: 'not-recorded' }) })).toBe(0);
  expect(calls).toBe(0); expect(output).toContain('Scope scope, budget budget revision 1'); expect(output).toContain('does not mean zero spend');
});

it('advertises the spending route from models help', async () => {
  let output = '';
  expect(await main(['models', '--help'], { stdout: { write(value) { output += value; } } })).toBe(0);
  expect(output).toContain('invoke|invocation|purge-content|spending|audit-spending');
});

it('routes a strict audit command and presents its durable receipt without a billing or correction claim', async () => {
  const f = await fixture(), result = auditResult(), path = join(f.root, 'audit.json'); await writeFile(path, JSON.stringify(result.receipt.command));
  for (const [language, expected] of [['en', 'spending audit audit recorded for checkpoint 2'], ['tr', 'harcama denetimi audit, kontrol noktası 2 için kaydedildi']] as const) {
    let output = '';
    expect(await main(['models', 'audit-spending', '--input', path, '--lang', language], { ...f, stdout: { write(value) { output += value; } },
      auditProviderSpendAccount: async (_root, command) => { expect(command).toEqual(result.receipt.command); return result; } })).toBe(0);
    expect(output).toContain(expected); expect(output).toContain(language === 'en' ? 'does not correct financial records' : 'Mali kayıtları düzeltmez');
    expect(output).toContain(language === 'en' ? 'provider invoice' : 'sağlayıcı faturasını');
  }
});

it('routes reconcile and budget revision as strict commands, including JSON evidence and Turkish receipt text', async () => {
  const f = await fixture(), current = inspection().checkpoint!;
  const common = { schemaVersion: 1, scopeId: 'scope', budgetId: 'budget', budgetRevision: 1, commandId: 'manage', expectedCheckpointDigest: current.digest };
  const commands = [
    { ...common, kind: 'reconcile', invocationId: 'invocation', resolution: 'write-off', exactMinorUnits: '0', evidence: { kind: 'write-off', digest: 'a'.repeat(64) } },
    { ...common, kind: 'budget-revision', budget: { ...current.account.budget, revision: 2, limitMinorUnits: 200 }, unfreeze: true, evidenceDigest: 'b'.repeat(64) },
  ];
  for (const [index, command] of commands.entries()) {
    const action = index === 0 ? 'reconcile-spending' : 'revise-budget', path = join(f.root, `${action}.json`); await writeFile(path, JSON.stringify(command));
    let output = '', calls = 0;
    const context = { ...f, stdout: { write(value: string) { output += value; } }, manageProviderSpend: async (_root: string, received: unknown) => {
      calls++; expect(received).toEqual(command);
      return { replayed: false, receipt: { command: received } } as import('#engine/index.js').ProviderSpendManagementResult;
    } };
    expect(await main(['models', action, '--input', path, '--json'], context)).toBe(0);
    expect(JSON.parse(output).receipt.command).toEqual(command);
    output = '';
    expect(await main(['models', action, '--input', path, '--lang', 'tr'], context)).toBe(0);
    expect(output).toContain('manage'); expect(calls).toBe(2);
    expect(await main(['models', index === 0 ? 'revise-budget' : 'reconcile-spending', '--input', path], context)).toBe(2);
    await writeFile(path, JSON.stringify({ ...command, actor: 'forged' }));
    expect(await main(['models', action, '--input', path], context)).toBe(2); expect(calls).toBe(2);
  }
});
