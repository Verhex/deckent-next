import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HUB_LIMITS, identitySchema } from '#domain/index.js';
import { HubServerError } from '#engine/index.js';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import { SqliteHubStore } from './store.js';

// Application id and user_version identify this database, independently of the installation ledger.
const APPLICATION_ID = 0x44485542, SCHEMA_VERSION = 1;
function directory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || realpathSync(path) !== path)
    throw new HubServerError('HUB_STORE_UNSAFE');
}
/** POSIX trusted-host adapter. H9 must put root outside installation data/keys and enforce process separation with OS permissions. */
export function openHubStore(input: { readonly root: string; readonly scopeId: string; readonly hubId: string; readonly busyTimeoutMs: number }) {
  if (process.platform === 'win32' || !process.getuid || !constants.O_NOFOLLOW) throw new HubServerError('HUB_STORE_UNSUPPORTED');
  const scopeId = identitySchema.parse(input.scopeId);
  if (!isAbsolute(input.root) || !/^[a-f0-9]{64}$/.test(input.hubId) || !Number.isSafeInteger(input.busyTimeoutMs) || input.busyTimeoutMs < 0)
    throw new HubServerError('HUB_STORE_UNSAFE');
  const root = resolve(input.root); directory(root);
  const blobs = join(root, 'blobs');
  try { mkdirSync(blobs, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  directory(blobs);
  const path = join(root, 'hub.sqlite');
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new HubServerError('HUB_STORE_UNSAFE');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new HubServerError('HUB_STORE_UNSAFE');
  } finally { closeSync(fd); }
  // SQLite opens by path; the private parent directory is trusted-host custody, not an openat sandbox.
  const { DatabaseSync: NativeDatabase } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new NativeDatabase(path, { timeout: input.busyTimeoutMs, enableForeignKeyConstraints: true, allowExtension: false });
    db.exec('BEGIN IMMEDIATE');
    const app = Number(db.prepare('PRAGMA application_id').get()?.application_id), version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (app === 0 && version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() === undefined) {
      db.exec(`CREATE TABLE hub_identity(hub_id TEXT NOT NULL,scope_id TEXT NOT NULL) STRICT;
        CREATE TABLE hub_keys(key_id TEXT NOT NULL,role TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(key_id,role)) STRICT;
        CREATE TABLE hub_versions(ordinal INTEGER PRIMARY KEY,package_id TEXT NOT NULL,version TEXT NOT NULL,manifest TEXT NOT NULL,envelope TEXT NOT NULL,
          files TEXT NOT NULL,revision INTEGER NOT NULL,at_ms INTEGER NOT NULL,publisher_id TEXT NOT NULL,UNIQUE(package_id,version)) STRICT;
        CREATE TABLE hub_skills(key TEXT PRIMARY KEY,package_id TEXT NOT NULL,version TEXT NOT NULL,skill_id TEXT NOT NULL,
          FOREIGN KEY(package_id,version) REFERENCES hub_versions(package_id,version)) STRICT;
        CREATE TABLE hub_receipts(sequence INTEGER PRIMARY KEY,previous TEXT,digest TEXT NOT NULL,record TEXT NOT NULL,key_id TEXT NOT NULL,signature TEXT NOT NULL) STRICT;
        CREATE INDEX hub_publish_rate ON hub_versions(publisher_id,at_ms);
        PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION};`);
      db.prepare('INSERT INTO hub_identity VALUES(?,?)').run(input.hubId, scopeId);
    } else if (app !== APPLICATION_ID || version !== SCHEMA_VERSION) throw new HubServerError('HUB_STORE_UNSAFE');
    const identity = db.prepare('SELECT hub_id,scope_id FROM hub_identity').all();
    if (identity.length !== 1 || identity[0]?.hub_id !== input.hubId || identity[0]?.scope_id !== scopeId) throw new HubServerError('HUB_STORE_UNSAFE');
    db.exec('COMMIT');
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const opened = db;
    return { store: new SqliteHubStore(opened, scopeId), artifacts: new FileArtifactStore({ root: blobs, maxBytes: HUB_LIMITS.packageMaxBytes }), close: () => opened.close() };
  } catch (error) {
    if (db) { try { db.exec('ROLLBACK'); } catch { /* No active transaction after commit. */ } db.close(); }
    if (error instanceof HubServerError) throw error;
    throw new HubServerError('HUB_STORE_UNSAFE');
  }
}
