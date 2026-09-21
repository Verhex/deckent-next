import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { productResourcePath, resolveProductLayout } from '#platform/core/host/index.js';

export const BOOTSTRAP_JOURNAL_MAX_BYTES = 262_144;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const resource = z.object({
  resource: z.string().min(1).max(256),
  path: z.string().min(1).max(4096).refine(value => isAbsolute(value) && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)),
  preimageDigest: hex.nullable(),
  targetDigest: hex,
  state: z.enum(['pending', 'published']),
}).strict().readonly();
const journalShape = {
  schemaVersion: z.literal(2), transactionId: z.string().min(1).max(256), planDigest: hex, profileDigest: hex,
  phase: z.enum(['pending', 'committed']), createdAtMs: z.number().int().nonnegative().safe(),
  updatedAtMs: z.number().int().nonnegative().safe(), resources: z.array(resource).min(1).max(1024).readonly(),
  blockers: z.array(z.string().min(1).max(256)).max(1024).readonly(), recovery: z.unknown().transform((input, context) => {
    try {
      const parsed = JSON.parse(canonical(input)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('RECOVERY_INVALID');
      return freezeRecovery(parsed);
    } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'RECOVERY_INVALID' }); return z.NEVER; }
  }),
};
function journalRules(value: z.infer<z.ZodObject<typeof journalShape>>, context: z.RefinementCtx) {
  if (value.updatedAtMs < value.createdAtMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ['updatedAtMs'], message: 'TIME_ORDER' });
  if (new Set(value.resources.map(item => item.resource)).size !== value.resources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resources'], message: 'RESOURCE_DUPLICATE' });
  }
  if (new Set(value.resources.map(item => item.path)).size !== value.resources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['resources'], message: 'PATH_DUPLICATE' });
  }
  if (value.phase === 'committed' && (value.blockers.length > 0 || value.resources.some(item => item.state !== 'published'))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['phase'], message: 'COMMIT_INCOMPLETE' });
  }
}
const journalPayloadSchema = z.object(journalShape).strict().superRefine(journalRules).readonly();
export const bootstrapJournalSchema = z.object({ ...journalShape, checksum: hex }).strict().superRefine(journalRules).readonly();
export type BootstrapJournalPayload = z.infer<typeof journalPayloadSchema>;
export type BootstrapJournal = z.infer<typeof bootstrapJournalSchema>;
export interface BootstrapObservation { readonly generation: string; readonly record: BootstrapJournal | null }
export type BootstrapStateErrorCode = 'BOOTSTRAP_STATE_INVALID' | 'BOOTSTRAP_STATE_UNSAFE' | 'BOOTSTRAP_STATE_CHANGED'
  | 'BOOTSTRAP_INSTALLATION_INCOMPLETE' | 'BOOTSTRAP_STATE_UNAVAILABLE' | 'BOOTSTRAP_STATE_UNSUPPORTED';
export class BootstrapStateError extends Error {
  constructor(readonly code: BootstrapStateErrorCode) { super(code); this.name = 'BootstrapStateError'; }
}

function canonical(input: unknown): string {
  let nodes = 0; let units = 0; const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { units += value.length; if (units > 131072) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID'); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID'); return Object.is(value, -0) ? 0 : value; }
    if (typeof value !== 'object' || ancestors.has(value)) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
    const array = Array.isArray(value), descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if ((!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) || keys.some(key => typeof key !== 'string')) {
      throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
    }
    ancestors.add(value);
    try {
      if (array) {
        const length = descriptors['length']?.value;
        if (!Number.isSafeInteger(length) || length < 0 || length > 4096 || keys.length !== length + 1) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
        return Array.from({ length }, (_, index) => { const entry = descriptors[String(index)];
          if (!entry || !('value' in entry) || !entry.enumerable) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID'); return visit(entry.value, depth + 1); });
      }
      return Object.fromEntries((keys as string[]).sort().map(key => { const entry = descriptors[key]!;
        if (!('value' in entry) || !entry.enumerable) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
        units += key.length; if (units > 131072) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID'); return [key, visit(entry.value, depth + 1)]; }));
    } finally { ancestors.delete(value); }
  };
  return JSON.stringify(visit(input, 0));
}

function freezeRecovery(value: unknown): Readonly<Record<string, unknown>> {
  const freeze = (current: unknown): unknown => {
    if (Array.isArray(current)) return Object.freeze(current.map(freeze));
    if (current && typeof current === 'object') return Object.freeze(Object.fromEntries(Object.entries(current).map(([key, item]) => [key, freeze(item)])));
    return current;
  };
  return freeze(value) as Readonly<Record<string, unknown>>;
}

export function hashBootstrapJournal(input: unknown): string {
  const sanitized = JSON.parse(canonical(input)) as unknown;
  const payload = journalPayloadSchema.safeParse(sanitized);
  if (!payload.success) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
  return createHash('sha256').update(`deckent.bootstrap-journal.v2\n${canonical(payload.data)}`, 'utf8').digest('hex');
}

/** Canonical complete journal bytes for an owning writer; this observer never writes them. */
export function encodeBootstrapJournal(payload: unknown): string {
  const sanitized = JSON.parse(canonical(payload)) as unknown;
  const parsed = journalPayloadSchema.safeParse(sanitized);
  if (!parsed.success) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
  const record = bootstrapJournalSchema.parse({ ...parsed.data, checksum: hashBootstrapJournal(parsed.data) });
  const encoded = `${canonical(record)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > BOOTSTRAP_JOURNAL_MAX_BYTES) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
  return encoded;
}

function same(left: bigint, right: bigint) { return left === right; }
function assertPrivateFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())
    || ![0o400n, 0o600n].includes(stat.mode & 0o777n) || stat.size <= 0n || stat.size > BigInt(BOOTSTRAP_JOURNAL_MAX_BYTES)) {
    throw new BootstrapStateError('BOOTSTRAP_STATE_UNSAFE');
  }
}
// Owner O5: group directory custody is allowed; journal files still require private ownership/mode.
async function assertPathSafe(projectRoot: string, path: string): Promise<void> {
  const root = resolve(projectRoot), parent = dirname(path), within = relative(root, parent);
  if (within === '..' || within.startsWith(`..${sep}`)) throw new BootstrapStateError('BOOTSTRAP_STATE_UNSAFE');
  let cursor = dirname(root); const segments = [...relative(cursor, root).split(sep), ...within.split(sep)].filter(Boolean);
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()
      || stat.uid !== process.getuid!() || (stat.mode & 0o002) !== 0) throw new BootstrapStateError('BOOTSTRAP_STATE_UNSAFE'); }
    catch (error) {
      if (error instanceof BootstrapStateError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new BootstrapStateError('BOOTSTRAP_STATE_UNAVAILABLE');
    }
  }
}
export async function observeBootstrapState(projectRoot: string): Promise<BootstrapObservation> {
  let path: string;
  try { const layout = resolveProductLayout({ projectRoot, platform: process.platform === 'win32' ? 'win32' : 'posix' });
    path = productResourcePath(layout, 'installationJournal'); }
  catch { throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID'); }
  let linked;
  try { linked = await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (process.platform !== 'win32' && process.getuid) await assertPathSafe(projectRoot, path);
      return Object.freeze({ generation: 'absent', record: null });
    }
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new BootstrapStateError('BOOTSTRAP_STATE_UNSAFE');
    throw new BootstrapStateError('BOOTSTRAP_STATE_UNAVAILABLE');
  }
  if (process.platform === 'win32' || !process.getuid) throw new BootstrapStateError('BOOTSTRAP_STATE_UNSUPPORTED');
  await assertPathSafe(projectRoot, path);
  assertPrivateFile(linked);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!same(opened.dev, linked.dev) || !same(opened.ino, linked.ino)) throw new BootstrapStateError('BOOTSTRAP_STATE_CHANGED');
    assertPrivateFile(opened);
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    const after = await handle.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
    if (offset !== bytes.length || !same(after.size, opened.size) || !same(after.mtimeNs, opened.mtimeNs) || !same(after.ctimeNs, opened.ctimeNs)
      || !same(named.dev, opened.dev) || !same(named.ino, opened.ino) || !same(named.size, opened.size)
      || !same(named.mtimeNs, opened.mtimeNs) || !same(named.ctimeNs, opened.ctimeNs)) throw new BootstrapStateError('BOOTSTRAP_STATE_CHANGED');
    assertPrivateFile(after); assertPrivateFile(named);
    let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID'); }
    const parsed = bootstrapJournalSchema.safeParse(raw);
    if (!parsed.success) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
    const { checksum, ...payload } = parsed.data;
    if (checksum !== hashBootstrapJournal(payload)) throw new BootstrapStateError('BOOTSTRAP_STATE_INVALID');
    const content = createHash('sha256').update(bytes).digest('hex');
    return Object.freeze({ generation: `${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeNs}:${opened.ctimeNs}:${content}`, record: parsed.data });
  } catch (error) {
    if (error instanceof BootstrapStateError) throw error;
    throw new BootstrapStateError((error as NodeJS.ErrnoException).code === 'ELOOP' ? 'BOOTSTRAP_STATE_UNSAFE' : 'BOOTSTRAP_STATE_UNAVAILABLE');
  } finally { await handle?.close(); }
}

export function assertBootstrapUsable(observation: BootstrapObservation): void {
  if (observation.record?.phase === 'pending') throw new BootstrapStateError('BOOTSTRAP_INSTALLATION_INCOMPLETE');
}
export function assertBootstrapUnchanged(before: BootstrapObservation, after: BootstrapObservation): void {
  if (before.generation !== after.generation) throw new BootstrapStateError('BOOTSTRAP_STATE_CHANGED');
}
