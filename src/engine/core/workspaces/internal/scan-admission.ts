import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { attemptIdentitySchema, counterSchema, sameAttemptIdentity, type AttemptIdentity, type AuditEvent } from '#domain/index.js';
import { DeckentError, ErrorRegistry } from '#platform/index.js';
import { enforceWorkerTreeGate, type WorkerTreeGateContext, type WorkerTreeScan } from './secret-gate.js';

/** What the gate needs of one adapter view (`WorkerTreeView`): a host path with an optional declared dependency tree, or delivered text. */
export type WorkerTreeScanView = Readonly<{ source: string; label: string; dependencyTree?: Readonly<{ lockfile: string }> }> | Readonly<{ text: string; label: string }>;
/** `execution.secretGate` scan admission (R2, owner/lead D3a 2026-10-18): concurrent scans in this process, the wait for a slot, and how many
 * load-dependent `time` refusals one Attempt retries before the refusal is final. */
export type WorkerTreeScanAdmissionSettings = Readonly<{ maxConcurrentScans: number; admissionTimeoutMs: number; maxTimeRefusals: number }>;
/** The wait for a scan slot ended at `admissionTimeoutMs`; nothing was scanned. */
export class WorkerTreeScanAdmissionTimeout extends Error { constructor(readonly waited: number, readonly bound: number) { super('WORKER_TREE_SCAN_ADMISSION_TIMEOUT'); } }

/**
 * Per-process admission of worker-tree scans. All async file reads share libuv's small thread pool, so N concurrent full scans slow each other
 * until every one misses its deadline (a measured run: 13 concurrent scans over 120 s, 3 scans in 65 s). A scan starts only inside a granted slot (FIFO),
 * so its deadline counts its own work, never the queue. `shared` lets dispatches whose declared dependency views have the same key await
 * the one scan already in flight: it holds one slot, joiners hold none (no slot is ever requested while one is held), and the entry is
 * dropped when that scan settles — a later dispatch scans again, nothing is reused after completion.
 */
export class WorkerTreeScanAdmission {
  #active = 0; #started = 0; #joined = 0; #waited = 0;
  readonly #waiting: { readonly limit: number; readonly grant: () => void }[] = [];
  readonly #flights = new Map<string, Promise<WorkerTreeScan>>();
  constructor(private readonly now: () => number = Date.now) {}
  /** Evidence for measurement and the monitor: slots in use, queued requests, scans in flight, shared scans started and joined, waits. */
  statistics() {
    return Object.freeze({ active: this.#active, waiting: this.#waiting.length, inFlight: this.#flights.size, started: this.#started, joined: this.#joined, waited: this.#waited });
  }
  async admit<T>(settings: WorkerTreeScanAdmissionSettings, work: () => Promise<T>): Promise<T> {
    if (this.#waiting.length || this.#active >= settings.maxConcurrentScans) await this.#wait(settings); else this.#active++;
    try { return await work(); } finally { this.#active--; this.#grant(); }
  }
  /** The scan in flight under `key`, or a new one admitted like any other. A rejection reaches every joiner. */
  shared(key: string, settings: WorkerTreeScanAdmissionSettings, work: () => Promise<WorkerTreeScan>): Promise<WorkerTreeScan> {
    const existing = this.#flights.get(key);
    if (existing) { this.#joined++; return existing; }
    this.#started++;
    const flight = this.admit(settings, work).finally(() => this.#flights.delete(key));
    this.#flights.set(key, flight);
    return flight;
  }
  #wait(settings: WorkerTreeScanAdmissionSettings): Promise<void> {
    this.#waited++; const since = this.now();
    return new Promise((resolve, reject) => {
      const entry = { limit: settings.maxConcurrentScans, grant: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const at = this.#waiting.indexOf(entry); if (at < 0) return;
        this.#waiting.splice(at, 1); this.#grant(); reject(new WorkerTreeScanAdmissionTimeout(this.now() - since, settings.admissionTimeoutMs));
      }, settings.admissionTimeoutMs);
      this.#waiting.push(entry);
    });
  }
  /** A freed slot goes to the head of the queue (the slot is counted before the waiter resumes, so a newcomer cannot take it). */
  #grant() { while (this.#waiting.length && this.#active < this.#waiting[0]!.limit) { this.#active++; this.#waiting.shift()!.grant(); } }
}
/** The runtime service's one admission: every dispatch it prepares scans through it. A separate CLI `execute` process has its own. */
export const WORKER_TREE_SCAN_ADMISSION = new WorkerTreeScanAdmission();

/**
 * One gate decision from two scans of the same dispatch (its own views, and its declared dependency views): a refusal wins (its findings
 * are evidence), then a bound other than `time`, then `time`; otherwise clean. Findings and lifted hits keep the order own, then shared.
 */
export function mergeWorkerTreeScans(own: WorkerTreeScan, shared: WorkerTreeScan): WorkerTreeScan {
  const scans = [own, shared], complete = scans.flatMap(scan => scan.status === 'incomplete' ? [] : [scan]);
  const refused = complete.flatMap(scan => scan.status === 'refused' ? [scan] : []);
  if (!refused.length && complete.length < scans.length) return scans.find(scan => scan.status === 'incomplete' && scan.limit !== 'time') ?? scans.find(scan => scan.status === 'incomplete')!;
  const excluded = complete.flatMap(scan => scan.excluded ?? []), trees = complete.flatMap(scan => scan.dependencyTrees ?? []);
  const lifted = { ...(excluded.length ? { excluded: Object.freeze(excluded) } : {}), ...(trees.length ? { dependencyTrees: Object.freeze(trees) } : {}) };
  return refused.length ? Object.freeze({ status: 'refused', findings: Object.freeze(refused.flatMap(scan => scan.findings)), count: refused.reduce((sum, scan) => sum + scan.count, 0), ...lifted })
    : Object.freeze({ status: 'clean', ...lifted });
}

/** Never leaves this process: the shared-scan key is a keyed digest, so it reveals nothing about the configuration it covers. */
const SHARE_KEY = randomBytes(32);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** The JSON record port (platform `JsonRecordFile`) keeping one Attempt's count of `time` refusals. */
export interface WorkerTreeTimeRefusalFile {
  read(): Promise<{ kind: 'absent' } | { kind: 'ready'; value: unknown } | { kind: 'corrupt' } | { kind: 'io' }>;
  write(value: unknown): Promise<void>; remove(): Promise<void>;
}
const refusalRecordSchema = z.object({ schemaVersion: z.literal(1), identity: attemptIdentitySchema, refusals: counterSchema }).strict();

export interface AdmittedWorkerTreeGateInput<V extends WorkerTreeScanView> {
  /** Everything the worker receives (`workerTreeViews`); the view labelled '' is the attempt checkout. */
  readonly views: readonly V[];
  /** The adapter scan of some of those views; its deadline starts when it is called, inside a granted slot. */
  readonly scan: (views: readonly V[]) => Promise<WorkerTreeScan>;
  readonly settings: WorkerTreeScanAdmissionSettings;
  /** Everything else the scan's result depends on (the effective configuration: gate bounds and lists, configured secret values, cache
   * directory, and the work-target checkout). Only its keyed digest is kept. */
  readonly fingerprint: unknown;
  /** The declared lockfile's bytes (null when absent, oversized or not a regular file: that view is then never shared). */
  readonly lockfile: (path: string) => Promise<Uint8Array | null>;
  /** Whether two host paths share a tree (platform `pathsShareTree`): a declared bind sharing the checkout's tree is scanned with it. */
  readonly sharesTree: (a: string, b: string) => Promise<boolean>;
  readonly refusals: (name: string) => WorkerTreeTimeRefusalFile;
  readonly admission?: WorkerTreeScanAdmission;
}

/** The key of byte-identical dependency-view inputs: each view's host source, container target and lockfile bytes, plus the fingerprint. */
type DependencyView = Readonly<{ source: string; label: string; dependencyTree: Readonly<{ lockfile: string }> }>;
async function sharedScanKey(fingerprint: unknown, lockfile: (path: string) => Promise<Uint8Array | null>, views: readonly DependencyView[]): Promise<string | null> {
  const locks = await Promise.all(views.map(view => lockfile(join(view.source, view.dependencyTree.lockfile))));
  if (locks.some(lock => lock === null)) return null;
  return createHmac('sha256', SHARE_KEY).update(JSON.stringify([fingerprint, views.map((view, at) => [view.source, view.label, view.dependencyTree.lockfile, sha256(locks[at]!)])])).digest('hex');
}
async function admittedScan<V extends WorkerTreeScanView>(input: AdmittedWorkerTreeGateInput<V>, admission: WorkerTreeScanAdmission): Promise<WorkerTreeScan> {
  const { views, scan, settings } = input, checkout = views.find(view => 'source' in view && view.label === '');
  const own: V[] = [], shared: V[] = [], declared: DependencyView[] = [];
  for (const view of views) {
    const seen: WorkerTreeScanView = view;
    if ('source' in seen && seen.dependencyTree && seen.label !== '' && !(checkout && 'source' in checkout && await input.sharesTree(checkout.source, seen.source))) {
      shared.push(view); declared.push({ source: seen.source, label: seen.label, dependencyTree: seen.dependencyTree });
    } else own.push(view);
  }
  const key = shared.length ? await sharedScanKey(input.fingerprint, input.lockfile, declared).catch(() => null) : null;
  if (key === null) return admission.admit(settings, () => scan(views));
  const [mine, theirs] = await Promise.allSettled([own.length ? admission.admit(settings, () => scan(own)) : Promise.resolve<WorkerTreeScan>(Object.freeze({ status: 'clean' })),
    admission.shared(key, settings, () => scan(shared))]);
  if (mine.status === 'rejected') throw mine.reason;
  if (theirs.status === 'rejected') throw theirs.reason;
  return mergeWorkerTreeScans(mine.value, theirs.value);
}
/** One more `time` refusal of this Attempt. An unreadable or foreign record is never a clean slate: it counts as the bound already spent. */
async function countTimeRefusal(file: WorkerTreeTimeRefusalFile, identity: AttemptIdentity, bound: number): Promise<number> {
  const read = await file.read(), parsed = read.kind === 'ready' ? refusalRecordSchema.safeParse(read.value) : null;
  const prior = read.kind === 'absent' ? 0 : parsed?.success && sameAttemptIdentity(parsed.data.identity, identity) ? parsed.data.refusals : bound;
  if (prior + 1 <= bound) await file.write(refusalRecordSchema.parse({ schemaVersion: 1, identity, refusals: prior + 1 }));
  return prior + 1;
}

/**
 * S6 gate with scan admission (R2, owner/lead D3a 2026-10-18). The scan runs inside a slot of `execution.secretGate.maxConcurrentScans`;
 * declared dependency views (outside the checkout's tree) whose key matches a scan in flight await that scan instead of reading the mount
 * again. `enforceWorkerTreeGate` still decides per dispatch on the merged result, so every Attempt gets its own audit and journal entry and
 * a refusal in the shared scan refuses every Attempt that awaited it. No result is reused after its scan settled, and nothing is keyed by
 * stat or ctime: the cache never decides.
 *
 * A `time` bound (the scan deadline, or the wait for a slot) depends on load, not on the tree: it is audited like any incomplete scan and
 * thrown as the transient `WORKER_TREE_SCAN_DEFERRED` (the turn's backoff applies) up to `maxTimeRefusals` times per Attempt; the refusal
 * after that is the permanent `WORKER_TREE_SCAN_INCOMPLETE`. An unrecordable count is final too, so a retry is never unbounded.
 */
export async function enforceAdmittedWorkerTreeGate<V extends WorkerTreeScanView>(input: AdmittedWorkerTreeGateInput<V>, context: WorkerTreeGateContext,
  record: (event: AuditEvent) => Promise<unknown>, release: () => Promise<unknown>): Promise<void> {
  let scan: WorkerTreeScan, field = 'timeoutMs';
  try { scan = await admittedScan(input, input.admission ?? WORKER_TREE_SCAN_ADMISSION); }
  catch (error) {
    if (!(error instanceof WorkerTreeScanAdmissionTimeout)) throw error;
    scan = Object.freeze({ status: 'incomplete', limit: 'time', observed: error.waited, bound: error.bound }); field = 'admissionTimeoutMs';
  }
  const file = input.refusals(createHash('sha256').update(JSON.stringify(attemptIdentitySchema.parse(context.identity))).digest('hex'));
  try { await enforceWorkerTreeGate(scan, context, record, release); }
  catch (error) {
    // An audit failure is thrown as it is (transient, nothing counted); only a recorded `time` refusal is counted.
    if (scan.status !== 'incomplete' || scan.limit !== 'time' || !(error instanceof DeckentError) || error.code !== 'WORKER_TREE_SCAN_INCOMPLETE') throw error;
    const { maxTimeRefusals } = input.settings, params = { limit: field, observed: scan.observed, bound: scan.bound };
    const refusals = await countTimeRefusal(file, context.identity, maxTimeRefusals).catch(() => Number.POSITIVE_INFINITY);
    if (refusals <= maxTimeRefusals) throw ErrorRegistry.createError('WORKER_TREE_SCAN_DEFERRED', { params: { ...params, refusals, maxTimeRefusals } });
    await file.remove().catch(() => undefined);
    throw field === 'timeoutMs' ? error : ErrorRegistry.createError('WORKER_TREE_SCAN_INCOMPLETE', { params });
  }
  await file.remove().catch(() => undefined);
}
