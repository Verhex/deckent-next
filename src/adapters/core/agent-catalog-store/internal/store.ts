import { catalogHubUpstream } from './upstream.js';
import { skillSignatureV2Message, type HubVerificationKey } from '#engine/index.js';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { agentDefinitionSchema, agentStandingSchema, catalogActionBytes, catalogActionSchema, checkAgentOrgTree, encodeCommandProjection, requireActionSigner, signerKeySchema, AgentCatalogError,
  readableSkillDefinitionSchema, AGENT_CATALOG_LIMITS, SIGNATURE_LABELS, type AgentDefinition, type AgentStanding, type SignerKey, type ReadableSkillDefinition } from '#domain/index.js';
import { AuditApplication, AgentCatalogStoreError, catalogEvolutionActions, catalogSuggestionIdOf, catalogSuggestionSchema, catalogSuggestionStateSchema, requireCatalogSuggestionDecidable, skillSignatureMessage, type AgentCatalogChange,
  type AgentCatalogReceipt, type AgentCatalogStore, type CatalogEvolutionChange, type CatalogSuggestion, type CatalogSuggestionState, type SignerChange, type StoredCatalogSuggestion } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, requireLedgerVersion, CATALOG_SUGGESTION_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { sha256, signatureMessage, verifyEd25519, type IntegrityAuthority } from '#platform/index.js';

const SEAL = 'agent-catalog-store:1';
const corrupt = () => new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT'), STANDING = 'agent_id,revision,work_class,standing,standing_revision,record';
const SUGGESTION = 'suggestion_id,kind,key_digest,state,state_revision,record,state_record';
type Kind = 'agent' | 'skill';
const TABLE = { agent: { current: 'agent_definitions', revisions: 'agent_definition_revisions', id: 'agent_id' },
  skill: { current: 'skill_definitions', revisions: 'skill_definition_revisions', id: 'skill_id' } } as const;
/**
 * Core SQLite adapter of the DB-neutral agent catalog port, on the shared ledger (v64; standings v67; signer keys v68; suggestions v70, which every read requires). Every row is sealed with the installation integrity key and
 * cross-checked against its columns on read; revisions and receipts are append-only and current rows undeletable (ledger triggers). An agent
 * commit re-checks the scope's org tree (`checkAgentOrgTree`) over the rows it holds inside the same BEGIN IMMEDIATE transaction.
 */
export class SqliteAgentCatalogStore implements AgentCatalogStore {
  private readonly audit: AuditApplication;
  constructor(protected readonly db: DatabaseSync, protected readonly integrity: IntegrityAuthority, private readonly hubImportAnchor?: { readonly scopeId: string; readonly key: HubVerificationKey }) { this.audit = new AuditApplication(new SqliteAuditStore(db), integrity); }
  protected seal(value: unknown) { return JSON.stringify({ value, keyId: this.integrity.keyId, mac: this.integrity.sign(encodeCommandProjection(SEAL, value)) }); }
  protected open(input: unknown): unknown {
    try {
      const sealed = JSON.parse(String(input)) as { value: unknown; mac: string; keyId: string };
      if (this.integrity.verify(encodeCommandProjection(SEAL, sealed.value), sealed.mac, sealed.keyId)) return sealed.value;
    } catch { /* fall through */ }
    throw corrupt();
  }
  private row<K extends Kind>(kind: K, row: Record<string, unknown>, scopeId: string): K extends 'agent' ? AgentDefinition : ReadableSkillDefinition {
    const parsed = (kind === 'agent' ? agentDefinitionSchema : readableSkillDefinitionSchema).safeParse(this.open(row['record']));
    if (!parsed.success) throw corrupt();
    const item = parsed.data as AgentDefinition | ReadableSkillDefinition, id = 'agentId' in item ? item.agentId : item.skillId;
    if (item.scopeId !== scopeId || id !== row[TABLE[kind].id] || item.revision !== row['revision']
      || ('parent_id' in row && 'agentId' in item && item.content.parentAgentId !== row['parent_id'])
      || ('content_digest' in row && 'skillId' in item && item.contentDigest !== row['content_digest'])) throw corrupt();
    return item as K extends 'agent' ? AgentDefinition : ReadableSkillDefinition;
  }
  protected read<T>(work: () => T): T {
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
  async upstream(scopeId: string, kind: 'agent' | 'skill', id: string, revision: number, nowMs = Date.now(), verifiedKeyIds?: readonly string[], revokedKeyIds?: readonly string[]) {
    return this.read(() => catalogHubUpstream(this.db, value => this.open(value), scopeId, kind, id, revision, nowMs, verifiedKeyIds, revokedKeyIds));
  }
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
  async signers(scopeId: string, limit: number) { return this.read(() => this.db.prepare("SELECT key_id,state,revision,record FROM skill_signer_keys WHERE scope_id=? ORDER BY state='active' DESC,seq LIMIT ?")
    .all(scopeId, limit).map(row => this.signerRow(row, scopeId)!)); }
  private signerRows(scopeId: string) { return this.db.prepare("SELECT key_id,state,revision,record FROM skill_signer_keys WHERE scope_id=? AND state='active'").all(scopeId).map(row => this.signerRow(row, scopeId)!); }
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
      // The bound counts active keys only (revoked rows stay forever); one active action key per bound principal, held here in the transaction.
      if (!current && Number(this.db.prepare("SELECT count(*) AS n FROM skill_signer_keys WHERE scope_id=? AND state='active'").get(next.scopeId)?.['n']) >= AGENT_CATALOG_LIMITS.signersPerScopeMax)
        throw new AgentCatalogStoreError('AGENT_CATALOG_LIMIT');
      if (!current && next.boundPrincipal && this.signerRows(next.scopeId).some(row => row.state === 'active' && row.purpose === 'action'
        && row.boundPrincipal?.issuer === next.boundPrincipal!.issuer && row.boundPrincipal.subject === next.boundPrincipal!.subject)) throw new AgentCatalogError('SKILL_SIGNER_INVALID');
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
  private verifySignatures(change: AgentCatalogChange, next: AgentDefinition | ReadableSkillDefinition) {
    const { signed, receipt, event } = change, mark = next.provenance.signed, b64 = (value: string) => Buffer.from(value, 'base64');
    if ('skillId' in next && next.signature.status === 'verified') {
      const key = this.loadSigner(next.scopeId, next.signature.keyId);
      const anchor = next.schemaVersion === 2 && this.db.isTransaction && this.hubImportAnchor?.scopeId === next.scopeId
        && this.hubImportAnchor.key.keyId === next.signature.keyId && this.hubImportAnchor.key.active && !key ? this.hubImportAnchor.key : null;
      const publicKey = key?.state === 'active' && key.purpose === 'import' ? key.publicKey : anchor?.publicKey;
      if (!publicKey
        || !verifyEd25519(b64(publicKey), (next.schemaVersion === 2 ? skillSignatureV2Message : skillSignatureMessage)({ skillId: next.skillId, contentDigest: next.contentDigest }), b64(next.signature.value))) throw new AgentCatalogError('SKILL_IMPORT_SIGNATURE_UNVERIFIED');
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
      if (this.db.isTransaction) return work(); // H2 owns the outer all-or-nothing catalog transaction.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        try { this.db.exec('COMMIT'); } catch { throw new AgentCatalogStoreError('AGENT_CATALOG_OUTCOME_UNKNOWN'); }
        return result;
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* A lost commit result is resolved by the same command receipt on retry. */ } throw error; }
    });
  }
  async commit(change: AgentCatalogChange) {
    const next = change.kind === 'agent' ? agentDefinitionSchema.parse(change.next) : readableSkillDefinitionSchema.parse(change.next), { receipt } = change;
    const id = 'agentId' in next ? next.agentId : next.skillId;
    if (next.revision !== (change.previous?.revision ?? 0) + 1 || next.scopeId !== receipt.scopeId || id !== receipt.itemId || next.revision !== receipt.revision
      || change.kind !== receipt.kind) throw corrupt();
    return this.transaction(() => this.apply(change.kind, next, change));
  }
  private apply(kind: Kind, next: AgentDefinition | ReadableSkillDefinition, change: AgentCatalogChange) {
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
    // S8-4: a define from a draft decides its suggestion in this same transaction (a person's card: no signature).
    if (change.suggestion) { this.moveSuggestion(next.scopeId, change.suggestion.previous, change.suggestion.next); if (change.suggestion.event) this.audit.record(change.suggestion.event); }
    return { replayed: false, item: next };
  }
  /** S8-3/S8-4 (v70): a sealed suggestion row and its sealed current state, cross-checked against the columns and the content-derived id. */
  private suggestionRow(row: Record<string, unknown>, scopeId: string): StoredCatalogSuggestion {
    const record = catalogSuggestionSchema.safeParse(this.open(row['record'])), state = catalogSuggestionStateSchema.safeParse(this.open(row['state_record']));
    if (!record.success || !state.success) throw corrupt();
    const { suggestionId, ...content } = record.data;
    if (record.data.scopeId !== scopeId || suggestionId !== row['suggestion_id'] || record.data.kind !== row['kind'] || record.data.keyDigest !== row['key_digest'] || catalogSuggestionIdOf(content) !== suggestionId
      || state.data.scopeId !== scopeId || state.data.suggestionId !== suggestionId || state.data.state !== row['state'] || state.data.revision !== row['state_revision']) throw corrupt();
    return { record: record.data, state: state.data };
  }
  private loadSuggestion(scopeId: string, suggestionId: string) {
    const row = this.db.prepare(`SELECT ${SUGGESTION} FROM catalog_suggestions WHERE scope_id=? AND suggestion_id=?`).get(scopeId, suggestionId);
    return row ? this.suggestionRow(row, scopeId) : null;
  }
  async suggestion(scopeId: string, suggestionId: string) { return this.read(() => this.loadSuggestion(scopeId, suggestionId)); }
  async suggestions(scopeId: string, query: { readonly keyDigest?: string; readonly open?: boolean; readonly limit: number }) {
    return this.read(() => this.db.prepare(`SELECT ${SUGGESTION} FROM catalog_suggestions WHERE scope_id=?${query.keyDigest ? ' AND key_digest=?' : ''}${query.open ? " AND state='open'" : ''}
      ORDER BY seq DESC LIMIT ?`).all(scopeId, ...(query.keyDigest ? [query.keyDigest] : []), query.limit).map(row => this.suggestionRow(row, scopeId)));
  }
  async suggestionHistory(scopeId: string, suggestionId: string) {
    return this.read(() => this.db.prepare('SELECT revision,record FROM catalog_suggestion_states WHERE scope_id=? AND suggestion_id=? ORDER BY revision LIMIT ?')
      .all(scopeId, suggestionId, AGENT_CATALOG_LIMITS.historyMax).map(row => {
        const state = catalogSuggestionStateSchema.safeParse(this.open(row['record']));
        if (!state.success || state.data.scopeId !== scopeId || state.data.suggestionId !== suggestionId || state.data.revision !== row['revision']) throw corrupt();
        return state.data;
      }));
  }
  async standingReceipt(scopeId: string, commandId: string) {
    return this.read(() => {
      const row = this.db.prepare('SELECT record FROM agent_standing_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
      const receipt = row ? this.open(row['record']) as { scopeId: string; commandId: string; digest: string; keyId: string | null } : null;
      if (receipt && (receipt.scopeId !== scopeId || receipt.commandId !== commandId)) throw corrupt();
      return receipt && { digest: receipt.digest, keyId: receipt.keyId };
    });
  }
  async signedStandings(scopeId: string, keyId: string, limit: number) {
    return this.read(() => this.db.prepare(`SELECT ${STANDING} FROM agent_standings WHERE scope_id=? AND json_extract(record,'$.value.basis.signed.keyId')=? ORDER BY agent_id,revision,work_class LIMIT ?`)
      .all(scopeId, keyId, limit).map(row => this.standing(row, scopeId)));
  }
  /** One `open` state moved once (compare-and-set on the stored state), with its kept history row. A decision or dismissal consumes it: the shared validity
   * check runs again here on the stored row and its producer key as this transaction reads them (REVISE 2742 R1); the aggregator's supersede does not. */
  private moveSuggestion(scopeId: string, previous: CatalogSuggestionState, nextInput: CatalogSuggestionState) {
    const next = catalogSuggestionStateSchema.parse(nextInput), stored = this.loadSuggestion(scopeId, next.suggestionId);
    if (!stored || next.scopeId !== scopeId || !isDeepStrictEqual(stored.state, previous) || stored.state.state !== 'open' || next.revision !== stored.state.revision + 1 || next.state === 'open')
      throw new AgentCatalogError('CATALOG_SUGGESTION_STALE');
    if (next.state !== 'superseded') requireCatalogSuggestionDecidable(stored, next.atMs, stored.state.signed ? this.loadSigner(scopeId, stored.state.signed.keyId) : null);
    const record = this.seal(next);
    this.db.prepare('UPDATE catalog_suggestions SET state=?,state_revision=?,state_record=? WHERE scope_id=? AND suggestion_id=?').run(next.state, next.revision, record, scopeId, next.suggestionId);
    this.db.prepare('INSERT INTO catalog_suggestion_states(scope_id,suggestion_id,revision,record) VALUES(?,?,?,?)').run(scopeId, next.suggestionId, next.revision, record);
    return stored.record;
  }
  async commitEvolution(change: CatalogEvolutionChange) { return this.transaction(() => this.applyEvolution(change)); }
  /**
   * S8-3/S8-4: receipt replay or conflict; CAS on every standing and suggestion state; a new suggestion's id must be its content digest and its opening
   * state present; then (AI/system) the signatures: exactly the actions `catalogEvolutionActions` derives from these rows, each by an active `action`
   * key bound to the change's principal, verified over `catalog-action:1`, and every signature mark on a row names one of them. A person's change carries none.
   */
  private applyEvolution(change: CatalogEvolutionChange) {
    const { receipt, scopeId } = change;
    if (receipt) {
      const prior = this.db.prepare('SELECT record FROM agent_standing_receipts WHERE scope_id=? AND command_id=?').get(receipt.scopeId, receipt.commandId);
      if (prior) { if ((this.open(prior['record']) as { digest: string }).digest !== receipt.digest) throw new AgentCatalogStoreError('AGENT_CATALOG_COMMAND_CONFLICT'); return { replayed: true }; }
    }
    for (const row of change.standings) {
      const next = agentStandingSchema.parse(row.next), stored = this.db.prepare(`SELECT ${STANDING} FROM agent_standings WHERE scope_id=? AND agent_id=? AND revision=? AND work_class=?`)
        .get(scopeId, next.agentId, next.revision, next.workClass);
      if (!stored || next.scopeId !== scopeId || !isDeepStrictEqual(this.standing(stored, scopeId), row.previous) || next.standingRevision !== row.previous.standingRevision + 1)
        throw new AgentCatalogError('AGENT_STANDING_CONFLICT');
    }
    const records = new Map<string, CatalogSuggestion>();
    for (const input of change.suggestions) {
      const record = catalogSuggestionSchema.parse(input), { suggestionId, ...content } = record;
      if (record.scopeId !== scopeId || catalogSuggestionIdOf(content) !== suggestionId || this.loadSuggestion(scopeId, suggestionId) || records.has(suggestionId)
        || !change.states.some(row => row.previous === null && row.next.suggestionId === suggestionId && row.next.state === 'open' && row.next.revision === 1)) throw corrupt();
      records.set(suggestionId, record);
    }
    for (const row of change.states) if (row.previous) { const stored = this.loadSuggestion(scopeId, row.next.suggestionId); if (stored) records.set(stored.record.suggestionId, stored.record); }
    else if (!records.has(row.next.suggestionId)) throw corrupt();
    this.verifyEvolution(change, records);
    for (const event of change.events) { if (event.principal.issuer !== change.principal.issuer || event.principal.subject !== change.principal.subject) throw corrupt(); this.audit.record(event); }
    for (const row of change.standings) {
      const next = agentStandingSchema.parse(row.next), sealed = this.seal(next);
      this.db.prepare('UPDATE agent_standings SET standing=?,standing_revision=?,record=? WHERE scope_id=? AND agent_id=? AND revision=? AND work_class=?')
        .run(next.standing, next.standingRevision, sealed, scopeId, next.agentId, next.revision, next.workClass);
      this.db.prepare('INSERT INTO agent_standing_revisions(scope_id,agent_id,revision,work_class,standing_revision,record) VALUES(?,?,?,?,?,?)')
        .run(scopeId, next.agentId, next.revision, next.workClass, next.standingRevision, sealed);
    }
    // N26: at most one current revision is `active` per WorkClass — of two promotions computed on the same state, the second is refused here.
    for (const workClass of new Set(change.standings.filter(row => row.next.standing === 'active').map(row => row.next.workClass)))
      if (Number(this.db.prepare(`SELECT count(*) AS n FROM agent_standings s JOIN agent_definitions d ON d.scope_id=s.scope_id AND d.agent_id=s.agent_id AND d.revision=s.revision
        WHERE s.scope_id=? AND s.work_class=? AND s.standing='active'`).get(scopeId, workClass)?.['n']) > 1) throw new AgentCatalogError('AGENT_STANDING_CONFLICT');
    for (const row of change.states) {
      if (row.previous) { this.moveSuggestion(scopeId, row.previous, row.next); continue; }
      const record = records.get(row.next.suggestionId)!, state = this.seal(catalogSuggestionStateSchema.parse(row.next));
      this.db.prepare(`INSERT INTO catalog_suggestions(scope_id,suggestion_id,kind,key_digest,state,state_revision,seq,record,state_record)
        VALUES(?,?,?,?,'open',1,(SELECT coalesce(max(seq),0)+1 FROM catalog_suggestions WHERE scope_id=?),?,?)`).run(scopeId, record.suggestionId, record.kind, record.keyDigest, scopeId, this.seal(record), state);
      this.db.prepare('INSERT INTO catalog_suggestion_states(scope_id,suggestion_id,revision,record) VALUES(?,?,1,?)').run(scopeId, record.suggestionId, state);
    }
    if (receipt) this.db.prepare('INSERT INTO agent_standing_receipts(scope_id,command_id,record) VALUES(?,?,?)')
      .run(receipt.scopeId, receipt.commandId, this.seal({ ...receipt, keyId: change.signed[0]?.keyId ?? null }));
    return { replayed: false };
  }
  private verifyEvolution(change: CatalogEvolutionChange, records: ReadonlyMap<string, CatalogSuggestion>) {
    const marks = [...change.standings.map(row => row.next.basis.signed), ...change.states.map(row => row.next.signed)].filter(mark => mark !== undefined), b64 = (value: string) => Buffer.from(value, 'base64');
    if (!change.principal.ai) { if (change.signed.length || marks.length) throw new AgentCatalogError('CATALOG_SIGNATURE_INVALID'); return; }
    const expected = catalogEvolutionActions(change, records).map(action => catalogActionSchema.parse(action));
    if (!expected.length || !isDeepStrictEqual(expected, change.signed.map(row => catalogActionSchema.parse(row.action)))) throw new AgentCatalogError('CATALOG_SIGNATURE_REQUIRED');
    for (const row of change.signed) {
      const key = requireActionSigner(this.loadSigner(change.scopeId, row.keyId), change.scopeId, change.principal);
      if (!verifyEd25519(b64(key.publicKey), signatureMessage(SIGNATURE_LABELS.catalogAction, catalogActionBytes(row.action)), b64(row.signature))) throw new AgentCatalogError('CATALOG_SIGNATURE_INVALID');
    }
    const valid = new Set(change.signed.map(row => JSON.stringify([row.keyId, sha256(row.signature)])));
    if (marks.some(mark => !valid.has(JSON.stringify([mark.keyId, mark.signatureDigest])))) throw new AgentCatalogError('CATALOG_SIGNATURE_INVALID');
  }
  close() { this.db.close(); }
}

/** `write` opens the current ledger without migrating (the service owns backed-up upgrades); `read` opens it read-only and requires the catalog version. */
export function openSqliteAgentCatalogStore(path: string, options: SqliteLedgerOptions, integrity: IntegrityAuthority, access: 'read' | 'write'): AgentCatalogStore {
  if (access === 'write') return new SqliteAgentCatalogStore(openSqliteLedger(path, options, 'forbid'), integrity);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
  try { requireLedgerVersion(db, CATALOG_SUGGESTION_LEDGER_VERSION); return new SqliteAgentCatalogStore(db, integrity); } catch (error) { db.close(); throw error; }
}
