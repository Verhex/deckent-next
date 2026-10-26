import type { DatabaseSync } from 'node:sqlite';
import { canonicalHubJson, hubEnvelopeSchema, hubPackageSchema } from '#domain/index.js';
import { artifactReceiptSchema } from '#capabilities/index.js';
import { HubServerError, hubRegisteredKeySchema, type HubServerStore, type HubServerTransaction, type HubServerSigner, type HubStoredVersion, type HubRegisteredKey, type HubReceiptEvent } from '#engine/index.js';
import { canonicalHubManifest, hubPackageFileManifest } from '#engine/index.js';
import { sha256, signatureMessage } from '#platform/index.js';

class SqliteHubTransaction implements HubServerTransaction {
  constructor(private readonly db: DatabaseSync, private readonly scopeId: string) {}
  key(keyId: string, role: HubRegisteredKey['role']): HubRegisteredKey | null {
    const row = this.db.prepare('SELECT record FROM hub_keys WHERE key_id=? AND role=?').get(keyId, role);
    return row ? hubRegisteredKeySchema.parse(JSON.parse(String(row.record))) : null;
  }
  putKey(key: HubRegisteredKey) {
    this.db.prepare('INSERT INTO hub_keys(key_id,role,record) VALUES(?,?,?) ON CONFLICT(key_id,role) DO UPDATE SET record=excluded.record')
      .run(key.keyId, key.role, canonicalHubJson(key));
  }
  get(packageId: string, version: string): HubStoredVersion | null {
    const row = this.db.prepare('SELECT manifest,envelope,files,revision FROM hub_versions WHERE package_id=? AND version=?').get(packageId, version);
    if (!row) return null;
    const manifest = hubPackageSchema.parse(JSON.parse(String(row.manifest))), envelope = hubEnvelopeSchema.parse(JSON.parse(String(row.envelope)));
    if (sha256(canonicalHubManifest(manifest)) !== envelope.payloadDigest || manifest.packageId !== packageId || manifest.version !== version) throw new HubServerError('HUB_STORE_UNSAFE');
    const raw: unknown = JSON.parse(String(row.files));
    if (!Array.isArray(raw)) throw new HubServerError('HUB_STORE_UNSAFE');
    const files = raw.map((file: { path: string; artifact: unknown }) => ({ path: file.path, artifact: artifactReceiptSchema.parse(file.artifact) }));
    const expected = hubPackageFileManifest(manifest);
    if (files.length !== expected.length || new Set(files.map(f => f.path)).size !== files.length
      || files.some(file => file.artifact.scopeId !== this.scopeId || !expected.some(e => e.path === file.path && e.size === file.artifact.byteLength && e.digest === file.artifact.digest))) throw new HubServerError('HUB_STORE_UNSAFE');
    return { manifest, envelope, files, revision: Number(row.revision) };
  }
  latest(packageId: string) {
    const row = this.db.prepare('SELECT version FROM hub_versions WHERE package_id=? ORDER BY ordinal DESC LIMIT 1').get(packageId);
    return row ? this.get(packageId, String(row.version)) : null;
  }
  insert(row: HubStoredVersion, atMs: number, publisherId: string) {
    this.db.prepare('INSERT INTO hub_versions(package_id,version,manifest,envelope,files,revision,at_ms,publisher_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.manifest.packageId, row.manifest.version, canonicalHubJson(row.manifest), canonicalHubJson(row.envelope), canonicalHubJson(row.files), row.revision, atMs, publisherId);
    for (const item of row.manifest.items) if (item.kind === 'skill') {
      const key = `${row.manifest.packageId}/${row.manifest.version}/${item.name}`;
      this.db.prepare('INSERT INTO hub_skills(key,package_id,version,skill_id) VALUES(?,?,?,?)').run(key, row.manifest.packageId, row.manifest.version, item.skillId);
    }
  }
  replaceEnvelope(packageId: string, version: string, expectedRevision: number, envelope: HubStoredVersion['envelope']) {
    const result = this.db.prepare('UPDATE hub_versions SET envelope=?,revision=revision+1 WHERE package_id=? AND version=? AND revision=?')
      .run(canonicalHubJson(envelope), packageId, version, expectedRevision);
    if (Number(result.changes) !== 1) throw new HubServerError('HUB_STORE_CONFLICT');
  }
  publishesSince(publisherId: string, atMs: number) {
    return Number(this.db.prepare('SELECT count(*) AS n FROM hub_versions WHERE publisher_id=? AND at_ms>?').get(publisherId, atMs)?.n);
  }
  skills(after: string, limit: number) {
    return this.db.prepare('SELECT key,package_id,version,skill_id FROM hub_skills WHERE key>? ORDER BY key LIMIT ?').all(after, limit)
      .map(row => ({ key: String(row.key), packageId: String(row.package_id), version: String(row.version), skillId: String(row.skill_id) }));
  }
  packages(after: string, limit: number) {
    return this.db.prepare("SELECT package_id,version,package_id||'@'||version AS key FROM hub_versions WHERE package_id||'@'||version>? ORDER BY key LIMIT ?").all(after, limit)
      .map(row => ({ key: String(row.key), packageId: String(row.package_id), version: String(row.version) }));
  }
  async appendReceipt(event: HubReceiptEvent, signer: HubServerSigner) {
    const last = this.db.prepare('SELECT sequence,digest FROM hub_receipts ORDER BY sequence DESC LIMIT 1').get();
    const sequence = Number(last?.sequence ?? 0) + 1, previous = last ? String(last.digest) : null;
    const record = canonicalHubJson({ schemaVersion: 1, sequence, previous, ...event });
    const digest = sha256(record), signature = Buffer.from(await signer.sign(signatureMessage('hub-receipt:1', record))).toString('base64');
    this.db.prepare('INSERT INTO hub_receipts(sequence,previous,digest,record,key_id,signature) VALUES(?,?,?,?,?,?)')
      .run(sequence, previous, digest, record, signer.keyId, signature);
    return { sequence, previous, digest, keyId: signer.keyId, signature };
  }
}

/** Serialize the one SQLite writer; outside reads wait so an awaited signer never exposes uncommitted rows.
 * Other adapters provide their own transactional view (for example a PostgreSQL connection).
 */
export class SqliteHubStore implements HubServerStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly view: SqliteHubTransaction;
  constructor(private readonly db: DatabaseSync, scopeId: string) { this.view = new SqliteHubTransaction(db, scopeId); }
  private serial<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.tail.then(work); this.tail = next.catch(() => undefined); return next;
  }
  transaction<T>(work: (transaction: HubServerTransaction) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try { const result = await work(this.view); this.db.exec('COMMIT'); return result; }
      catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { throw new HubServerError('HUB_STORE_OUTCOME_UNKNOWN'); }
        throw error;
      }
    });
  }
  key(keyId: string, role: HubRegisteredKey['role']) { return this.serial(() => this.view.key(keyId, role)); }
  get(packageId: string, version: string) { return this.serial(() => this.view.get(packageId, version)); }
  latest(packageId: string) { return this.serial(() => this.view.latest(packageId)); }
  publishesSince(publisherId: string, atMs: number) { return this.serial(() => this.view.publishesSince(publisherId, atMs)); }
  skills(after: string, limit: number) { return this.serial(() => this.view.skills(after, limit)); }
  packages(after: string, limit: number) { return this.serial(() => this.view.packages(after, limit)); }
}
