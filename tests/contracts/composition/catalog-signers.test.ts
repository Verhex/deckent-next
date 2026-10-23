import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { addConfiguredSigner, enrolConfiguredSigner, importConfiguredSkill, inspectConfiguredSkill, listConfiguredSigners, replayConfiguredSignerRevocations,
  revokeConfiguredSigner } from '#composition/core/agent-catalog/index.js';
import { executeBackup } from '../../../src/index.js';
import { FileInstallationIdentityStore } from '#adapters/core/installation-files/index.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/index.js';
import { firstRunPolicyTemplate } from '#domain/index.js';
import { skillContentDigest, skillSignatureMessage } from '#engine/index.js';
import { clearConfigCache, ed25519KeyId, prepareProductFile, productResourcePath, resolveProductLayout } from '#platform/index.js';

// S8-5 through the real composition (first-run policy template, integrity key, SQLite ledger, `signers` key store): the person enrols, registers,
// imports and revokes on their own terminal; the AI is refused; no private key reaches a result, the ledger or a backup set (N39, N45); a ledger
// restored from before a revoke is re-revoked at start from the revocation log, which no restore removes (N41 post-restore).
beforeEach(context => { if (process.platform !== 'linux') context.skip('POSIX key custody and the local OS principal'); });
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const person = { attest: async () => true };
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'deckent-catalog-signers-')); roots.push(base);
  const root = join(base, 'project'), data = join(base, 'data'), env = { HOME: join(base, 'home'), DECKENT_GLOBAL_HOME: join(base, 'global'), NO_COLOR: '1', PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const layout = resolveProductLayout({ projectRoot: root, root: data });
  for (const dir of [root, join(root, '.deckent'), data, join(data, 'state'), env.HOME]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await file(join(root, '.deckent/config.json'), { layout: { root: data }, backup: { schedule: 'off' }, approvals: { keyFile: 'authority.key' } });
  await new FileInstallationIdentityStore(layout, 2000).loadOrCreate();
  await openLocalIntegrityAuthority(layout, 'authority.key', true);
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: readLocalOsIdentity(), readToolNames: ['read_file'], scratchToolNames: ['write_scratch'],
    scratchWriteOperationId: 'workspace.scratch.write', editShellToolNames: ['edit_file', 'run_shell'], writeOperationId: 'workspace.file.write', shellOperationId: 'shell.execute',
    proposeMcpToolName: 'propose_mcp_server', mcpCallOperationId: 'mcp.tool.call', policyAdministerOperationId: 'policy.administer' });
  await file(productResourcePath(layout, 'policy'), template.policy); await file(productResourcePath(layout, 'bindings'), template.bindings);
  const ledger = await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']);
  openSqliteLedger(ledger, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }).close();
  const me = readLocalOsIdentity();
  return { base, root, layout, ledger, options: { env }, mcp: { issuer: `${me.issuer}/mcp`, subject: me.subject } };
}
const vendor = generateKeyPairSync('ed25519'), vendorDer = vendor.publicKey.export({ type: 'spki', format: 'der' });
const content = { name: 'Fatura', text: 'Siparişi faturayla eşle.' }, pin = skillContentDigest(content);
const bundle = { schemaVersion: 1, commandId: 'i1', scopeId: 'scope', skillId: 'invoice-match', expectedRevision: null, content, source: { ref: 'hub:verhex/invoice-match' }, pin,
  signature: { algorithm: 'ed25519' as const, keyId: ed25519KeyId(vendorDer), value: sign(null, skillSignatureMessage({ skillId: 'invoice-match', contentDigest: pin }), vendor.privateKey).toString('base64') } };
const files = async (dir: string): Promise<string[]> => (await readdir(dir, { withFileTypes: true })).flatMap(entry => entry.isDirectory() ? [] : [join(dir, entry.name)])
  .concat(...await Promise.all((await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => files(join(dir, entry.name)))));

it('a person enrols, registers and imports on the first-run policy; the AI is refused; no private key reaches a result, the ledger or a backup set (N39, N45)', async () => {
  const f = await fixture(), scope = { schemaVersion: 1 as const, scopeId: 'scope' };
  const enrolled = await enrolConfiguredSigner(f.root, { ...scope, commandId: 'e1', principal: f.mcp, label: 'MCP actor' }, f.options, person);
  await addConfiguredSigner(f.root, { ...scope, commandId: 'a1', purpose: 'import', publicKey: vendorDer.toString('base64'), principal: null, label: 'Verhex hub' }, f.options, person);
  expect((await importConfiguredSkill(f.root, bundle, f.options, person)).item).toMatchObject({ source: { kind: 'import' }, signature: { status: 'verified' } });
  // The AI (MCP actor) cannot reach a signer card, whatever it is granted.
  for (const write of [() => enrolConfiguredSigner(f.root, { ...scope, commandId: 'e2', principal: f.mcp, label: 'x' }, f.options, person),
    () => revokeConfiguredSigner(f.root, { ...scope, commandId: 'r0', keyId: enrolled.item.keyId }, f.options, person)])
    await expect(withMcpPrincipal(write)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  const listing = await listConfiguredSigners(f.root, scope, f.options);
  expect(listing.items.map(row => [row.purpose, row.custody, row.state])).toEqual([['action', 'host', 'active'], ['import', 'external', 'active']]);
  const der = await readFile(join(productResourcePath(f.layout, 'signers'), `${enrolled.item.keyId}.p8`)), secrets = [der, der.subarray(16)].flatMap(bytes => [bytes.toString('base64'), bytes.toString('hex')]);
  const shown = JSON.stringify([enrolled, listing, await inspectConfiguredSkill(f.root, { ...scope, skillId: 'invoice-match' }, f.options)]);
  for (const secret of secrets) { expect(shown).not.toContain(secret); expect(JSON.stringify(f.options.env)).not.toContain(secret); expect(process.argv.join(' ')).not.toContain(secret); }
  const ledgerBytes = await readFile(f.ledger);
  expect(ledgerBytes.includes(der.subarray(16))).toBe(false);
  // A backup set never carries the signer store: no key file, no key bytes in any file of the set.
  const set = join(f.base, 'set');
  await executeBackup(f.root, { schemaVersion: 1, scopeId: 'scope', action: 'create', set } as Parameters<typeof executeBackup>[1], 'CANARY-signer-backup-passphrase', f.options);
  const setFiles = await files(set);
  expect(setFiles.some(path => path.endsWith('ledger.db'))).toBe(true);
  for (const path of setFiles) {
    const bytes = await readFile(path);
    expect(path.slice(set.length)).not.toMatch(/signers|\.p8$/);
    for (const needle of [der, der.subarray(16), Buffer.from(der.toString('base64')), Buffer.from(der.subarray(16).toString('hex'))]) expect(bytes.includes(needle)).toBe(false);
  }
  expect((await stat(productResourcePath(f.layout, 'signers'))).mode & 0o777).toBe(0o700);
});

it('N41 post-restore: a ledger restored from before a revoke is re-revoked at start from the revocation log, which no restore removes', async () => {
  const f = await fixture(), scope = { schemaVersion: 1 as const, scopeId: 'scope' };
  const enrolled = await enrolConfiguredSigner(f.root, { ...scope, commandId: 'e1', principal: f.mcp, label: 'MCP actor' }, f.options, person);
  const before = join(f.base, 'ledger-before-revoke.db');
  await copyFile(f.ledger, before);
  const revoked = await revokeConfiguredSigner(f.root, { ...scope, commandId: 'r1', keyId: enrolled.item.keyId }, f.options, person);
  expect(revoked).toMatchObject({ logged: true, item: { state: 'revoked', revoked: { basis: 'person-card' } } });
  await copyFile(before, f.ledger); clearConfigCache();
  expect((await listConfiguredSigners(f.root, scope, f.options)).items[0]).toMatchObject({ state: 'active' });
  expect(await replayConfiguredSignerRevocations(f.root, f.options)).toBe(1);
  expect((await listConfiguredSigners(f.root, scope, f.options)).items[0]).toMatchObject({ state: 'revoked', revoked: { basis: 'revocation-log' } });
  expect(await replayConfiguredSignerRevocations(f.root, f.options)).toBe(0);
  const db = new DatabaseSync(f.ledger, { readOnly: true });
  try { expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind='skill-signer'").get()?.['n']).toBe(2); } finally { db.close(); }
});
