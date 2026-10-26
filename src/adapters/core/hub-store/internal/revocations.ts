import type { DatabaseSync } from 'node:sqlite';
import { canonicalHubJson, hubRevocationEntrySchema, HUB_LIMITS, type HubRevocationFeed } from '#domain/index.js';
import { HubServerError } from '#engine/index.js';

export function createHubRevocations(db: DatabaseSync) {
  db.exec(`CREATE TABLE hub_revocations(kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(kind,id)) STRICT;
    CREATE TABLE hub_revocation_events(position INTEGER PRIMARY KEY,sequence INTEGER NOT NULL,record TEXT NOT NULL) STRICT;
    CREATE INDEX hub_revocation_sequence ON hub_revocation_events(sequence,position);
    CREATE INDEX hub_revocation_command ON hub_receipts(json_extract(record,'$.commandId'));
    CREATE TRIGGER hub_revocation_no_update BEFORE UPDATE ON hub_revocation_events BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;
    CREATE TRIGGER hub_revocation_no_delete BEFORE DELETE ON hub_revocation_events BEGIN SELECT RAISE(ABORT,'HUB_APPEND_ONLY'); END;`);
}
export function recordHubRevocations(db: DatabaseSync, feed: HubRevocationFeed) {
  for (const entry of feed.entries) {
    const record = canonicalHubJson(entry);
    db.prepare('INSERT INTO hub_revocation_events(sequence,record) VALUES(?,?)').run(feed.sequence, record);
    db.prepare(`INSERT INTO hub_revocations(kind,id,record) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record
      WHERE json_extract(hub_revocations.record,'$.severity')!='revoke'
      AND (json_extract(excluded.record,'$.severity')='revoke' OR json_extract(excluded.record,'$.atMs')>=json_extract(hub_revocations.record,'$.atMs'))`)
      .run(entry.kind, entry.id, record);
  }
}
export function hubRevocations(db: DatabaseSync, targets: readonly Pick<HubRevocationFeed['entries'][number], 'kind' | 'id'>[]) {
  return targets.flatMap(target => {
    const row = db.prepare('SELECT record FROM hub_revocations WHERE kind=? AND id=?').get(target.kind, target.id);
    if (!row) return [];
    const entry = hubRevocationEntrySchema.parse(JSON.parse(String(row.record)));
    if (entry.kind !== target.kind || entry.id !== target.id) throw new HubServerError('HUB_STORE_UNSAFE');
    return [entry];
  });
}
export function hubRevocationPage(db: DatabaseSync, afterSequence: number, throughSequence: number, position?: number, throughPosition?: number) {
  position ??= Number(db.prepare('SELECT coalesce(max(position),0) AS n FROM hub_revocation_events WHERE sequence<=?').get(afterSequence)?.n);
  throughPosition ??= Number(db.prepare('SELECT coalesce(max(position),0) AS n FROM hub_revocation_events WHERE sequence<=?').get(throughSequence)?.n);
  const rows = db.prepare('SELECT position,record FROM hub_revocation_events WHERE position>? AND position<=? ORDER BY position LIMIT ?')
    .all(position, throughPosition, HUB_LIMITS.feedPageMax + 1);
  const page = rows.slice(0, HUB_LIMITS.feedPageMax);
  return { position, throughPosition, entries: page.map(row => hubRevocationEntrySchema.parse(JSON.parse(String(row.record)))),
    nextPosition: rows.length > page.length ? Number(page.at(-1)!.position) : null };
}
