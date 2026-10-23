import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { agentDefinitionSchema, agentStandingSchema, catalogActionBytes, checkAgentOrgTree, encodeCommandProjection, requireActionSigner, signerKeySchema, AgentCatalogError,
  skillDefinitionSchema, AGENT_CATALOG_LIMITS, SIGNATURE_LABELS, type AgentDefinition, type AgentStanding, type SignerKey, type SkillDefinition } from '#domain/index.js';
import { AuditApplication, AgentCatalogStoreError, skillSignatureMessage, type AgentCatalogChange, type AgentCatalogReceipt, type AgentCatalogStore, type SignerChange } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, requireLedgerVersion, SIGNER_KEY_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { sha256, signatureMessage, verifyEd25519, type IntegrityAuthority } from '#platform/index.js';

const SEAL = 'agent-catalog-store:1';
const corrupt = () => new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT'), STANDING = 'agent_id,revision,work_class,standing,standing_revision,record';
type Kind = 'agent' | 'skill';
const TABLE = { agent: { current: 'agent_definitions', revisions: 'agent_definition_revisions', id: 'agent_id' },
  skill: { current: 'skill_definitions', revisions: 'skill_definition_revisions', id: 'skill_id' } } as const;
/**
 * Core SQLite adapter of the DB-neutral agent catalog port, on the shared ledger (v64; standings v67; signer keys v68, which every read requires). Every row is sealed with the installation integrity key and
 * cross-checked against its columns on read; revisions and receipts are append-only and current rows undeletable (ledger triggers). An agent
 * commit re-checks the scope's org tree (`checkAgentOrgTree`) over the rows it holds inside the same BEGIN IMMEDIATE transaction.
 */
class SqliteAgentCatalogStore implements AgentCatalogStore {
  private readonly audit: AuditApplication;
  constructor(private readonly db: DatabaseSync, private readonly integrity: IntegrityAuthority) { this.audit = new AuditApplication(new SqliteAuditStore(db), integrity); }
  private seal(value: unknown) { return JSON.stringify({ value, keyId: this.integrity.keyId, mac: this.integrity.sign(encodeCommandProjection(SEAL, value)) }); }
  private open(input: unknown): unknown {
    try {
      const sealed = JSON.parse(String(input)) as { value: unknown; mac: string; keyId: string };
      if (this.integrity.verify(encodeCommandProjection(SEAL, sealed.value), sealed.mac, sealed.keyId)) return sealed.value;
    } catch { /* fall through */ }
    throw corrupt();
  }
  private row<K extends Kind>(kind: K, row: Record<string, unknown>, scopeId: string): K extends 'agent' ? AgentDefinition : SkillDefinition {
    const parsed = (kind === 'agent' ? agentDefinitionSchema : skillDefinitionSchema).safeParse(this.open(row['record']));
    if (!parsed.success) throw corrupt();
    const item = parsed.data as AgentDefinition | SkillDefinition, id = 'agentId' in item ? item.agentId : item.skillId;
    if (item.scopeId !== scopeId || id !== row[TABLE[kind].id] || item.revision !== row['revision']
      || ('parent_id' in row && 'agentId' in item && item.content.parentAgentId !== row['parent_id'])
      || ('content_digest' in row && 'skillId' in item && item.contentDigest !== row['content_digest'])) throw corrupt();
    return item as K extends 'agent' ? AgentDefinition : SkillDefinition;
  }
  private read<T>(work: () => T): T {
    try { return work(); } catch (error) { throw error instanceof AgentCatalogStoreError || error instanceof AgentCatalogError ? error : new AgentCatalogStoreError('AGENT_CATALOG_UNAVAILABLE'); }
  }
  private load<K extends Kind>(kind: K, scopeId: string, id: string, revision?: number) {
    const t = TABLE[kind], columns = kind === 'agent' ? (revision === undefined ? ',parent_id' : '') : revision === undefined ? '' : ',content_digest';
    const row = revision === undefined ? this.db.prepare(`SELECT ${t.id},revision${columns},record FROM ${t.current} WHERE scope_id=? AND ${t.id}=?`).get(scopeId, id)
      : this.db.prepare(`SELECT ${t.id},revision${columns},record FROM ${t.revisions} WHERE scope_id=? AND ${t.id}=? AND revision=?`).get(scopeId, id, revision);
    return row ? this.row(kind, row, scopeId) : null;
  }
  private history<K extends Kind>(kind: K, scopeId: string, id: string, limit: number) {
    const t = TABLE[kind];
    return this.db.prepare(`SELECT ${t.id},revision,record FROM ${t.revisions} WHERE scope_id=? AND ${t.id}=? ORDER BY revision DESC LIMIT ?`).all(scopeId, id, limit)
      .map(row => this.row(kind, row, scopeId)).reverse();
  }
  private list<K extends Kind>(kind: K, scopeId: string, limit: number) {
    const t = TABLE[kind];
    return this.db.prepare(`SELECT ${t.id},revision,record FROM ${t.current} WHERE scope_id=? ORDER BY seq DESC LIMIT ?`).all(scopeId, limit).map(row => this.row(kind, row, scopeId));
  }
  async loadAgent(scopeId: string, agentId: string, revision?: number) { return this.read(() => this.load('agent', scopeId, agentId, revision)); }
  async agentHistory(scopeId: string, agentId: string, limit: number) { return this.read(() => this.history('agent', scopeId, agentId, limit)); }
  async listAgents(scopeId: string, limit: number) { return this.read(() => this.list('agent', scopeId, limit)); }
  async loadSkill(scopeId: string, skillId: string, revision?: number) { return this.read(() => this.load('skill', scopeId, skillId, revision)); }
  async skillHistory(scopeId: string, skillId: string, limit: number) { return this.read(() => this.history('skill', scopeId, skillId, limit)); }
  async listSkills(scopeId: string, limit: number) { return this.read(() => this.list('skill', scopeId, limit)); }
  private loadReceipt(scopeId: string, commandId: string): AgentCatalogReceipt | null {
    const row = this.db.prepare('SELECT kind,item_id,revision,record FROM agent_catalog_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    const receipt = this.open(row['record']) as AgentCatalogReceipt;
    if (receipt.scopeId !== scopeId || receipt.commandId !== commandId || receipt.kind !== row['kind'] || receipt.itemId !== row['item_id'] || receipt.revision !== row['revision']) throw corrupt();
    return receipt;
  }
  async receipt(scopeId: string, commandId: string) { return this.read(() => this.loadReceipt(scopeId, commandId)); }
  /** S8-1a/b (v67): a sealed standing row, cross-checked against its columns. */
  private standing(row: Record<string, unknown>, scopeId: string): AgentStanding {
    const parsed = agentStandingSchema.safeParse(this.open(row['record']));
    if (!parsed.success || parsed.data.scopeId !== scopeId || parsed.data.agentId !== row['agent_id'] || parsed.data.revision !== row['revision'] || parsed.data.workClass !== row['work_class']
      || parsed.data.standing !== row['standing'] || parsed.data.standingRevision !== row['standing_revision']) throw corrupt();
    return parsed.data;
  }
  async standings(scopeId: string, agentId: string, revision: number) { return this.read(() => this.db.prepare(`SELECT ${STANDING} FROM agent_standings WHERE scope_id=? AND agent_id=?
    AND revision=? ORDER BY work_class LIMIT ?`).all(scopeId, agentId, revision, AGENT_CATALOG_LIMITS.workClassesPerAgentMax).map(row => this.standing(row, scopeId))); }
  async eligibleAgents(scopeId: string, workClass: string, limit: number) {
    return this.read(() => this.db.prepare(`SELECT ${STANDING.split(',').map(c => `s.${c}`).join(',')},d.revision AS d_revision,d.parent_id,d.record AS d_record FROM agent_standings s JOIN agent_definitions d
      ON d.scope_id=s.scope_id AND d.agent_id=s.agent_id AND d.revision=s.revision WHERE s.scope_id=? AND s.work_class=? AND s.standing IN('active','candidate') ORDER BY s.agent_id LIMIT ?`)
      .all(scopeId, workClass, limit).map(row => ({ standing: this.standing(row, scopeId), agent: this.row('agent', { agent_id: row['agent_id'], revision: row['d_revision'], parent_id: row['parent_id'], record: row['d_record'] }, scopeId) })));
  }
  /** S8-5 (v68): a sealed signer row, cross-checked against its columns. */
  private signerRow(row: Record<string, unknown> | undefined, scopeId: string): SignerKey | null {
    if (!row) return null;
    const parsed = signerKeySchema.safeParse(this.open(row['record']));
    if (!parsed.success || parsed.data.scopeId !== scopeId || parsed.data.keyId !== row['key_id'] || parsed.data.state !== row['state'] || parsed.data.revision !== row['revision']) throw corrupt();
    return parsed.data;
  }
  private loadSigner(scopeId: string, keyId: string) { return this.signerRow(this.db.prepare('SELECT key_id,state,revision,record FROM skill_signer_keys WHERE scope_id=? AND key_id=?').get(scopeId, keyId), scopeId); }
  async signers(scopeId: string, limit: number) { return this.read(() => this.db.prepare('SELECT key_id,state,revision,record FROM skill_signer_keys WHERE scope_id=? ORDER BY seq LIMIT ?')
    .all(scopeId, limit).map(row => this.signerRow(row, scopeId)!)); }
  async signer(scopeId: string, keyId: string) { return this.read(() => this.loadSigner(scopeId, keyId)); }
  async signerReceipt(scopeId: string, commandId: string) {
    return this.read(() => {
      const row = this.db.prepare('SELECT record FROM skill_signer_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
      const receipt = row ? this.open(row['record']) as SignerChange['receipt'] : null;
      if (receipt && (receipt.scopeId !== scopeId || receipt.commandId !== commandId)) throw corrupt();
      return receipt;
    });
  }
  /** Committed agent and skill revisions whose provenance names `keyId` (they stay after a revoke and are shown as signed by a revoked key). */
  async signedRows(scopeId: string, keyId: string) {
    return this.read(() => ['agent_definition_revisions', 'skill_definition_revisions'].reduce((sum, table) => sum + Number(this.db.prepare(`SELECT count(*) AS n FROM ${table}
      WHERE scope_id=? AND json_extract(record,'$.value.provenance.signed.keyId')=?`).get(scopeId, keyId)?.['n'] ?? 0), 0));
  }
  async commitSigner(change: SignerChange) {
    const next = signerKeySchema.parse(change.next), { receipt } = change;
    if (next.scopeId !== receipt.scopeId || next.keyId !== receipt.keyId || next.revision !== receipt.revision || next.revision !== (change.previous ? 2 : 1)) throw corrupt();
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT record FROM skill_signer_receipts WHERE scope_id=? AND command_id=?').get(receipt.scopeId, receipt.commandId);
      if (prior) {
        const done = this.open(prior['record']) as SignerChange['receipt'], item = done.digest === receipt.digest ? this.loadSigner(done.scopeId, done.keyId) : null;
        if (!item) throw new AgentCatalogStoreError('AGENT_CATALOG_COMMAND_CONFLICT'); return { replayed: true, item };
      }
      const current = this.loadSigner(next.scopeId, next.keyId);
      if (!change.previous && current) throw new AgentCatalogStoreError('AGENT_CATALOG_EXISTS');
      if (!isDeepStrictEqual(current, change.previous)) throw new AgentCatalogStoreError('AGENT_CATALOG_REVISION_CONFLICT');
      if (!current && Number(this.db.prepare('SELECT count(*) AS n FROM skill_signer_keys WHERE scope_id=?').get(next.scopeId)?.['n']) >= AGENT_CATALOG_LIMITS.signersPerScopeMax)
        throw new AgentCatalogStoreError('AGENT_CATALOG_LIMIT');
      this.audit.record(change.event);
      const record = this.seal(next);
      if (current) this.db.prepare('UPDATE skill_signer_keys SET state=?,revision=?,record=? WHERE scope_id=? AND key_id=?').run(next.state, next.revision, record, next.scopeId, next.keyId);
      else this.db.prepare('INSERT INTO skill_signer_keys(scope_id,key_id,state,revision,seq,record) VALUES(?,?,?,?,(SELECT coalesce(max(seq),0)+1 FROM skill_signer_keys WHERE scope_id=?),?)')
        .run(next.scopeId, next.keyId, next.state, next.revision, next.scopeId, record);
      this.db.prepare('INSERT INTO skill_signer_key_revisions(scope_id,key_id,revision,record) VALUES(?,?,?,?)').run(next.scopeId, next.keyId, next.revision, record);
      this.db.prepare('INSERT INTO skill_signer_receipts(scope_id,command_id,record) VALUES(?,?,?)').run(receipt.scopeId, receipt.commandId, this.seal(receipt));
      return { replayed: false, item: next };
    });
  }
  /**
   * S8-5 (S8-DESIGN §8, N21, N38, N44), inside the write transaction before any row: an imported skill's signature verifies under an active `import`
   * key; an AI/system author's write carries an action signature by an active `action` key bound to the event's principal, over exactly this
   * change's `catalog-action:1` bytes, and the row names that key. A person's row carries none. A key revoked before this point refuses the write.
   */
  private verifySignatures(change: AgentCatalogChange, next: AgentDefinition | SkillDefinition) {
    const { signed, receipt, event } = change, mark = next.provenance.signed, b64 = (value: string) => Buffer.from(value, 'base64');
    if ('skillId' in next && next.signature.status === 'verified') {
      const key = this.loadSigner(next.scopeId, next.signature.keyId);
      if (key?.state !== 'active' || key.purpose !== 'import'
        || !verifyEd25519(b64(key.publicKey), skillSignatureMessage({ skillId: next.skillId, contentDigest: next.contentDigest }), b64(next.signature.value))) throw new AgentCatalogError('SKILL_IMPORT_SIGNATURE_UNVERIFIED');
    }
    if (next.provenance.author.ai !== (signed !== undefined)) throw new AgentCatalogError('CATALOG_SIGNATURE_REQUIRED');
    if (!signed) return;
    const key = requireActionSigner(this.loadSigner(next.scopeId, signed.keyId), next.scopeId, event.principal), a = signed.action;
    const action = 'skillId' in next && next.source.kind === 'import' ? 'import' : 'define';
    if (a.scopeId !== next.scopeId || a.action !== action || a.target.kind !== change.kind || a.target.id !== receipt.itemId || a.target.revision !== next.revision
      || a.commandId !== receipt.commandId || a.contentDigest !== receipt.digest || a.principal.issuer !== event.principal.issuer || a.principal.subject !== event.principal.subject
      || mark?.keyId !== key.keyId || mark.signatureDigest !== sha256(signed.signature)
      || !verifyEd25519(b64(key.publicKey), signatureMessage(SIGNATURE_LABELS.catalogAction, catalogActionBytes(a)), b64(signed.signature))) throw new AgentCatalogError('CATALOG_SIGNATURE_INVALID');
  }
  private transaction<T>(work: () => T): T {
    return this.read(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        try { this.db.exec('COMMIT'); } catch { throw new AgentCatalogStoreError('AGENT_CATALOG_OUTCOME_UNKNOWN'); }
        return result;
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* A lost commit result is resolved by the same command receipt on retry. */ } throw error; }
    });
  }
  async commit(change: AgentCatalogChange) {
    const next = change.kind === 'agent' ? agentDefinitionSchema.parse(change.next) : skillDefinitionSchema.parse(change.next), { receipt } = change;
    const id = 'agentId' in next ? next.agentId : next.skillId;
    if (next.revision !== (change.previous?.revision ?? 0) + 1 || next.scopeId !== receipt.scopeId || id !== receipt.itemId || next.revision !== receipt.revision
      || change.kind !== receipt.kind) throw corrupt();
    return this.transaction(() => this.apply(change.kind, next, change));
  }
  private apply(kind: Kind, next: AgentDefinition | SkillDefinition, change: AgentCatalogChange) {
    const { receipt } = change, prior = this.loadReceipt(receipt.scopeId, receipt.commandId), t = TABLE[kind];
    if (prior) {
      const item = prior.digest === receipt.digest && prior.kind === kind ? this.load(kind, prior.scopeId, prior.itemId, prior.revision) : null;
      if (!item) throw new AgentCatalogStoreError('AGENT_CATALOG_COMMAND_CONFLICT'); return { replayed: true, item };
    }
    if (!isDeepStrictEqual(this.load(kind, next.scopeId, receipt.itemId), change.previous)) throw new AgentCatalogStoreError('AGENT_CATALOG_REVISION_CONFLICT');
    if ('agentId' in next) {
      const rows = this.db.prepare('SELECT agent_id,parent_id FROM agent_definitions WHERE scope_id=? LIMIT ?').all(next.scopeId, AGENT_CATALOG_LIMITS.agentsPerScopeMax + 1);
      const tree = new Map(rows.map(row => [String(row['agent_id']), row['parent_id'] === null ? null : String(row['parent_id'])]));
      tree.set(next.agentId, next.content.parentAgentId);
      if (tree.size > AGENT_CATALOG_LIMITS.agentsPerScopeMax) throw new AgentCatalogStoreError('AGENT_CATALOG_LIMIT');
      checkAgentOrgTree(tree, AGENT_CATALOG_LIMITS.orgTreeDepthMax);
    }
    this.verifySignatures(change, next);
    this.audit.record(change.event);
    const seq = Number(this.db.prepare(`SELECT coalesce(max(seq),0)+1 AS seq FROM ${t.current} WHERE scope_id=?`).get(next.scopeId)?.['seq']), record = this.seal(next);
    const parent = 'agentId' in next ? next.content.parentAgentId : null;
    if (change.previous) {
      if ('agentId' in next) this.db.prepare('UPDATE agent_definitions SET revision=?,parent_id=?,seq=?,record=? WHERE scope_id=? AND agent_id=? AND revision=?')
        .run(next.revision, parent, seq, record, next.scopeId, receipt.itemId, change.previous.revision);
      else this.db.prepare('UPDATE skill_definitions SET revision=?,seq=?,record=? WHERE scope_id=? AND skill_id=? AND revision=?')
        .run(next.revision, seq, record, next.scopeId, receipt.itemId, change.previous.revision);
    } else if ('agentId' in next) this.db.prepare('INSERT INTO agent_definitions(scope_id,agent_id,revision,parent_id,seq,record) VALUES(?,?,?,?,?,?)')
      .run(next.scopeId, receipt.itemId, next.revision, parent, seq, record);
    else this.db.prepare('INSERT INTO skill_definitions(scope_id,skill_id,revision,seq,record) VALUES(?,?,?,?,?)').run(next.scopeId, receipt.itemId, next.revision, seq, record);
    if ('agentId' in next) this.db.prepare('INSERT INTO agent_definition_revisions(scope_id,agent_id,revision,record) VALUES(?,?,?,?)').run(next.scopeId, receipt.itemId, next.revision, record);
    else this.db.prepare('INSERT INTO skill_definition_revisions(scope_id,skill_id,revision,content_digest,record) VALUES(?,?,?,?,?)')
      .run(next.scopeId, receipt.itemId, next.revision, next.contentDigest, record);
    for (const row of change.kind === 'agent' ? change.standings.map(value => agentStandingSchema.parse(value)) : []) {
      if (row.scopeId !== next.scopeId || row.agentId !== receipt.itemId || row.revision !== next.revision || row.standingRevision !== 1) throw corrupt();
      const sealed = this.seal(row);
      this.db.prepare('INSERT INTO agent_standings(scope_id,agent_id,revision,work_class,standing,standing_revision,record) VALUES(?,?,?,?,?,?,?)').run(row.scopeId, row.agentId, row.revision, row.workClass, row.standing, 1, sealed);
      this.db.prepare('INSERT INTO agent_standing_revisions(scope_id,agent_id,revision,work_class,standing_revision,record) VALUES(?,?,?,?,?,?)').run(row.scopeId, row.agentId, row.revision, row.workClass, 1, sealed);
    }
    this.db.prepare('INSERT INTO agent_catalog_receipts(scope_id,command_id,kind,item_id,revision,record) VALUES(?,?,?,?,?,?)')
      .run(receipt.scopeId, receipt.commandId, kind, receipt.itemId, receipt.revision, this.seal(receipt));
    return { replayed: false, item: next };
  }
  close() { this.db.close(); }
}

/** `write` opens the current ledger without migrating (the service owns backed-up upgrades); `read` opens it read-only and requires the catalog version. */
export function openSqliteAgentCatalogStore(path: string, options: SqliteLedgerOptions, integrity: IntegrityAuthority, access: 'read' | 'write'): AgentCatalogStore {
  if (access === 'write') return new SqliteAgentCatalogStore(openSqliteLedger(path, options, 'forbid'), integrity);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
  try { requireLedgerVersion(db, SIGNER_KEY_LEDGER_VERSION); return new SqliteAgentCatalogStore(db, integrity); } catch (error) { db.close(); throw error; }
}
