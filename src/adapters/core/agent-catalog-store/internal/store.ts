import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { agentDefinitionSchema, checkAgentOrgTree, encodeCommandProjection, AgentCatalogError, skillDefinitionSchema, AGENT_CATALOG_LIMITS, type AgentDefinition, type SkillDefinition } from '#domain/index.js';
import { AuditApplication, AgentCatalogStoreError, type AgentCatalogChange, type AgentCatalogReceipt, type AgentCatalogStore } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, requireLedgerVersion, AGENT_CATALOG_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { IntegrityAuthority } from '#platform/index.js';

const SEAL = 'agent-catalog-store:1';
const corrupt = () => new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
type Kind = 'agent' | 'skill';
const TABLE = { agent: { current: 'agent_definitions', revisions: 'agent_definition_revisions', id: 'agent_id' },
  skill: { current: 'skill_definitions', revisions: 'skill_definition_revisions', id: 'skill_id' } } as const;
/**
 * Core SQLite adapter of the DB-neutral agent catalog port, on the shared ledger (v64). Every row is sealed with the installation integrity key and
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
  async commit(change: AgentCatalogChange) {
    const next = change.kind === 'agent' ? agentDefinitionSchema.parse(change.next) : skillDefinitionSchema.parse(change.next), { receipt } = change;
    const id = 'agentId' in next ? next.agentId : next.skillId;
    if (next.revision !== (change.previous?.revision ?? 0) + 1 || next.scopeId !== receipt.scopeId || id !== receipt.itemId || next.revision !== receipt.revision
      || change.kind !== receipt.kind) throw corrupt();
    return this.read(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = this.apply(change.kind, next, change);
        try { this.db.exec('COMMIT'); } catch { throw new AgentCatalogStoreError('AGENT_CATALOG_OUTCOME_UNKNOWN'); }
        return result;
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* A lost commit result is resolved by the same command receipt on retry. */ } throw error; }
    });
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
  try { requireLedgerVersion(db, AGENT_CATALOG_LEDGER_VERSION); return new SqliteAgentCatalogStore(db, integrity); } catch (error) { db.close(); throw error; }
}
