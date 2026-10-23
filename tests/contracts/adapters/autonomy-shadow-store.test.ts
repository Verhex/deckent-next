import { mkdtemp, readFile, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAutonomyShadowStore, AUTONOMY_SHADOW_STORE_LIMITS } from '#adapters/index.js';
import { autonomyShadowDigest, autonomyShadowRecord, autonomyShadowRecordSchema, type AutonomyShadowRecord } from '#engine/index.js';
import { deliverySummaryFixture } from '../support/delivery-summary-fixture.js';

/** OTONOM-TESLIM shadow store (alpha.53 B1, law-audit fold 1): bounded append-only JSONL outside the audit chain, one line per evaluation with its
 * own sha256, idempotent by record id, private file mode, rotation by data bounds. A damaged line is skipped on read, never trusted. */
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), 'deckent-autonomy-shadow-')); roots.push(root); return root; }
/** Records in the ad02fc7ea id format (`autonomy-shadow:<commandId>:<revision>`): such lines stay readable and are deduplicated by their ticket fields. */
const record = (commandId: string, revision: number, overrides: Partial<AutonomyShadowRecord> = {}): AutonomyShadowRecord => autonomyShadowRecordSchema.parse({
  schemaVersion: 1, id: `autonomy-shadow:${commandId}:${revision}`, at: 1000 + revision, actor: 'system', scopeId: 'scope', commandId, revision,
  rule: { id: 'autonomy', version: 1, digest: 'a'.repeat(64) }, verdict: 'would-hold', reasons: ['model-verdict-not-eligible'], summaryDigest: 'b'.repeat(64), ...overrides });
const fileOf = (root: string) => join(root, AUTONOMY_SHADOW_STORE_LIMITS.fileName);

describe('file autonomy shadow store', () => {
  it('appends one private line per record with its own digest and writes an id once', async () => {
    const root = await directory(), store = new FileAutonomyShadowStore(async () => root);
    expect(await store.append(record('q1', 4))).toBe('written');
    expect(await store.append(record('q1', 4, { at: 99_999, verdict: 'would-deliver', reasons: [] }))).toBe('exists');
    const lines = (await readFile(fileOf(root), 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ sha256: autonomyShadowDigest(record('q1', 4)), record: record('q1', 4) });
    expect((await stat(fileOf(root))).mode & 0o777).toBe(0o600);
    expect(await store.latest('scope', 'q1')).toEqual(record('q1', 4));
  });
  it('answers the highest revision of the exact scope and ticket, and null without a store (the reader creates nothing)', async () => {
    const root = await directory(), store = new FileAutonomyShadowStore(async () => root);
    await store.append(record('q1', 6)); await store.append(record('q1', 4)); await store.append(record('q2', 9));
    await store.append(record('q1', 8, { scopeId: 'other' }));
    expect(await store.latest('scope', 'q1')).toEqual(record('q1', 6));
    expect(await store.latest('scope', 'q3')).toBeNull();
    const absent = new FileAutonomyShadowStore(async () => null);
    expect(await absent.latest('scope', 'q1')).toBeNull();
    await rm(fileOf(root)); expect(await store.latest('scope', 'q1')).toBeNull(); // deleted store: no record, nothing else depends on it
    expect(await store.append(record('q1', 6))).toBe('written');
  });
  it('skips an altered or torn line on read and keeps appending after it', async () => {
    const root = await directory(), store = new FileAutonomyShadowStore(async () => root);
    await store.append(record('q1', 4)); await store.append(record('q1', 6));
    const text = await readFile(fileOf(root), 'utf8'), [first, second] = text.split('\n');
    // A forged verdict keeps valid JSON and schema but not the line digest; the torn tail has no newline.
    await writeFile(fileOf(root), `${first}\n${second!.replace('would-hold', 'would-deliver').replace('["model-verdict-not-eligible"]', '[]')}\n{"sha256":"ab`);
    expect(await store.latest('scope', 'q1')).toEqual(record('q1', 4));
    expect(await store.append(record('q1', 8))).toBe('written');
    expect(await store.latest('scope', 'q1')).toEqual(record('q1', 8));
    expect((await readFile(fileOf(root), 'utf8')).endsWith('\n')).toBe(true);
  });
  it('rotates by the data bounds: one previous file, oldest records dropped, total bytes bounded', async () => {
    const root = await directory(), line = Buffer.byteLength(JSON.stringify({ sha256: 'a'.repeat(64), record: record('q10', 10) })) + 1;
    const limits = { ...AUTONOMY_SHADOW_STORE_LIMITS, maxFileBytes: line * 3, maxFileEntries: 3 }, store = new FileAutonomyShadowStore(async () => root, limits);
    for (let index = 10; index < 20; index += 1) expect(await store.append(record(`q${index}`, index))).toBe('written');
    const files = (await readdir(root)).filter(name => name.startsWith(limits.fileName)).sort();
    expect(files).toEqual([limits.fileName, `${limits.fileName}.1`]);
    let bytes = 0; for (const name of files) bytes += (await stat(join(root, name))).size;
    expect(bytes).toBeLessThanOrEqual(limits.maxFileBytes * 2);
    expect(await store.latest('scope', 'q19')).toEqual(record('q19', 19));
    expect(await store.latest('scope', 'q16')).toEqual(record('q16', 16));
    expect(await store.latest('scope', 'q10')).toBeNull(); // rotated out
  });
  it('refuses a symbolic link in place of the store file and an over-long line', async () => {
    const root = await directory(), elsewhere = await directory(), store = new FileAutonomyShadowStore(async () => root);
    await writeFile(join(elsewhere, 'target'), ''); await symlink(join(elsewhere, 'target'), fileOf(root));
    await expect(store.append(record('q1', 4))).rejects.toThrow();
    expect(await readFile(join(elsewhere, 'target'), 'utf8')).toBe('');
    const tight = new FileAutonomyShadowStore(async () => elsewhere, { ...AUTONOMY_SHADOW_STORE_LIMITS, maxLineBytes: 64 });
    await expect(tight.append(record('q1', 4))).rejects.toThrow('AUTONOMY_SHADOW_LINE_LIMIT');
  });
});

/** REVISE 2734 R2: the queue key is scope + commandId and one store serves every scope of the product layout, so a record is identified by
 * (scope, commandId, revision); an old-format line counts for the scope its own field names and never blocks another scope. */
describe('scope-qualified shadow records', () => {
  const summary = deliverySummaryFixture(), ticket = (scopeId: string) => ({ scopeId, commandId: 'q1', revision: 4 });
  it('writes both scopes of the same command id and revision, replays each idempotently and answers each scope its own latest', async () => {
    const root = await directory(), store = new FileAutonomyShadowStore(async () => root);
    const a = autonomyShadowRecord(ticket('scope-a'), summary, 10), b = autonomyShadowRecord(ticket('scope-b'), summary, 20);
    expect(a.id).not.toBe(b.id);
    expect(await store.append(a)).toBe('written');
    expect(await store.append(b)).toBe('written');
    expect(await store.append(autonomyShadowRecord(ticket('scope-a'), summary, 30))).toBe('exists');
    expect(await store.append(autonomyShadowRecord(ticket('scope-b'), summary, 40))).toBe('exists');
    expect((await readFile(fileOf(root), 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
    expect(await store.latest('scope-a', 'q1')).toEqual(a);
    expect(await store.latest('scope-b', 'q1')).toEqual(b);
  });
  it('reads an old-format line as its own scope and never lets it block a new scope', async () => {
    const root = await directory(), store = new FileAutonomyShadowStore(async () => root);
    const legacy = autonomyShadowRecordSchema.parse({ ...autonomyShadowRecord(ticket('scope-a'), summary, 10), id: 'autonomy-shadow:q1:4' });
    await writeFile(fileOf(root), `${JSON.stringify({ sha256: autonomyShadowDigest(legacy), record: legacy })}\n`, { mode: 0o600 });
    expect(await store.latest('scope-a', 'q1')).toEqual(legacy);
    expect(await store.append(autonomyShadowRecord(ticket('scope-a'), summary, 30))).toBe('exists');
    const b = autonomyShadowRecord(ticket('scope-b'), summary, 40);
    expect(await store.append(b)).toBe('written');
    expect(await store.latest('scope-b', 'q1')).toEqual(b);
    expect(await store.latest('scope-a', 'q1')).toEqual(legacy);
  });
});
