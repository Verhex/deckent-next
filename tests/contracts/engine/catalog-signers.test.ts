import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteAgentCatalogStore } from '#adapters/index.js';
import { AgentCatalogApplication, AgentCatalogStoreError, SignerKeyApplication, catalogCommandDigest, skillContentDigest, skillSignatureMessage, type AgentCatalogDependencies,
  type SignerKeyCustody, type SignerRevocation, type SignerRevocationLog } from '#engine/index.js';
import { catalogActionBytes, SIGNATURE_LABELS, type CatalogAction } from '#domain/index.js';
import { createHmacIntegrity, ed25519KeyId, signatureMessage, sha256 } from '#platform/index.js';

// S8-5 (S8-DESIGN §8, §9; negatives N1, N2, N21, N22, N38, N41, N44): signer rows are a person's; an AI/system catalog write is signed by its own
// active key and verified in the store's commit transaction; a revoke stops new, pending and replayed actions at once and keeps committed rows.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 1000, journalMode: 'wal' as const, durability: 'full' as const };
const integrity = createHmacIntegrity('catalog-key', randomBytes(32));
const human = { id: 'h', issuer: 'local-os', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const mcp = { id: 'm', issuer: 'local-os/mcp', subject: 'uid:1000', assurance: 'os-user' as const, scopeIds: ['s'] };
const other = { id: 'o', issuer: 'local-os/memory-distiller', subject: 'uid:1000', assurance: 'workload-verified' as const, scopeIds: ['s'] };
const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'der' });
const b64 = (key: KeyObject) => spki(key).toString('base64');
/** A test custody: host keys in memory (the real one is `localSignerKeyCustody`, tested with its files). It signs only catalog-action bytes. */
function testCustody(onSign?: () => Promise<void>) {
  const keys = new Map<string, KeyObject>(), signed: string[] = [];
  const custody: SignerKeyCustody = {
    async create() { const pair = generateKeyPairSync('ed25519'), keyId = ed25519KeyId(spki(pair.publicKey)); keys.set(keyId, pair.privateKey); return { keyId, publicKey: b64(pair.publicKey) }; },
    async signAction(keyId, action) {
      await onSign?.(); signed.push(keyId);
      return sign(null, signatureMessage(SIGNATURE_LABELS.catalogAction, catalogActionBytes(action)), keys.get(keyId)!).toString('base64');
    } };
  return { custody, signed };
}
function memoryLog(): SignerRevocationLog & { entries: SignerRevocation[]; broken: boolean } {
  const log = { entries: [] as SignerRevocation[], broken: false,
    async list() { if (log.broken) throw new AgentCatalogStoreError('SIGNER_REVOCATION_LOG_BROKEN'); return [...log.entries]; },
    async append(entry: SignerRevocation) { if (log.broken) throw new AgentCatalogStoreError('SIGNER_REVOCATION_LOG_BROKEN'); log.entries.push(entry); },
    async repair(add: readonly SignerRevocation[]) { log.broken = false; for (const row of add) if (!log.entries.some(e => e.keyId === row.keyId)) log.entries.push(row); return [...log.entries]; } };
  return log;
}
async function fixture(extra: Partial<AgentCatalogDependencies> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-catalog-signers-')); roots.push(root);
  const path = join(root, 'ledger.db'); openSqliteLedger(path, options).close();
  let ids = 0, as: typeof human | typeof mcp | typeof other = human;
  const host = testCustody(), log = memoryLog();
  const deps: AgentCatalogDependencies = { verifier: { verify: async () => as }, authorize: async () => ({ revision: 'p', ruleId: 'r' }), authorizeSigner: async () => ({ revision: 'p', ruleId: 'r' }),
    openStore: async access => openSqliteAgentCatalogStore(path, options, integrity, access), custody: host.custody, revocations: log, now: () => 1_000, eventId: () => `e${++ids}`, ...extra };
  return { path, log, host, signers: new SignerKeyApplication(deps), catalog: new AgentCatalogApplication(deps), as: (principal: typeof as) => { as = principal; } };
}
const count = (path: string, table: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.['n']); } finally { db.close(); } };
const skill = (commandId: string, text = 'Siparişi faturayla eşle.', expectedRevision: number | null = null, signed?: { keyId: string; signature: string }) =>
  ({ schemaVersion: 1, scopeId: 's', commandId, skillId: 'invoice-match', expectedRevision, content: { name: 'Fatura', text }, ...(signed ? { signed } : {}) });
const enrol = (commandId: string, principal = mcp) => ({ schemaVersion: 1, scopeId: 's', commandId, principal: { issuer: principal.issuer, subject: principal.subject }, label: 'mcp actor' });
/** The `catalog-action:1` an external key signs for a skill define (what the application builds). */
const action = (command: ReturnType<typeof skill>, principal = mcp, revision = 1): CatalogAction => ({ scopeId: 's', action: 'define', target: { kind: 'skill', id: 'invoice-match', revision },
  expectedRevision: command.expectedRevision, contentDigest: catalogCommandDigest('skill', command, principal), toStanding: null, suggestionId: null, commandId: command.commandId,
  principal: { issuer: principal.issuer, subject: principal.subject } });

describe('N22: signer rows are a person\'s', () => {
  it('negative: every AI principal is refused enrol, add, revoke and repair before any key exists, whatever policy grants; nothing is written', async () => {
    const f = await fixture(), key = generateKeyPairSync('ed25519');
    for (const principal of [mcp, other]) {
      f.as(principal);
      await expect(f.signers.enrol(enrol('e1'))).rejects.toMatchObject({ code: 'SKILL_SIGNER_REFUSED' });
      await expect(f.signers.add({ schemaVersion: 1, scopeId: 's', commandId: 'a1', purpose: 'import', publicKey: b64(key.publicKey), principal: null, label: 'vendor' })).rejects.toMatchObject({ code: 'SKILL_SIGNER_REFUSED' });
      await expect(f.signers.revoke({ schemaVersion: 1, scopeId: 's', commandId: 'r1', keyId: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'SKILL_SIGNER_REFUSED' });
      await expect(f.signers.repair({ schemaVersion: 1, scopeId: 's', commandId: 'p1' })).rejects.toMatchObject({ code: 'SKILL_SIGNER_REFUSED' });
    }
    expect(f.host.signed).toEqual([]);
    expect(['skill_signer_keys', 'skill_signer_receipts', 'audit_events'].map(table => count(f.path, table))).toEqual([0, 0, 0]);
  });
  it('a person enrols one host action key per principal, registers an external import key; an action key is never bound to the person', async () => {
    const f = await fixture(), key = generateKeyPairSync('ed25519');
    const made = await f.signers.enrol(enrol('e1'));
    expect(made.item).toMatchObject({ purpose: 'action', custody: 'host', state: 'active', boundPrincipal: { issuer: 'local-os/mcp' }, addedBy: { ai: false }, revision: 1 });
    expect(await f.signers.enrol(enrol('e1'))).toMatchObject({ replayed: true, item: { keyId: made.item.keyId } });
    await expect(f.signers.enrol(enrol('e2'))).rejects.toMatchObject({ code: 'SKILL_SIGNER_INVALID' });
    await expect(f.signers.enrol(enrol('e3', human))).rejects.toMatchObject({ code: 'SKILL_SIGNER_INVALID' });
    const vendor = await f.signers.add({ schemaVersion: 1, scopeId: 's', commandId: 'a1', purpose: 'import', publicKey: b64(key.publicKey), principal: null, label: 'Verhex hub' });
    expect(vendor.item).toMatchObject({ keyId: sha256Der(key.publicKey), custody: 'external', boundPrincipal: null });
    const listed = await f.signers.list({ schemaVersion: 1, scopeId: 's' });
    expect(listed).toMatchObject({ log: 'ok', items: [{ keyId: made.item.keyId, signedRows: 0 }, { keyId: vendor.item.keyId }] });
    expect(JSON.stringify(listed)).not.toMatch(/PRIVATE|pkcs8/i);
  });
});
const sha256Der = (key: KeyObject) => ed25519KeyId(spki(key));

describe('signer row bounds held by the store transaction', () => {
  it('one active action key per principal even when two enrols race past the application check; the bound counts active keys only', async () => {
    const f = await fixture(), first = (await f.signers.enrol(enrol('e1'))).item;
    // A second enrol whose application check ran before the first committed: the store refuses it inside its transaction.
    const store = await openSqliteAgentCatalogStore(f.path, options, integrity, 'write'), next = { ...first, keyId: 'd'.repeat(64), commandId: 'e2' };
    try {
      await expect(store.commitSigner({ previous: null, next, event: { schemaVersion: 1, eventId: 'x', scopeId: 's', principal: { issuer: human.issuer, subject: human.subject }, policyRevision: 'p', atMs: 1,
        subject: { kind: 'skill-signer', action: 'enrol', keyId: next.keyId, purpose: 'action', custody: 'host', commandId: 'e2', revision: 1, basis: 'person-card' } },
        receipt: { scopeId: 's', commandId: 'e2', keyId: next.keyId, revision: 1, digest: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'SKILL_SIGNER_INVALID' });
    } finally { store.close(); }
    // Rotation many times over: revoked rows stay, but only active keys count toward the bound, and the active key is always found first.
    let current = first;
    for (let round = 0; round < 70; round++) {
      await f.signers.revoke({ schemaVersion: 1, scopeId: 's', commandId: `r${round}`, keyId: current.keyId });
      current = (await f.signers.enrol(enrol(`e-${round}`))).item;
    }
    f.as(mcp);
    expect((await f.catalog.defineSkill(skill('k1'))).item.provenance.signed?.keyId).toBe(current.keyId);
    expect(count(f.path, 'skill_signer_keys')).toBe(71);
  });
});

describe('N1/N38: AI/system writes are signed, verified at commit; revocation is immediate', () => {
  it('negative: an AI write without an enrolled key is refused; with a key revoked, another principal\'s key or a forged signature too; nothing is written', async () => {
    const f = await fixture();
    f.as(mcp);
    await expect(f.catalog.defineSkill(skill('k1'))).rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_REQUIRED' });
    f.as(human); const distiller = await f.signers.enrol(enrol('e-d', other)); f.as(mcp);
    // The distiller's key named by the MCP actor (other principal), a signature over other bytes, a signature with no row.
    const command = skill('k2'), stranger = generateKeyPairSync('ed25519');
    await expect(f.catalog.defineSkill({ ...command, signed: { keyId: distiller.item.keyId, signature: 'A'.repeat(86) + '==' } })).rejects.toMatchObject({ code: 'CATALOG_SIGNER_MISMATCH' });
    await expect(f.catalog.defineSkill({ ...command, signed: { keyId: sha256Der(stranger.publicKey), signature: sign(null, Buffer.from('x'), stranger.privateKey).toString('base64') } }))
      .rejects.toMatchObject({ code: 'CATALOG_SIGNER_UNKNOWN' });
    f.as(human); const own = await f.signers.enrol(enrol('e-m')); await f.signers.revoke({ schemaVersion: 1, scopeId: 's', commandId: 'r1', keyId: own.item.keyId }); f.as(mcp);
    await expect(f.catalog.defineSkill(skill('k3'))).rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_REQUIRED' });
    expect(['skill_definitions', 'agent_catalog_receipts'].map(table => count(f.path, table))).toEqual([0, 0]);
  });
  it('positive twin: an AI with its own active host key writes; the row and audit event name the key; a person\'s row carries no signature', async () => {
    const f = await fixture();
    const key = (await f.signers.enrol(enrol('e1'))).item;
    f.as(mcp);
    const made = await f.catalog.defineSkill(skill('k1'));
    expect(made.item.provenance).toMatchObject({ author: { ai: true }, signed: { keyId: key.keyId, signatureDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    f.as(human);
    expect((await f.catalog.defineSkill(skill('k2', 'İkinci metin.', 1))).item.provenance.signed).toBeUndefined();
    await expect(f.catalog.defineSkill({ ...skill('k3', 'Üçüncü.', 2), signed: { keyId: key.keyId, signature: 'A'.repeat(86) + '==' } })).rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_INVALID' });
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      const events = db.prepare("SELECT record FROM audit_events WHERE kind='agent-catalog' ORDER BY sequence").all().map(row => String(row['record']));
      expect(events[0]).toContain(key.keyId); expect(events[1]).not.toContain('signed');
    } finally { db.close(); }
    expect((await f.signers.list({ schemaVersion: 1, scopeId: 's' })).items[0]).toMatchObject({ keyId: key.keyId, signedRows: 1 });
  });
  it('external custody: a remote principal\'s signature over exactly catalog-action:1 is accepted; under another label it is refused (N44)', async () => {
    const f = await fixture(), remote = generateKeyPairSync('ed25519');
    await f.signers.add({ schemaVersion: 1, scopeId: 's', commandId: 'a1', purpose: 'action', publicKey: b64(remote.publicKey), principal: { issuer: mcp.issuer, subject: mcp.subject }, label: 'remote' });
    f.as(mcp);
    const keyId = sha256Der(remote.publicKey), command = skill('k1'), bytes = catalogActionBytes(action(command));
    for (const label of [SIGNATURE_LABELS.skill, SIGNATURE_LABELS.package, SIGNATURE_LABELS.revocationFeed])
      await expect(f.catalog.defineSkill({ ...command, signed: { keyId, signature: sign(null, signatureMessage(label, bytes), remote.privateKey).toString('base64') } }))
        .rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_INVALID' });
    await expect(f.catalog.defineSkill({ ...command, signed: { keyId, signature: sign(null, Buffer.from(bytes), remote.privateKey).toString('base64') } })).rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_INVALID' });
    const good = sign(null, signatureMessage(SIGNATURE_LABELS.catalogAction, bytes), remote.privateKey).toString('base64');
    expect((await f.catalog.defineSkill({ ...command, signed: { keyId, signature: good } })).item.provenance.signed).toEqual({ keyId, signatureDigest: sha256(good) });
    expect(count(f.path, 'skill_definitions')).toBe(1);
  });
  it('N38: a key revoked between signing and commit refuses in the commit transaction; a replay after the revoke is refused; the committed row stays (N41)', async () => {
    let revokeNow: (() => Promise<void>) | undefined;
    const host = testCustody(async () => { await revokeNow?.(); });
    const f = await fixture({ custody: host.custody });
    const key = (await f.signers.enrol(enrol('e1'))).item;
    f.as(mcp);
    const committed = await f.catalog.defineSkill(skill('k1'));
    revokeNow = async () => { revokeNow = undefined; f.as(human); await f.signers.revoke({ schemaVersion: 1, scopeId: 's', commandId: 'r1', keyId: key.keyId }); f.as(mcp); };
    await expect(f.catalog.defineSkill(skill('k2', 'Yeni.', 1))).rejects.toMatchObject({ code: 'CATALOG_SIGNER_REVOKED' });
    await expect(f.catalog.defineSkill(skill('k1'))).rejects.toMatchObject({ code: 'CATALOG_SIGNER_REVOKED' });
    expect(f.log.entries).toMatchObject([{ scopeId: 's', keyId: key.keyId, by: { issuer: 'local-os' } }]);
    const shown = await f.catalog.inspectSkill({ schemaVersion: 1, scopeId: 's', skillId: 'invoice-match' });
    expect(shown).toMatchObject({ status: 'ok', item: { revision: 1, provenance: { signed: { keyId: key.keyId } } }, signers: { [key.keyId]: 'revoked' } });
    expect(committed.item.revision).toBe(1);
  });
  it('a key the revocation log lists, or a broken log, refuses before any signing; the start-up replay re-revokes through the same step (N41 restore)', async () => {
    const f = await fixture();
    const key = (await f.signers.enrol(enrol('e1'))).item;
    // As after a restore: the ledger still holds the key active, the log (never backed up) holds its revocation.
    f.log.entries.push({ scopeId: 's', keyId: key.keyId, by: { issuer: 'local-os', subject: 'uid:1000' }, atMs: 5, commandId: 'r-before-restore' });
    f.as(mcp);
    await expect(f.catalog.defineSkill(skill('k1'))).rejects.toMatchObject({ code: 'CATALOG_SIGNER_REVOKED' });
    expect(f.host.signed).toEqual([]);
    expect(await f.signers.replay('s')).toBe(1);
    expect(await f.signers.replay('s')).toBe(0);
    expect((await f.signers.list({ schemaVersion: 1, scopeId: 's' })).items[0]).toMatchObject({ state: 'revoked', revoked: { basis: 'revocation-log', by: { ai: false } } });
    f.log.broken = true;
    await expect(f.catalog.defineSkill(skill('k2'))).rejects.toMatchObject({ code: 'SIGNER_REVOCATION_LOG_BROKEN' });
    f.as(human);
    expect((await f.signers.list({ schemaVersion: 1, scopeId: 's' })).log).toBe('broken');
    expect(await f.signers.repair({ schemaVersion: 1, scopeId: 's', commandId: 'p1' })).toMatchObject({ entries: 1 });
    expect((await f.signers.list({ schemaVersion: 1, scopeId: 's' })).log).toBe('ok');
  });
  it('a revoke with a broken log still revokes in the ledger at once and says it was not logged', async () => {
    const f = await fixture(), key = (await f.signers.enrol(enrol('e1'))).item;
    f.log.broken = true;
    expect(await f.signers.revoke({ schemaVersion: 1, scopeId: 's', commandId: 'r1', keyId: key.keyId })).toMatchObject({ logged: false, item: { state: 'revoked' } });
    await expect(f.signers.revoke({ schemaVersion: 1, scopeId: 's', commandId: 'r2', keyId: key.keyId })).rejects.toMatchObject({ code: 'AGENT_CATALOG_REVISION_CONFLICT' });
  });
});

describe('N21: a signed import verifies against an active import key of the scope, at commit', () => {
  const vendor = generateKeyPairSync('ed25519'), content = { name: 'Fatura', text: 'Siparişi faturayla eşle.' }, pin = skillContentDigest(content);
  const bundle = (commandId: string, key = vendor.privateKey, keyId = sha256Der(vendor.publicKey), message = skillSignatureMessage({ skillId: 'invoice-match', contentDigest: pin })) =>
    ({ schemaVersion: 1, scopeId: 's', commandId, skillId: 'invoice-match', expectedRevision: null, content, source: { ref: 'hub:verhex/invoice-match' }, pin,
      signature: { algorithm: 'ed25519' as const, keyId, value: sign(null, message, key).toString('base64') } });
  it('negative: unknown key, a key of another purpose, a revoked key, a signature under another label: refused, nothing written', async () => {
    const f = await fixture();
    await expect(f.catalog.importSkill(bundle('i1'))).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
    await f.signers.add({ schemaVersion: 1, scopeId: 's', commandId: 'a1', purpose: 'publish', publicKey: b64(vendor.publicKey), principal: null, label: 'publisher' });
    await expect(f.catalog.importSkill(bundle('i2'))).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
    await f.signers.revoke({ schemaVersion: 1, scopeId: 's', commandId: 'r1', keyId: sha256Der(vendor.publicKey) });
    const again = generateKeyPairSync('ed25519');
    await f.signers.add({ schemaVersion: 1, scopeId: 's', commandId: 'a2', purpose: 'import', publicKey: b64(again.publicKey), principal: null, label: 'import' });
    const keyId = sha256Der(again.publicKey);
    await expect(f.catalog.importSkill(bundle('i3', again.privateKey, keyId, signatureMessage(SIGNATURE_LABELS.catalogAction, 'x')))).rejects.toMatchObject({ code: 'SKILL_IMPORT_SIGNATURE_UNVERIFIED' });
    expect(count(f.path, 'skill_definitions')).toBe(0);
    expect((await f.catalog.importSkill(bundle('i4', again.privateKey, keyId))).item).toMatchObject({ source: { kind: 'import' }, signature: { status: 'verified', keyId } });
  });
});
