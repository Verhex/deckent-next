import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { hubRevocationFeedSchema, HubError, HUB_LIMITS, type AuditEvent, type HubRevocationFeed } from '#domain/index.js';
import type { HubVerificationKey } from '#engine/index.js';
import { AuditApplication } from '#engine/index.js';
import { HubClientError, hubInstallSchema, hubSourceSchema, type HubClientStore, type HubInstall, type HubReceipt, type HubSource } from '#engine/index.js';
import { SqliteAgentCatalogStore } from '#adapters/core/agent-catalog-store/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openSqliteLedger, requireLedgerVersion, HUB_CLIENT_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
const corrupt = () => new HubClientError('HUB_STORE_CORRUPT');
class Store extends SqliteAgentCatalogStore implements HubClientStore {
  async atomic<T>(work: () => Promise<T>): Promise<T> {
    if (this.db.isTransaction) throw new HubClientError('HUB_INSTALL_CONFLICT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await work();
      try { this.db.exec('COMMIT'); } catch { throw new HubClientError('HUB_OUTCOME_UNKNOWN'); }
      return result;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* Receipt resolves a lost commit acknowledgement. */ } throw error; }
  }
  borrowCatalog(anchor?: { readonly scopeId: string; readonly key: HubVerificationKey }) {
    class Borrowed extends SqliteAgentCatalogStore { override close() { /* Outer Hub owner closes. */ } }
    if (!this.db.isTransaction) throw corrupt();
    return new Borrowed(this.db, this.integrity, anchor);
  }
  async source(scopeId: string, hubId: string) {
    const row = this.db.prepare('SELECT revision,state,record FROM hub_sources WHERE scope_id=? AND hub_id=?').get(scopeId, hubId);
    if (!row) return null;
    const parsed = hubSourceSchema.safeParse(this.open(row['record']));
    if (!parsed.success || parsed.data.scopeId !== scopeId || parsed.data.hubId !== hubId || parsed.data.revision !== row['revision'] || parsed.data.state !== row['state']) throw corrupt();
    return parsed.data;
  }
  async sources(scopeId: string) {
    const rows = this.db.prepare("SELECT hub_id FROM hub_sources WHERE scope_id=? AND state='active' ORDER BY hub_id LIMIT ?").all(scopeId, HUB_LIMITS.sourcesPerScopeMax + 1);
    if (rows.length > HUB_LIMITS.sourcesPerScopeMax) throw corrupt();
    return Promise.all(rows.map(async row => (await this.source(scopeId, String(row['hub_id'])))!));
  }
  async saveSource(previous: HubSource | null, next: HubSource) {
    hubSourceSchema.parse(next);
    if (!this.db.isTransaction || !isDeepStrictEqual(await this.source(next.scopeId, next.hubId), previous) || next.revision !== (previous?.revision ?? 0) + 1) throw new HubClientError('HUB_INSTALL_CONFLICT');
    if (next.state === 'active' && previous?.state !== 'active' && (await this.sources(next.scopeId)).length >= HUB_LIMITS.sourcesPerScopeMax) throw new HubError('HUB_LIMIT_EXCEEDED');
    this.db.prepare(`INSERT INTO hub_sources(scope_id,hub_id,state,revision,record) VALUES(?,?,?,?,?) ON CONFLICT(scope_id,hub_id)
      DO UPDATE SET state=excluded.state,revision=excluded.revision,record=excluded.record`).run(next.scopeId, next.hubId, next.state, next.revision, this.seal(next));
  }
  async install(scopeId: string, hubId: string, packageId: string, version?: string) {
    const row = this.db.prepare(`SELECT version,state,revision,record FROM hub_installs WHERE scope_id=? AND hub_id=? AND package_id=?${version ? ' AND version=?' : ''} ORDER BY seq DESC LIMIT 1`)
      .get(scopeId, hubId, packageId, ...(version ? [version] : []));
    if (!row) return null;
    const parsed = hubInstallSchema.safeParse(this.open(row['record']));
    if (!parsed.success || parsed.data.scopeId !== scopeId || parsed.data.hubId !== hubId || parsed.data.packageId !== packageId || parsed.data.version !== row['version']
      || parsed.data.state !== row['state'] || parsed.data.revision !== row['revision'] || parsed.data.bundle.scopeId !== scopeId) throw corrupt();
    return parsed.data;
  }
  async saveInstall(previous: HubInstall | null, next: HubInstall) {
    hubInstallSchema.parse(next);
    if (previous && (previous.state !== 'installed' || next.state !== 'retired' || !isDeepStrictEqual({ ...previous, state: next.state, revision: next.revision }, next))) throw new HubClientError('HUB_INSTALL_CONFLICT');
    if (!this.db.isTransaction || !isDeepStrictEqual(await this.install(next.scopeId, next.hubId, next.packageId, next.version), previous)
      || next.revision !== (previous?.revision ?? 0) + 1) throw new HubClientError('HUB_INSTALL_CONFLICT');
    this.db.prepare(`INSERT INTO hub_installs(scope_id,hub_id,package_id,version,state,revision,seq,record)
      VALUES(?,?,?,?,?,?,(SELECT coalesce(max(seq),0)+1 FROM hub_installs WHERE scope_id=?),?) ON CONFLICT(scope_id,hub_id,package_id,version)
      DO UPDATE SET state=excluded.state,revision=excluded.revision,record=excluded.record`).run(next.scopeId, next.hubId, next.packageId, next.version, next.state, next.revision, next.scopeId, this.seal(next));
  }
  private retainedInstalls() {
    return this.db.prepare('SELECT scope_id,hub_id,package_id,version FROM hub_installs ORDER BY scope_id,seq').all();
  }
  async retainedArtifacts() {
    const receipts = [];
    for (const row of this.retainedInstalls()) receipts.push((await this.install(String(row['scope_id']), String(row['hub_id']), String(row['package_id']), String(row['version'])))!.bundle);
    return receipts;
  }
  async skillBundle(scopeId: string, skillId: string, revision: number, digest: string) {
    for (const row of this.retainedInstalls().filter(row => row['scope_id'] === scopeId)) {
      const installed = (await this.install(scopeId, String(row['hub_id']), String(row['package_id']), String(row['version'])))!;
      if (installed.items.some(item => item.kind === 'skill' && item.id === skillId && item.revision === revision && item.digest === digest)) return installed.bundle;
    }
    return null;
  }
  async feed(scopeId: string, hubId: string) {
    const row = this.db.prepare('SELECT sequence,record FROM hub_revocation_snapshots WHERE scope_id=? AND hub_id=? ORDER BY sequence DESC LIMIT 1').get(scopeId, hubId);
    if (!row) return null;
    const parsed = hubRevocationFeedSchema.safeParse(this.open(row['record']));
    if (!parsed.success || parsed.data.hubId !== hubId || parsed.data.sequence !== row['sequence']) throw corrupt();
    return parsed.data;
  }
  async revocations(scopeId: string, hubId: string, targets: readonly Pick<HubRevocationFeed['entries'][number], 'kind' | 'id'>[]) {
    return targets.flatMap(target => {
      const row = this.db.prepare('SELECT record FROM hub_revocation_entries WHERE scope_id=? AND hub_id=? AND kind=? AND id=?').get(scopeId, hubId, target.kind, target.id);
      if (!row) return [];
      const value = this.open(row['record']) as { scopeId: string; hubId: string; entry: HubRevocationFeed['entries'][number] };
      if (value.scopeId !== scopeId || value.hubId !== hubId || value.entry.kind !== target.kind || value.entry.id !== target.id) throw corrupt();
      return [value.entry];
    });
  }
  async saveFeed(scopeId: string, feed: HubRevocationFeed) {
    if (!this.db.isTransaction) throw corrupt();
    const previousFeed = await this.feed(scopeId, feed.hubId);
    if (previousFeed && (feed.sequence <= previousFeed.sequence || feed.issuedAtMs < previousFeed.issuedAtMs)) throw new HubError('HUB_FEED_REPLAYED');
    this.db.prepare('INSERT INTO hub_revocation_snapshots(scope_id,hub_id,sequence,record) VALUES(?,?,?,?)').run(scopeId, feed.hubId, feed.sequence, this.seal(feed));
    for (const entry of feed.entries) {
      const previous = (await this.revocations(scopeId, feed.hubId, [entry]))[0];
      if (previous?.severity === 'revoke' || previous && previous.atMs > entry.atMs) continue;
      this.db.prepare(`INSERT INTO hub_revocation_entries(scope_id,hub_id,kind,id,record) VALUES(?,?,?,?,?)
        ON CONFLICT(scope_id,hub_id,kind,id) DO UPDATE SET record=excluded.record`).run(scopeId, feed.hubId, entry.kind, entry.id, this.seal({ scopeId, hubId: feed.hubId, entry }));
    }
  }
  async hubReceipt(scopeId: string, commandId: string): Promise<HubReceipt | null> {
    const row = this.db.prepare('SELECT record FROM hub_client_receipts WHERE scope_id=? AND command_id=?').get(scopeId, commandId);
    if (!row) return null;
    const value = this.open(row['record']) as HubReceipt;
    if (value.scopeId !== scopeId || value.commandId !== commandId || !/^[a-f0-9]{64}$/.test(value.digest)) throw corrupt();
    const result = Array.isArray(value.result) ? value.result.map(row => hubInstallSchema.parse(row)) : hubSourceSchema.parse(value.result);
    if (Array.isArray(result) ? result.some(row => row.scopeId !== scopeId) : result.scopeId !== scopeId) throw corrupt();
    return { ...value, result };
  }
  async finish(receipt: HubReceipt, event: AuditEvent) {
    if (!this.db.isTransaction || event.scopeId !== receipt.scopeId) throw corrupt();
    new AuditApplication(new SqliteAuditStore(this.db), this.integrity).record(event);
    this.db.prepare('INSERT INTO hub_client_receipts(scope_id,command_id,record) VALUES(?,?,?)').run(receipt.scopeId, receipt.commandId, this.seal(receipt));
  }
}
export function openSqliteHubClientStore(path: string, options: SqliteLedgerOptions, integrity: IntegrityAuthority, access: 'read' | 'write'): HubClientStore {
  if (access === 'write') return new Store(openSqliteLedger(path, options, 'forbid'), integrity);
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new NativeDatabase(path, { readOnly: true, timeout: options.busyTimeoutMs });
  try { requireLedgerVersion(db, HUB_CLIENT_LEDGER_VERSION); return new Store(db, integrity); } catch (error) { db.close(); throw error; }
}
