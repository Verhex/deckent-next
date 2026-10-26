import type { DatabaseSync } from 'node:sqlite';
import { hubRevocationFeedSchema, hubRevocationEntrySchema, HubError } from '#domain/index.js';
import { AgentCatalogStoreError, hubFeedKey, hubInstallSchema, hubSourceSchema, hubRefreshResultSchema, verifyHubRevocationFeed, type CatalogUpstream } from '#engine/index.js';

/** Read-only overlay. Retained catalog bytes and standings never change; frozen Run pins remain readable. */
export function catalogHubUpstream(db: DatabaseSync, open: (value: unknown) => unknown, scopeId: string, kind: 'agent' | 'skill', id: string, revision: number, nowMs: number, verifiedKeyIds?: readonly string[]): CatalogUpstream {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='hub_installs'").get()) return 'clear';
  let status: CatalogUpstream = 'clear';
  for (const row of db.prepare('SELECT hub_id,package_id,version,record FROM hub_installs WHERE scope_id=?').iterate(scopeId)) {
    const install = hubInstallSchema.parse(open(row.record));
    if (install.scopeId !== scopeId || install.hubId !== row.hub_id || install.packageId !== row.package_id || install.version !== row.version) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
    if (!install.items.some(item => item.kind === kind && item.id === id && item.revision === revision)) continue;
    const refresh = db.prepare("SELECT record FROM hub_client_receipts WHERE scope_id=? AND json_extract(record,'$.value.result.kind')='revocations' AND json_extract(record,'$.value.result.hubId')=? ORDER BY rowid DESC LIMIT 1").get(scopeId, install.hubId);
    const previous = refresh ? hubRefreshResultSchema.parse((open(refresh.record) as { result: unknown }).result) : null;
    if (previous && previous.hubId !== install.hubId) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
    const keyIds = install.signerKeyIds ?? verifiedKeyIds ?? previous?.packages.find(row => row.packageId === install.packageId && row.version === install.version)?.signerKeyIds;
    const targets = [...new Set([install.hubId, install.publisherKeyId, ...keyIds ?? []])].map(id => ({ kind: 'key', id }));
    targets.push({ kind: 'publisher', id: install.packageId.split('/')[0]! }, { kind: 'package-version', id: `${install.packageId}@${install.version}` });
    let yanked = false;
    for (const target of targets) {
      const entryRow = db.prepare('SELECT record FROM hub_revocation_entries WHERE scope_id=? AND hub_id=? AND kind=? AND id=?').get(scopeId, install.hubId, target.kind, target.id);
      if (!entryRow) continue;
      const value = open(entryRow.record) as { scopeId: string; hubId: string; entry: unknown }, entry = hubRevocationEntrySchema.parse(value.entry);
      if (value.scopeId !== scopeId || value.hubId !== install.hubId || entry.kind !== target.kind || entry.id !== target.id) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
      if (entry.severity === 'revoke') return 'revoked';
      yanked = true;
    }
    if (!keyIds || !verifiedKeyIds && previous?.verified === false) { status = 'withdrawn'; continue; }
    const sourceRow = db.prepare('SELECT record FROM hub_sources WHERE scope_id=? AND hub_id=?').get(scopeId, install.hubId);
    const feedRow = db.prepare('SELECT record FROM hub_revocation_snapshots WHERE scope_id=? AND hub_id=? ORDER BY sequence DESC LIMIT 1').get(scopeId, install.hubId);
    if (!sourceRow || !feedRow) { status = 'withdrawn'; continue; }
    const source = hubSourceSchema.parse(open(sourceRow.record)), feed = hubRevocationFeedSchema.parse(open(feedRow.record));
    if (source.scopeId !== scopeId || source.hubId !== install.hubId || feed.hubId !== source.hubId) throw new AgentCatalogStoreError('AGENT_CATALOG_CORRUPT');
    if (source.state !== 'active' || feed.catchup?.complete === false) { status = 'withdrawn'; continue; }
    try {
      verifyHubRevocationFeed(feed, { hubId: source.hubId, key: hubFeedKey({ hubId: source.hubId, publicKey: source.publicKey }, feed), nowMs, previous: null });
    } catch (error) {
      if (error instanceof HubError && error.code === 'HUB_FEED_STALE') { status = 'withdrawn'; continue; }
      throw error;
    }
    if (yanked && status !== 'withdrawn') {
      status = previous?.items.some(item => item.kind === kind && item.id === id && item.revision === revision && item.upstream === 'withdrawn') ? 'withdrawn' : 'yanked';
    }
  }
  return status;
}
