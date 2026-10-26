import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EffectError, effectIntentSchema, effectRecordSchema, type EffectIntent, type EffectRecord } from '#domain/index.js';
import type { EffectStore } from '#engine/index.js';
import type { IntegrityAuthority } from '#platform/index.js';
import { acquireLedgerLock } from '#adapters/core/local-runtime-socket/index.js';
export interface FileEffectStoreBounds { readonly maxBytes: number; readonly maxRecords: number }
const PRIVATE_PERMISSION_MASK = 0o077;
const bodySchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative().safe(), records: z.array(effectRecordSchema) }).strict();
type Body = z.infer<typeof bodySchema>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const fail = (): never => { throw new EffectError('EFFECT_CORRUPT'); };
/** Reusable generic effect store. Kernel custody serializes claim/CAS; sealed atomic snapshots survive deletion of the business ledger. */
export class FileEffectStore implements EffectStore {
  private readonly file: string;
  constructor(private readonly root: string, private readonly integrity: IntegrityAuthority, private readonly bounds: FileEffectStoreBounds) {
    if (process.platform !== 'linux' || !process.getuid || typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') throw new EffectError('EFFECT_TARGET_UNAVAILABLE');
    if (!isAbsolute(root) || resolve(root) !== root || !Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1
      || !Number.isSafeInteger(bounds.maxRecords) || bounds.maxRecords < 1) throw new EffectError('EFFECT_INVALID');
    this.file = join(root, 'effects.json');
  }
  private async directory() {
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & PRIVATE_PERMISSION_MASK) || await realpath(this.root) !== this.root) fail();
  }
  /** Explicit admission-only initialization, never called by load/preview. Missing stores on recovery are corruption, not empty truth. */
  async initialize() {
    const parent = await lstat(dirname(this.root));
    if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(dirname(this.root)) !== dirname(this.root)) fail();
    await mkdir(this.root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const parentHandle = await open(dirname(this.root), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    await this.directory(); const lock = acquireLedgerLock(join(this.root, 'effects.lock'));
    try {
      const existing = await lstat(this.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) { await this.read(); return; }
      await this.write({ schemaVersion: 1, revision: 0, records: [] });
    } finally { lock.release(); }
  }
  private async read(): Promise<Body> {
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch(cause => { throw new EffectError('EFFECT_CORRUPT', { cause }); });
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & PRIVATE_PERMISSION_MASK) || before.size > this.bounds.maxBytes) fail();
      const bytes = Buffer.alloc(before.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), after = await handle.stat();
      if (bytesRead !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
      const sealed = z.object({ body: bodySchema, keyId: z.string(), mac: z.string() }).strict().parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
      if (!this.integrity.verify(JSON.stringify(sealed.body), sealed.mac, sealed.keyId) || sealed.body.records.length > this.bounds.maxRecords) fail();
      const commands = new Set<string>(), keys = new Set<string>();
      for (const record of sealed.body.records) {
        const command = record.intent.command, commandKey = JSON.stringify([command.scopeId, command.commandId]), key = JSON.stringify([command.scopeId, record.intent.idempotencyKeyHash]);
        if (commands.has(commandKey) || keys.has(key)) fail(); commands.add(commandKey); keys.add(key);
      }
      return sealed.body;
    } catch (error) { if (error instanceof EffectError) throw error; throw new EffectError('EFFECT_CORRUPT', { cause: error }); }
    finally { await handle.close(); }
  }
  private async write(body: Body) {
    if (!Number.isSafeInteger(body.revision)) throw new EffectError('EFFECT_REJECTED');
    const encoded = JSON.stringify({ body, keyId: this.integrity.keyId, mac: this.integrity.sign(JSON.stringify(body)) });
    if (Buffer.byteLength(encoded) > this.bounds.maxBytes || body.records.length > this.bounds.maxRecords) throw new EffectError('EFFECT_REJECTED');
    const temporary = join(this.root, `${randomUUID()}.tmp`); let published = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file); published = true;
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (cause) { throw new EffectError(published ? 'EFFECT_OUTCOME_UNKNOWN' : 'EFFECT_TARGET_UNAVAILABLE', { cause }); }
    finally { if (!published) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  private async transaction<T>(work: (body: Body) => Promise<T>): Promise<T> {
    await this.directory(); const lock = acquireLedgerLock(join(this.root, 'effects.lock'));
    try { return await work(await this.read()); } finally { lock.release(); }
  }
  async loadEffect(scopeId: string, commandId: string) {
    return this.transaction(async body => body.records.find(record => record.intent.command.scopeId === scopeId && record.intent.command.commandId === commandId) ?? null);
  }
  async claimEffect(input: EffectIntent): Promise<EffectRecord> {
    const intent = effectIntentSchema.parse(input);
    return this.transaction(async body => {
      const { scopeId, commandId, target } = intent.command;
      const existing = body.records.find(record => record.intent.command.scopeId === scopeId && record.intent.command.commandId === commandId);
      if (existing) { if (!same(existing.intent, intent)) throw new EffectError('EFFECT_CONFLICT'); return existing; }
      if (!intent.producer) throw new EffectError('EFFECT_INVALID');
      if (body.records.some(record => record.intent.command.scopeId === scopeId && record.intent.idempotencyKeyHash === intent.idempotencyKeyHash)) throw new EffectError('EFFECT_CONFLICT');
      const targetRecords = body.records.filter(record => same(record.intent.command.target, target));
      if (targetRecords.some(record => record.state === 'claimed' || record.state === 'unknown')) throw new EffectError('EFFECT_TARGET_BUSY');
      const sequence = Math.max(0, ...targetRecords.map(record => record.sequence)) + 1;
      const record = effectRecordSchema.parse({ intent, sequence, state: 'claimed', evidence: null, refusal: null });
      await this.write({ ...body, revision: body.revision + 1, records: [...body.records, record] }); return record;
    });
  }
  async saveEffect(previousInput: EffectRecord, nextInput: EffectRecord): Promise<EffectRecord> {
    const previous = effectRecordSchema.parse(previousInput), next = effectRecordSchema.parse(nextInput);
    if (!same(previous.intent, next.intent) || previous.sequence !== next.sequence || previous.state === 'settled' || previous.state === 'refused'
      || next.state === 'claimed' || (previous.state === 'unknown' && next.state === 'refused')) throw new EffectError('EFFECT_CONFLICT');
    return this.transaction(async body => {
      const index = body.records.findIndex(record => same(record, previous));
      if (index < 0) throw new EffectError('EFFECT_CONFLICT');
      const records = [...body.records]; records[index] = next;
      await this.write({ ...body, revision: body.revision + 1, records }); return next;
    });
  }
}
