import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { protocolPanelPort } from '#surfaces/core/cli-terminal/index.js';
import { planConfiguredProfileProtocol } from '#composition/core/model-connect/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { applyPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { providerConnectKind } from '#adapters/core/provider-connect/index.js';
import { lookupOpenAiCompatibleTariff } from '#adapters/core/provider-openai-chat/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openLocalIntegrityAuthority } from '#adapters/index.js';
import { clearConfigCache, getConfigFieldDefault, prepareProductFile, productResourcePath, resolveProductLayout } from '#platform/index.js';
import { RESPONSES_MODEL, responsesFixture } from '../support/openai-responses.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-openai-protocol-')); roots.push(root);
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home') } };
  await applyPolicyTemplateInstallation(root, 'installation');
  const layout = resolveProductLayout({ projectRoot: root }), path = join(root, '.deckent/config.json');
  const ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, getConfigFieldDefault('storage').sqlite).close();
  await openLocalIntegrityAuthority(layout, getConfigFieldDefault('approvals').keyFile, true);
  const principal = await resolveConfiguredConfigPrincipal(root, 'installation', options), app = createConfiguredConfigApplication(root, options);
  const command = { principal, scopeId: 'installation', layer: 'project' as const };
  const endpoint = 'https://api.openai.com/v1/chat/completions', f = responsesFixture(endpoint);
  const profile = { ...f.profile, scopeId: 'installation', version: 3, adapter: { ...f.profile.adapter, version: 5, definition: {
    ...f.profile.adapter.definition, dialect: providerConnectKind('openai-api')!.connect!.dialect,
    tariff: lookupOpenAiCompatibleTariff(endpoint, RESPONSES_MODEL)!, authentication: { type: 'bearer', credentialRef: 'DECKENT_OPENAI_KEY' } } } };
  const foreign = { ...profile, scopeId: 'foreign', id: 'foreign' };
  await app.set({ ...command, commandId: 'seed-scope', keyPath: 'terminal.scopeId', value: 'installation' });
  await app.set({ ...command, commandId: 'seed-profiles', keyPath: 'provider_invocation_profiles', value: { schemaVersion: 1, profiles: [profile, foreign] } });
  const port = protocolPanelPort(root, 'installation', { planProfileProtocol: planConfiguredProfileProtocol,
    configApplication: createConfiguredConfigApplication, resolveConfigPrincipal: resolveConfiguredConfigPrincipal }, options, 'tr');
  const audits = () => { const db = new DatabaseSync(ledger, { readOnly: true }); try {
    return db.prepare('SELECT record FROM audit_events ORDER BY rowid').all().map(row => JSON.parse(String(row['record'])) as { event: { subject: Record<string, unknown> } });
  } finally { db.close(); } };
  return { root, options, path, profile, foreign, port, app, command, audits, policyPath: productResourcePath(layout, 'policy'), principal };
}
it('the /model protocol preview applies through the real governed writer once, audited, keeping key/binding/allocation and the other scope', async () => {
  const f = await setup(), before = await readFile(f.path, 'utf8'), auditCount = f.audits().length;
  const view = await f.port.inspect();
  expect(view?.lines.map(line => line.text).join('\n')).toContain('/v1/responses');
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect((await f.port.apply()).status).toBe('applied');
  const profiles = JSON.parse(await readFile(f.path, 'utf8')).provider_invocation_profiles.profiles as typeof f.profile[];
  expect(profiles[0]).toMatchObject({ version: 4, bindingDigest: f.profile.bindingDigest, allocation: f.profile.allocation,
    adapter: { version: 6, definition: { endpoint: 'https://api.openai.com/v1/responses', authentication: f.profile.adapter.definition.authentication } } });
  expect(profiles[1]).toEqual(f.foreign); expect(f.audits()).toHaveLength(auditCount + 1);
  expect(f.audits().at(-1)?.event.subject).toMatchObject({ kind: 'config-change', keyPath: 'provider_invocation_profiles', layer: 'project' });
  expect(await f.port.inspect()).toBeNull();
});
it('policy approval holds the same migration command and writes nothing before a decision', async () => {
  const f = await setup(), policy = JSON.parse(await readFile(f.policyPath, 'utf8')) as { grants: Record<string, unknown>[] };
  policy.grants.push({ id: 'company-protocol-approval', effect: 'require-approval', actions: ['write'], scopes: ['installation'],
    principals: [{ issuer: f.principal.issuer, subject: f.principal.subject }], resource: { kind: 'config', ids: ['project:provider_invocation_profiles'] } });
  await writeFile(f.policyPath, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
  await f.port.inspect(); const before = await readFile(f.path, 'utf8'), auditCount = f.audits().length;
  const pending = await f.port.apply(); expect(pending.status).toBe('approval-pending'); expect(pending.approvalId).toBeTruthy();
  expect(await readFile(f.path, 'utf8')).toBe(before); expect(f.audits()).toHaveLength(auditCount);
  expect((await f.port.apply()).approvalId).toBe(pending.approvalId);
});
it('no preview or a changed snapshot refuses the migration before writing', async () => {
  const f = await setup(), before = await readFile(f.path, 'utf8');
  await expect(f.port.apply()).rejects.toThrow('Önizlemeden sonra'); expect(await readFile(f.path, 'utf8')).toBe(before);
  await f.port.inspect();
  await f.app.set({ ...f.command, commandId: 'concurrent', keyPath: 'language', value: 'en' });
  const concurrent = await readFile(f.path, 'utf8'), auditCount = f.audits().length;
  await expect(f.port.apply()).rejects.toThrow('Önizlemeden sonra');
  expect(await readFile(f.path, 'utf8')).toBe(concurrent); expect(f.audits()).toHaveLength(auditCount);
});
