import type { DatabaseSync } from 'node:sqlite';
import { canonicalHubJson, HUB_LIMITS } from '#domain/index.js';
import { HubServerError, type HubServiceArea, type HubServiceTransaction, type HubServerSigner } from '#engine/index.js';
import { sha256, signatureMessage } from '#platform/index.js';
import type { IntegrityAuthority } from '#platform/index.js';

export function createHubService(db: DatabaseSync) {
  db.exec(`CREATE TABLE hub_service_records(area TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(area,id)) STRICT;
    CREATE TABLE hub_service_audit(sequence INTEGER PRIMARY KEY,record TEXT NOT NULL,mac TEXT NOT NULL,key_id TEXT NOT NULL,
      public_entry INTEGER NOT NULL,signer_key_id TEXT NOT NULL,signature TEXT NOT NULL) STRICT;`);
}
/** All calls use the existing Hub writer transaction. No second connection or installation ledger. */
export class SqliteHubServiceTransaction implements HubServiceTransaction {
  constructor(private readonly db: DatabaseSync) {}
  get(area: HubServiceArea, id: string) {
    const row = this.db.prepare('SELECT record FROM hub_service_records WHERE area=? AND id=?').get(area, id);
    return row ? JSON.parse(String(row.record)) as unknown : null;
  }
  put(area: HubServiceArea, id: string, value: unknown) {
    const record = canonicalHubJson(value);
    if (Buffer.byteLength(record) > HUB_LIMITS.httpMaxBytes) throw new HubServerError('HUB_STORE_UNSAFE');
    this.db.prepare('INSERT INTO hub_service_records VALUES(?,?,?) ON CONFLICT(area,id) DO UPDATE SET record=excluded.record').run(area, id, record);
  }
  remove(area: HubServiceArea, id: string) { this.db.prepare('DELETE FROM hub_service_records WHERE area=? AND id=?').run(area, id); }
  list(area: HubServiceArea, after: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax) throw new HubServerError('HUB_STORE_UNSAFE');
    return this.db.prepare('SELECT id,record FROM hub_service_records WHERE area=? AND id>? ORDER BY id LIMIT ?').all(area, after, limit)
      .map(row => ({ id: String(row.id), value: JSON.parse(String(row.record)) as unknown }));
  }
  async audit(event: Parameters<HubServiceTransaction['audit']>[0], integrity: IntegrityAuthority, signer: HubServerSigner, publicEntry: boolean) {
    const last = this.db.prepare('SELECT sequence,record,mac,key_id FROM hub_service_audit ORDER BY sequence DESC LIMIT 1').get();
    if (last && !integrity.verify(String(last.record), String(last.mac), String(last.key_id))) throw new HubServerError('HUB_STORE_UNSAFE');
    const sequence = Number(last?.sequence ?? 0) + 1, previous = last ? String(last.mac) : null;
    const record = canonicalHubJson({ schemaVersion: 1, sequence, previous, ...event }), mac = integrity.sign(record);
    const signature = Buffer.from(await signer.sign(signatureMessage('hub-moderation-log:1', record))).toString('base64');
    this.db.prepare('INSERT INTO hub_service_audit VALUES(?,?,?,?,?,?,?)').run(sequence, record, mac, integrity.keyId, Number(publicEntry), signer.keyId, signature);
    return { sequence, digest: sha256(record), mac };
  }
  publicAuditPage(after: number, limit: number) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax) throw new HubServerError('HUB_STORE_UNSAFE');
    return this.db.prepare('SELECT record,signer_key_id,signature FROM hub_service_audit WHERE public_entry=1 AND sequence>? ORDER BY sequence LIMIT ?').all(after, limit)
      .map(row => ({ record: JSON.parse(String(row.record)) as unknown, signature: { keyId: String(row.signer_key_id), value: String(row.signature) } }));
  }
  auditPage(after: number, limit: number, integrity: IntegrityAuthority) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax) throw new HubServerError('HUB_STORE_UNSAFE');
    let previous = after === 0 ? null : this.db.prepare('SELECT mac FROM hub_service_audit WHERE sequence=?').get(after)?.mac;
    if (previous === undefined) throw new HubServerError('HUB_STORE_UNSAFE');
    return this.db.prepare('SELECT * FROM hub_service_audit WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit).map(row => {
      const record = JSON.parse(String(row.record)) as { previous: string | null };
      if (record.previous !== previous || !integrity.verify(String(row.record), String(row.mac), String(row.key_id))) throw new HubServerError('HUB_STORE_UNSAFE');
      previous = row.mac;
      return { record, mac: String(row.mac), integrityKeyId: String(row.key_id), signerKeyId: String(row.signer_key_id), signature: String(row.signature), publicEntry: Boolean(row.public_entry) };
    });
  }
}
