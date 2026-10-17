import { createHash } from 'node:crypto';
import { z } from 'zod';
import BINARIES from './dependency-binaries.json' with { type: 'json' };

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
 * content and archive hits become audited exceptions (`dependencyTree:<target>`), never refusals. Each file's pattern result is evaluated
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
/** A configured-value check of one window: whether a value is in it, and how many trailing bytes may begin one (carried into the next window). */
export type DependencyBinaryValueCheck = (window: Buffer) => Readonly<{ hit: boolean; carry: number }>;
/** What the value check needs of the configured-value snapshot (platform `KnownSecretSnapshot`); never the values themselves. */
export interface DependencyValueSnapshot { readonly spans: (text: string) => readonly unknown[]; readonly pendingStart: (text: string) => number }
const partialEscape = /\\(?:u[0-9a-fA-F]{0,3}|x[0-9a-fA-F]?)?$/u;
/**
 * The configured-value check of one window in every reading `decode` takes of it (the gate's `decodedTexts`: UTF-8, NUL-stripped, UTF-16 at
 * both alignments, JSON/YAML escapes): a hit anywhere, and the carry — the trailing characters that may begin a value (`pendingStart`, judged
 * with a trailing partial escape set aside so an escaped value split at the edge is still joined) times `carryBytesPerChar`, the widest byte
 * form one decoded character takes (a six-character escape in a four-byte encoding).
 */
export const dependencyValueCheck = (decode: (bytes: Buffer) => readonly string[], known: DependencyValueSnapshot): DependencyBinaryValueCheck => window => {
  const texts = decode(window);
  return { hit: texts.some(text => known.spans(text).length > 0),
    carry: Math.max(0, ...texts.map(text => (text.length - known.pendingStart(text.replace(partialEscape, ''))) * BINARIES.carryBytesPerChar)) };
};

/**
 * A dependency-tree file above the text scan bound, never allocated whole: the header (`headerBytes`) is read first, and only a listed native
 * format (signature and a NUL byte in the header) is read further, in `windowBytes` windows, each hashed and checked for configured values
 * with the bytes that may begin one carried over (bounded by the longest configured value). Returns `unscanned-binary:<kind>:sha256=<digest>`,
 * `known-secret` (refused) or null (unclassifiable: the caller fails closed before any further read). `tick` enforces the scan deadline.
 */
export async function classifyDependencyBinary(source: DependencyBinarySource, values: DependencyBinaryValueCheck, tick: () => void): Promise<string | null> {
  const header = await source.read(0, Math.min(source.size, BINARIES.headerBytes));
  const kind = header.includes(0) ? signatures.find(row => header.subarray(0, row.bytes.length).equals(row.bytes))?.kind : undefined;
  if (kind === undefined) return null;
  const hash = createHash('sha256');
  let carry = Buffer.alloc(0);
  for (let offset = 0; offset < source.size; offset += BINARIES.windowBytes) {
    tick();
    const length = Math.min(BINARIES.windowBytes, source.size - offset), chunk = await source.read(offset, length);
    if (chunk.length !== length) throw new Error('WORKER_TREE_ENTRY_CHANGED');
    hash.update(chunk);
    const window = Buffer.concat([carry, chunk]), check = values(window);
    if (check.hit) return 'known-secret';
    carry = window.subarray(Math.max(0, window.length - Math.min(window.length, check.carry)));
  }
  return `unscanned-binary:${kind}:sha256=${hash.digest('hex')}`;
}
