import { backup, DatabaseSync } from 'node:sqlite';
import { chmod, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHmacIntegrity, resolveProductLayout, productResourcePath, sha256, type ProductLayout } from '#platform/index.js';
import { type BackupResult } from '#engine/index.js';
import { BACKUP_RESOURCES, archiveState, unpackState, type BackupConfigLayers, type BackupLimits, type BackupState } from './archive.js';
import { decryptKey, encryptKey } from './crypto.js';
import { ledgerFingerprint } from './fingerprint.js';
import { digestFile, inside, privateDirectory, readPrivate, refuse, safePath, syncDirectory, writePrivate } from './files.js';
const SOURCE_BUSY_BUDGET = 1000;
const PAYLOAD = ['ledger.db', 'ledger.fingerprint.json', 'state.archive.json.gz'] as const;
const FILES = [...PAYLOAD, 'authority.key.enc'] as const;
const manifestLine = (digest: string, name: string) => `${digest}  ${name}\n`;
export class VerifiedBackup {
  readonly #key: Buffer;
  constructor(readonly set: string, readonly state: BackupState, readonly ledgerDigest: string, key: Buffer) { this.#key = key; }
  integrity() { return createHmacIntegrity(sha256(this.#key.toString('hex')), this.#key); }
  async restoreKey(path: string) { await writePrivate(path, this.#key); }
  close() { this.#key.fill(0); }
  result(action: BackupResult['action']): BackupResult { return { schemaVersion: 1, action, set: this.set, ledgerDigest: this.ledgerDigest,
    files: this.state.entries.length, createdAt: this.state.createdAt, relocation: null, globalConfig: null, preserved: [] }; }
}
export async function verifyBackupSet(set: string, passphrase: string, limits: BackupLimits): Promise<VerifiedBackup> {
  await safePath(set); await privateDirectoryExisting(set);
  const text = (await readPrivate(join(set, 'MANIFEST.sha256'), 4096)).toString('utf8');
  const expected = new Map<string, string>();
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9.-]+)$/.exec(line);
    if (!match || expected.has(match[2]!) || !(FILES as readonly string[]).includes(match[2]!)) return refuse('BACKUP_MANIFEST_INVALID');
    expected.set(match[2]!, match[1]!);
  }
  if (expected.size !== FILES.length) return refuse('BACKUP_MANIFEST_INVALID');
  const payload: string[] = [];
  for (const name of FILES) {
    const file = join(set, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) return refuse('BACKUP_PATH_UNSAFE');
    if (info.size > limits.maxTotalBytes * 2) return refuse('BACKUP_LIMIT');
    const digest = await digestFile(file);
    if (digest !== expected.get(name)) return refuse('BACKUP_MANIFEST_INVALID');
    if ((PAYLOAD as readonly string[]).includes(name)) payload.push(manifestLine(digest, name));
  }
  const envelope = await readPrivate(join(set, 'authority.key.enc'), 4096);
  const { createHash } = await import('node:crypto');
  if (createHash('sha256').update(envelope).digest('hex') !== expected.get('authority.key.enc')) return refuse('BACKUP_MANIFEST_INVALID');
  const key = await decryptKey(envelope.toString('utf8'), passphrase, payload.join(''));
  try {
    const fingerprintBytes = await readPrivate(join(set, 'ledger.fingerprint.json'), limits.maxFileBytes);
    if (createHash('sha256').update(fingerprintBytes).digest('hex') !== expected.get('ledger.fingerprint.json')) return refuse('BACKUP_MANIFEST_INVALID');
    const fingerprint = fingerprintBytes.toString('utf8');
    if (fingerprint !== ledgerFingerprint(join(set, 'ledger.db'))) return refuse('BACKUP_FINGERPRINT_INVALID');
    const archive = await readPrivate(join(set, 'state.archive.json.gz'), limits.maxTotalBytes * 2);
    if (createHash('sha256').update(archive).digest('hex') !== expected.get('state.archive.json.gz')) return refuse('BACKUP_MANIFEST_INVALID');
    const state = unpackState(archive, limits);
    const resources = Object.fromEntries(Object.entries(state.resources).filter(([name]) => !['config', 'projectIdentity', 'installationJournal'].includes(name)));
    resolveProductLayout({ projectRoot: state.projectRoot, root: state.layoutRoot, resources });
    const identity = state.entries.find(item => item.resource === 'installationIdentity' && item.path === 'identity.json');
    if (!identity || JSON.parse(Buffer.from(identity.content, 'base64').toString('utf8')).installationId !== state.installationId) return refuse('BACKUP_SET_INVALID');
    return new VerifiedBackup(resolve(set), state, expected.get('ledger.db')!, key);
  } catch (error) { key.fill(0); throw error; }
}
async function privateDirectoryExisting(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) return refuse('BACKUP_PATH_UNSAFE');
}
export async function createBackupSet(layout: ProductLayout, projectRoot: string, installationId: string, keyFile: string,
  destination: string, passphrase: string, limits: BackupLimits, config?: BackupConfigLayers): Promise<BackupResult> {
  const set = await safePath(destination);
  for (const resource of BACKUP_RESOURCES) if (inside(productResourcePath(layout, resource), set)) return refuse('BACKUP_PATH_UNSAFE');
  if ((inside(layout.root, set) && !inside(productResourcePath(layout, 'ledgerBackups'), set)) || (inside(join(projectRoot, '.deckent'), set) && !inside(productResourcePath(layout, 'ledgerBackups'), set))) return refuse('BACKUP_PATH_UNSAFE');
  if (await lstat(set).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) return refuse('BACKUP_SET_EXISTS');
  await privateDirectory(dirname(set));
  const staging = join(dirname(set), `.backup-staging-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
  const createdAt = new Date().toISOString();
  try {
    const sourcePath = await safePath(productResourcePath(layout, 'ledger'));
    const info = await lstat(sourcePath);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) return refuse('BACKUP_PATH_UNSAFE');
    const db = new DatabaseSync(sourcePath, { readOnly: true, timeout: SOURCE_BUSY_BUDGET });
    const ledger = join(staging, 'ledger.db');
    await writePrivate(ledger, new Uint8Array()); // 0600 before the backup API opens its output.
    const deadline = Date.now() + 60000;
    try { await backup(db, ledger, { rate: 1000, progress({ totalPages }) { if (totalPages * Number(db.prepare('PRAGMA page_size').get()?.['page_size']) > limits.maxTotalBytes) return refuse('BACKUP_LIMIT'); if (Date.now() > deadline) return refuse('BACKUP_TIMEOUT'); return 1000; } }); }
    finally { db.close(); }
    await chmod(ledger, 0o600);
    // S1 O6: the snapshot keeps the source's WAL header; as rollback-journal file it is self-contained and no reader creates sidecars.
    const snapshot = new DatabaseSync(ledger); try { snapshot.exec('PRAGMA journal_mode=DELETE'); } finally { snapshot.close(); }
    const ledgerHandle = await import('node:fs/promises').then(fs => fs.open(ledger, 'r')); try { await ledgerHandle.sync(); } finally { await ledgerHandle.close(); }
    await writePrivate(join(staging, 'ledger.fingerprint.json'), ledgerFingerprint(ledger));
    await writePrivate(join(staging, 'state.archive.json.gz'), await archiveState(layout, projectRoot, installationId, keyFile, limits, createdAt, config));
    const payload: string[] = [];
    for (const name of PAYLOAD) payload.push(manifestLine(await digestFile(join(staging, name)), name));
    const material = await readPrivate(join(productResourcePath(layout, 'approvals'), keyFile), 32);
    try { await writePrivate(join(staging, 'authority.key.enc'), await encryptKey(material, passphrase, payload.join(''))); }
    finally { material.fill(0); }
    await writePrivate(join(staging, 'MANIFEST.sha256'), payload.join('') + manifestLine(await digestFile(join(staging, 'authority.key.enc')), 'authority.key.enc'));
    const verified = await verifyBackupSet(staging, passphrase, limits);
    const result = { ...verified.result('create'), set }; verified.close();
    // Staging is private, sibling and fully verified; a partial set is never published.
    if (await lstat(set).catch(() => null)) return refuse('BACKUP_SET_EXISTS');
    await rename(staging, set); await syncDirectory(dirname(set)); return result;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
