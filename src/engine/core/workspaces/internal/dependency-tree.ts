import { createHash } from 'node:crypto';
import { z } from 'zod';
import BINARIES from './dependency-binaries.json' with { type: 'json' };
import { embeddedArchive } from './embedded-archive.js';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const cacheSchema = z.object({ schemaVersion: z.literal(1), scope: digestSchema,
  files: z.record(z.string().min(1).max(BINARIES.maxCachePathLength), z.tuple([digestSchema, z.string().min(1).max(600).nullable()])) }).strict();
const signatures = BINARIES.signatures.map(row => ({ kind: row.kind, bytes: Buffer.from(row.hex, 'hex') }));
/** The lifting entry of every exception a declared dependency tree records: `dependencyTree:<container target>`. */
export const dependencyTreeLifting = (target: string) => `dependencyTree:${target}`;
/** Per declared dependency tree of one scan: pattern results reused from the cache and evaluated anew, and whether the cache was saved. */
export interface DependencyTreeStatistics { readonly label: string; readonly reused: number; readonly evaluated: number; readonly saved: boolean }

/** Where a tree's cache lives: product data the adapter reads and writes atomically (`readJsonFile` / `writeTextAtomic`). */
export interface DependencyTreeCacheStore { readonly read: () => Promise<Readonly<{ kind: string; value?: unknown }>>; readonly write: (text: string) => Promise<void> }

/**
 * S6 dependency class (owner 2026-10-17). A read-only bind its pinned task profile declares as a dependency tree (`dependencyTree`) is
 * third-party content: deny paths and configured secret values refuse it as everywhere (the adapter evaluates both on every dispatch), while
 * text-pattern hits become audited exceptions (`dependencyTree:<target>`), never refusals; archives stay findings only an operator glob lifts. Each file's pattern result is evaluated
 * once per tree identity and reused:
 * - identity: the scope (the declared lockfile's bytes, `rules` — the rule table and product release —, the view label) plus each file's path and the
 *   SHA-256 of the bytes the gate read on this dispatch. A changed lockfile, rule table or release starts empty; a changed file is evaluated
 *   again; a file no longer present is dropped on save. Content-keyed, so an edit that keeps size and timestamps cannot reuse a stale result.
 * - the cache never decides: a stale or forged entry can only change which pattern exceptions are listed, never pass or refuse a tree. An
 *   unreadable cache reuses nothing; a failed save costs the next dispatch time only (`saved: false`).
 */
export class DependencyTreePatternCache {
  readonly by: string;
  readonly #reuse: ReadonlyMap<string, readonly [string, string | null]>;
  readonly #next = new Map<string, readonly [string, string | null]>();
  #reused = 0; #overlong = 0;
  private constructor(readonly label: string, readonly scope: string, reuse: ReadonlyMap<string, readonly [string, string | null]>, readonly store: DependencyTreeCacheStore | null) {
    this.by = dependencyTreeLifting(label); this.#reuse = reuse;
  }
  static async open(input: Readonly<{ label: string; lockfile: Uint8Array | null; rules: unknown; store: DependencyTreeCacheStore | null }>): Promise<DependencyTreePatternCache> {
    const scope = sha256(JSON.stringify([input.label, input.lockfile === null ? null : sha256(input.lockfile), input.rules]));
    const stored = await input.store?.read().catch(() => null), parsed = cacheSchema.safeParse(stored?.kind === 'ready' ? stored.value : null);
    const reuse = new Map(parsed.success && parsed.data.scope === scope ? Object.entries(parsed.data.files) : []);
    return new DependencyTreePatternCache(input.label, scope, reuse, input.store);
  }
  /** The cache file name of one bind (its host source and container target), inside the product's cache directory. */
  static fileName(source: string, target: string): string { return `${sha256(`${source}\0${target}`)}.json`; }
  /** The file's pattern result: reused when the same path held the same bytes in this scope, otherwise evaluated; kept for the next save. */
  async rule(path: string, bytes: Uint8Array, evaluate: () => Promise<string | null>): Promise<string | null> {
    // A native-claimed file's patterns can refuse (`refuseInNativeFiles`): never served from the cache, so the cache still never decides.
    if (nativeBinaryKind(bytes) !== null) return evaluate();
    const digest = sha256(bytes), cached = this.#reuse.get(path);
    const rule = cached?.[0] === digest ? (this.#reused++, cached[1]) : await evaluate();
    // Bounded keys: a path longer than the stored bound is evaluated on every dispatch, never kept.
    if (path.length <= BINARIES.maxCachePathLength) this.#next.set(path, [digest, rule]); else if (cached === undefined) this.#overlong++;
    return rule;
  }
  /** Saves this dispatch's results (only the files seen now) and reports the reuse. */
  async save(): Promise<DependencyTreeStatistics> {
    // Bounded store: a document above `maxCacheBytes` (the reader's cap) is not written; the next dispatch evaluates again.
    const text = JSON.stringify({ schemaVersion: 1, scope: this.scope, files: Object.fromEntries(this.#next) });
    const saved = this.store !== null && Buffer.byteLength(text) <= BINARIES.maxCacheBytes && await this.store.write(text).then(() => true, () => false);
    return Object.freeze({ label: this.label, reused: this.#reused, evaluated: this.#next.size - this.#reused + this.#overlong, saved });
  }
}

/** One open file above the text bound, read only through bounded windows (fewer bytes than asked means the file changed: refused). */
export interface DependencyBinarySource { readonly size: number; readonly read: (offset: number, length: number) => Promise<Buffer> }
/** What the class needs of the configured-value snapshot (platform `KnownSecretSnapshot`); never the values themselves. */
export interface DependencyValueSnapshot { readonly spans: (text: string) => readonly unknown[]; readonly pendingStart: (text: string) => number }
/**
 * The gate's own readers for one file: its decoder (`decodedTexts`), the bytes of its reading that drops bytes (`withoutNul`; a projection, so
 * windows stream it in its own coordinates), archive signatures (`archiveKind`), configured values, pattern rows, terminable regex runner and first-rule evaluator.
 */
export interface DependencyTextChecks {
  readonly decode: (bytes: Buffer, dropped?: boolean, wide?: boolean) => readonly string[]; readonly dropped: (bytes: Buffer) => Buffer; readonly archive: (bytes: Buffer) => string | null; readonly known: DependencyValueSnapshot;
  readonly rows: readonly Readonly<{ id: string; source: string; flags: string }>[];
  readonly match: (source: string, flags: string, texts: readonly string[]) => Promise<readonly number[]>;
  readonly first: (texts: readonly string[]) => Promise<string | null>;
}
/** A dependency-class hit: `refuse` findings stop the dispatch; the others are audited exceptions. */
export type DependencyHit = Readonly<{ rule: string; refuse: boolean }>;
const partialEscape = /\\(?:u[0-9a-fA-F]{0,3}|x[0-9a-fA-F]?)?$/u, refusing = new Set(BINARIES.refuseInNativeFiles);
/** The native format a header claims (a listed signature and a NUL byte within `headerBytes`), or null. */
export function nativeBinaryKind(bytes: Uint8Array): string | null {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, BINARIES.headerBytes));
  return header.includes(0) ? signatures.find(row => header.subarray(0, row.bytes.length).equals(row.bytes))?.kind ?? null : null;
}
/** The first credential family of `refuseInNativeFiles` any reading matches (one combined expression per flag set screens, then attribution). */
async function refusingRule(texts: readonly string[], checks: DependencyTextChecks): Promise<string | null> {
  const rows = checks.rows.filter(row => refusing.has(row.id));
  for (const flags of new Set(rows.map(row => row.flags))) {
    const group = rows.filter(row => row.flags === flags);
    if ((await checks.match(group.map(row => `(?:${row.source})`).join('|'), flags, texts)).length) {
      for (const row of group) if ((await checks.match(row.source, row.flags, texts)).length) return row.id;
    }
  }
  return null;
}
/**
 * S6 dependency class, review 4 (2026-10-17): a file whose header claims a native format (any size) is not third-party text. A credential
 * family of `refuseInNativeFiles` (private-key blocks, provider and cloud tokens) in it refuses; text fixtures stay exceptions (zod
 * url-userinfo, jose private-key-block). Returns `pattern:<id>` or null.
 */
export async function dependencyNativeRefusal(bytes: Uint8Array, texts: readonly string[], checks: DependencyTextChecks): Promise<string | null> {
  if (nativeBinaryKind(bytes) === null) return null;
  const rule = await refusingRule(texts, checks);
  return rule === null ? null : `pattern:${rule}`;
}

/**
 * A dependency-tree file above the text scan bound, never allocated whole: the header (`headerBytes`) is read first; anything but a native
 * format, or a native header that is also an archive signature, returns null (unclassifiable: the caller fails closed). A native file is read in `windowBytes` windows, each hashed and given every
 * reading of the gate's decoder: configured values and `refuseInNativeFiles` families refuse (stopping the read), other pattern hits are kept
 * as exceptions. The carry joins a value or pattern split at a window edge: `pendingStart` × `carryBytesPerChar` (with a trailing partial
 * escape set aside) and at least `patternCarryBytes`, kept per stream (Astra 2626 F2): the raw bytes, decoded without the NUL-dropped reading (UTF-8,
 * UTF-16 in both alignments and escapes take at most 24 raw bytes per decoded character), and the NUL-dropped bytes (`dropped`), whose reading skips NUL runs of any length,
 * so its carry is counted in its own bytes, never in raw distance. A carry above `maxCarryBytes` (a pending start the arithmetic cannot bound,
 * e.g. folded line breaks) returns null, and so does an archive start or end anywhere in the body (`embeddedArchive`: an appended zip, an
 * embedded gzip member, xz/7z/rar/bzip2/zstd/tar). `tick` enforces the deadline per window and per archive candidate. Hits: `native-binary:<kind>:sha256=<digest>` first.
 */
export async function classifyDependencyBinary(source: DependencyBinarySource, checks: DependencyTextChecks, tick: () => void): Promise<readonly DependencyHit[] | null> {
  // A header that is also an archive's (a tar whose first member is named like a native magic) is never classified (Astra 2626 F1).
  const header = await source.read(0, Math.min(source.size, BINARIES.headerBytes)), kind = nativeBinaryKind(header);
  if (kind === null || checks.archive(header) !== null) return null;
  const hash = createHash('sha256'), listed = new Set<string>();
  const tail = (bytes: Buffer, texts: readonly string[]) => bytes.subarray(Math.max(0, bytes.length - Math.max(BINARIES.patternCarryBytes,
    ...texts.map(text => (text.length - checks.known.pendingStart(text.replace(partialEscape, ''))) * BINARIES.carryBytesPerChar))));
  let carry: Buffer = Buffer.alloc(0), carried: Buffer = Buffer.alloc(0);
  for (let offset = 0; offset < source.size; offset += BINARIES.windowBytes) {
    tick();
    const length = Math.min(BINARIES.windowBytes, source.size - offset), chunk = await source.read(offset, length);
    if (chunk.length !== length) throw new Error('WORKER_TREE_ENTRY_CHANGED');
    hash.update(chunk);
    // The header's NUL settles the decoder for the whole file: every window also reads as UTF-16 in both alignments, NUL-free or not (Astra 2629 F1).
    const window = Buffer.concat([carry, chunk]), stream = Buffer.concat([carried, checks.dropped(chunk)]), own = checks.decode(window, false, true), joined = checks.decode(stream);
    const texts = [...new Set([...own, ...joined])];
    if (texts.some(text => checks.known.spans(text).length > 0)) return [{ rule: 'known-secret', refuse: true }];
    const refused = await refusingRule(texts, checks);
    if (refused !== null) return [{ rule: `pattern:${refused}`, refuse: true }];
    const rule = await checks.first(texts); if (rule !== null) listed.add(`pattern:${rule}`);
    if (await embeddedArchive(window, offset - carry.length, Math.max(0, carry.length - BINARIES.embeddedArchives.overlapBytes), source.size, source.read, tick) !== null) return null;
    carry = tail(window, own); carried = tail(stream, joined);
    if (Math.max(carry.length, carried.length) > BINARIES.maxCarryBytes) return null;
  }
  return [{ rule: `native-binary:${kind}:sha256=${hash.digest('hex')}`, refuse: false }, ...[...listed].map(rule => ({ rule, refuse: false }))];
}
