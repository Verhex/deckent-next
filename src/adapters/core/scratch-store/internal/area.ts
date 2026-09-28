import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, utimes, type FileHandle } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { encodeCommandProjection, type AgentToolOutcome, type AgentToolSpec, type EffectTargetRef } from '#domain/index.js';
import { EffectTargetError, type EffectApplyRequest, type EffectTarget } from '#engine/index.js';
import type { ScratchActivity } from './custody.js';
import { createWorkspaceReadTools, DEFAULT_WORKSPACE_READ_DENY, WORKSPACE_READ_TOOL_SPECS, type WorkspaceScope } from '#adapters/core/workspace-read/index.js';
import { ABSENT_FILE_VERSION, planWorkspaceEdit, resolveWritable, unifiedDiff, WORKSPACE_FILE_TARGET_KIND, WorkspaceFileTarget, writablePath,
  type WorkspaceEditArea, type WorkspaceEditPlan } from '#adapters/core/workspace-write/index.js';

export const SCRATCH_FILE_TARGET_KIND = 'scratch-file';
/** Core operation of a scratch write (SCR-A). Under the `workspace` namespace Core already closes; its own id lets a company govern the
 * scratch area apart from project files (catalog data in code for the built-in Core target, like `workspace.file.write`). */
export const SCRATCH_FILE_WRITE_OPERATION = Object.freeze({ schemaVersion: 1 as const, operation: Object.freeze({ id: 'workspace.scratch.write', version: 1 }),
  targetKind: SCRATCH_FILE_TARGET_KIND, effectClass: 'write' as const, approval: 'policy' as const, precondition: 'record-version' as const,
  compensation: null, inputMaxBytes: 1_048_576 });

/** Byte ceilings and retention of the scratch area (configuration data, `terminal.scratch`). */
export interface ScratchLimits {
  readonly writeMaxBytes: number; readonly sessionMaxBytes: number; readonly installationMaxBytes: number;
  readonly retentionDays: number; readonly sweepIntervalMs: number;
}
/** Walk bounds of a usage measurement: past either, the measurement is incomplete and a write is refused (fail closed). */
export const SCRATCH_WALK_MAX_ENTRIES = 100_000;
export const SCRATCH_WALK_MAX_DEPTH = 64;
const KEY = /^[0-9a-f]{32}\/[0-9a-f]{32}$/u;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const digest32 = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

export class ScratchError extends Error {
  constructor(readonly code: 'SCRATCH_KEY_INVALID' | 'SCRATCH_UNSAFE' | 'SCRATCH_QUOTA_EXCEEDED', message: string = code) { super(message); this.name = 'ScratchError'; }
}

/**
 * The area of one conversation, relative to the layout's `scratch` resource: `<owner>/<session>`. The owner is the scope and the
 * verified principal (another person's or scope's area is never the same directory); the session is the client's conversation id,
 * else the turn (a turn without a session has an area of its own). Both parts are digests: no identity text reaches a path.
 */
export function scratchSessionKey(input: { readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string } }
  & ({ readonly sessionId: string; readonly turnId?: string } | { readonly sessionId?: undefined; readonly turnId: string })): string {
  const owner = digest32(`scratch-owner:1\0${input.scopeId}\0${input.principal.issuer}\0${input.principal.subject}`);
  const session = digest32(`scratch-session:1\0${input.sessionId === undefined ? `turn\0${input.turnId}` : `session\0${input.sessionId}`}`);
  return `${owner}/${session}`;
}

/**
 * Directories `segments` under `base`, created one component at a time from an open directory descriptor (0700, never following a
 * link: an existing link or file at any component refuses), owned by this user; an existing one with group or other bits is made 0700.
 */
export async function ensureScratchDirectories(base: string, segments: readonly string[]): Promise<void> {
  let current = await open(base, DIR_FLAGS);
  try {
    for (const segment of segments) {
      if (!segment || segment === '.' || segment === '..' || segment.includes('/')) throw new ScratchError('SCRATCH_UNSAFE');
      try { await mkdir(`${fdPath(current)}/${segment}`, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      let next: FileHandle;
      try { next = await open(`${fdPath(current)}/${segment}`, DIR_FLAGS); } catch (error) { throw new ScratchError('SCRATCH_UNSAFE', String((error as NodeJS.ErrnoException).code)); }
      await current.close(); current = next;
      const info = await current.stat();
      if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new ScratchError('SCRATCH_UNSAFE');
      if ((info.mode & 0o077) !== 0) await current.chmod(0o700);
    }
  } finally { await current.close().catch(() => undefined); }
}

/** Bytes of the regular files under `dir` (lstat walk: links are never followed, only counted as entries); null when the walk passes its
 * entry or depth bound (the caller refuses). A missing directory holds nothing. */
export async function scratchUsage(dir: string): Promise<number | null> {
  let bytes = 0, entries = 0;
  const walk = async (path: string, depth: number): Promise<boolean> => {
    let names;
    try { names = await readdir(path, { withFileTypes: true }); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
    for (const entry of names) {
      if (++entries > SCRATCH_WALK_MAX_ENTRIES) return false;
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (depth + 1 > SCRATCH_WALK_MAX_DEPTH || !await walk(child, depth + 1)) return false; }
      else if (entry.isFile()) bytes += await lstat(child).then(info => info.size, () => 0);
    }
    return true;
  };
  return await walk(dir, 0) ? bytes : null;
}

export interface ScratchSession {
  /** The layout's scratch resource (installation-wide). */
  readonly root: string;
  /** `<owner>/<session>`, relative to `root`. */
  readonly key: string;
  /** Real path of this session's area. */
  readonly dir: string;
  readonly scope: WorkspaceScope;
  readonly limits: ScratchLimits;
  /** `scratch_write` as an edit area: planned and written through the caller's one C11 path. */
  readonly writes: WorkspaceEditArea;
  /** Whether `tool` is one of the scratch read tools. */
  reads(tool: string): boolean;
  /** `scratch_read` / `scratch_list`: the workspace read tools over this area. */
  read(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome>;
  /**
   * Every write into the area (the `scratch_write` effect, or bytes another effect produced): `write` runs as the scratch resource's
   * only write (the custody's lane) after the session and installation ceilings admitted `bytes` at `rel` (the file it replaces
   * counted once); the lane is released whatever the outcome. A refusal never runs `write`; an abort while waiting runs nothing.
   */
  spend<T>(rel: string, bytes: number, write: () => Promise<T>, signal?: AbortSignal): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }>;
  /** Ends this turn's hold of the area (idempotent): from then on the sweep may remove it once it is past retention. */
  release(): void;
  /** Stores bytes a service effect produced (a fetched body, FETCH S7) at `rel` through `spend` (the one write lane: session and
   * installation quota admitted with no other scratch write in between), 0600, atomic; `signal` abandons the wait for the lane. */
  deposit(rel: string, data: Uint8Array, signal?: AbortSignal): Promise<{ readonly ok: true; readonly path: string; readonly rel: string } | { readonly ok: false; readonly error: string }>;
}

const quotaRefusal = (detail: string): WorkspaceEditPlan => ({ ok: false, error: `scratch-quota-exceeded (${detail})` });
/** The session and installation ceilings for writing `bytes` to `rel` (the file it replaces is not counted twice); null when within. Advisory
 * when planning (before any card); binding only inside the custody's write lane (`spend`), where no other scratch write runs meanwhile. */
async function quotaCheck(session: Pick<ScratchSession, 'root' | 'dir' | 'limits'>, rel: string, bytes: number): Promise<WorkspaceEditPlan | null> {
  const replaced = await lstat(join(session.dir, ...rel.split('/'))).then(info => info.isFile() ? info.size : 0, () => 0);
  const [own, all] = await Promise.all([scratchUsage(session.dir), scratchUsage(session.root)]);
  if (own === null) return quotaRefusal('session: too many entries to measure');
  if (own - replaced + bytes > session.limits.sessionMaxBytes) return quotaRefusal(`session: ${own - replaced} + ${bytes} > ${session.limits.sessionMaxBytes} bytes`);
  if (all === null) return quotaRefusal('installation: too many entries to measure');
  if (all - replaced + bytes > session.limits.installationMaxBytes) {
    return quotaRefusal(`installation: ${all - replaced} + ${bytes} > ${session.limits.installationMaxBytes} bytes`);
  }
  return null;
}

/** A write whose parent directories do not exist yet: every existing ancestor must be a real directory of the area (no link); the file is
 * absent. The directories are created only at the effect, after the decision. */
async function planIntoNewDirectories(scope: WorkspaceScope, path: unknown, content: string): Promise<WorkspaceEditPlan> {
  const target = writablePath(scope, path);
  if (!target.ok) return { ok: false, error: target.error };
  const segments = target.parentRel.split('/');
  for (let index = 1; index <= segments.length; index++) {
    const prefix = segments.slice(0, index).join('/'), found = await scope.resolve(prefix);
    if (found.ok && found.rel === prefix) continue;
    if (!found.ok && found.error === 'not-found') break;
    return { ok: false, error: found.ok ? 'parent-is-link' : `parent-${found.error}` };
  }
  const preview = unifiedDiff(target.rel, null, content), lines = preview.split('\n');
  return { ok: true, rel: target.rel, beforeVersion: ABSENT_FILE_VERSION, after: content, preview,
    added: lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length, removed: 0 };
}

/**
 * The session's area as an effect target. Record ids are `<owner>/<session>/<path>` (unique in the installation: the ledger's busy check
 * and sequence are per target kind and id); the physical write is the workspace file target over this area — conditional on the planned
 * version, atomic, journaled — creating files 0600. The write runs inside the session's `spend` (quota admitted in the custody's write
 * lane); missing directories of the path are created then (after the decision), never through a link.
 */
class ScratchFileTarget implements EffectTarget {
  readonly kind = SCRATCH_FILE_TARGET_KIND;
  private readonly inner: WorkspaceFileTarget;
  constructor(private readonly session: Pick<ScratchSession, 'root' | 'key' | 'dir' | 'scope' | 'limits' | 'spend'>, journal: string) {
    this.inner = new WorkspaceFileTarget(session.scope, journal, { createMode: 0o600, maxFileBytes: session.limits.writeMaxBytes });
  }
  identity() { return `scratch-file:${this.session.root}`; }
  private local(ref: EffectTargetRef): EffectTargetRef {
    const prefix = `${this.session.key}/`;
    if (!ref.id.startsWith(prefix)) throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    return { kind: WORKSPACE_FILE_TARGET_KIND, id: ref.id.slice(prefix.length) };
  }
  async observe(ref: EffectTargetRef) {
    const local = this.local(ref), target = await resolveWritable(this.session.scope, local.id);
    return !target.ok && target.error === 'parent-not-found' ? { version: ABSENT_FILE_VERSION } : this.inner.observe(local);
  }
  async apply(request: EffectApplyRequest) {
    const local = this.local(request.target), content = (request.input as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') throw new EffectTargetError('EFFECT_TARGET_REJECTED');
    const written = await this.session.spend(local.id, Buffer.byteLength(content, 'utf8'), async () => {
      const parent = posix.dirname(local.id);
      if (parent !== '.') {
        try { await ensureScratchDirectories(this.session.dir, parent.split('/')); }
        catch (error) { throw new EffectTargetError('EFFECT_TARGET_REJECTED', { cause: error }); }
      }
      return this.inner.apply({ ...request, target: local });
    });
    if (!written.ok) throw new EffectTargetError('EFFECT_TARGET_REJECTED', { cause: new ScratchError('SCRATCH_QUOTA_EXCEEDED', written.error) });
    return written.value;
  }
  async lookup(ref: EffectTargetRef, idempotencyKey: string) { return this.inner.lookup(this.local(ref), idempotencyKey); }
}

const text = (description: string) => ({ type: 'string', description });
const readFileSpec = WORKSPACE_READ_TOOL_SPECS.find(spec => spec.name === 'read_file')!;
/** The scratch tools (SCR-A): no new tool class and no new decision cell — `scratch_write` is an edit, the other two are reads. */
export const SCRATCH_TOOL_SPECS: readonly AgentToolSpec[] = Object.freeze([
  { name: 'scratch_write', version: 1, toolClass: 'edit' as const, description: 'Create or replace a UTF-8 file in your scratch area: your own temporary '
    + 'space for this conversation, outside the project, for notes, drafts, intermediate data and diagrams (Mermaid .mmd or SVG as text). '
    + 'Paths are relative to the scratch area; missing directories are created. It never changes a project file.',
  inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: text('Path relative to the scratch area'),
    content: text('The complete file content') } } },
  { name: 'scratch_read', version: 1, toolClass: 'read' as const, description: 'Read a file of your scratch area; same options and result lines as read_file.',
    inputSchema: { ...readFileSpec.inputSchema, properties: { ...(readFileSpec.inputSchema['properties'] as Record<string, unknown>),
      path: text('Path relative to the scratch area.') } } },
  { name: 'scratch_list', version: 1, toolClass: 'read' as const, description: 'List a directory of your scratch area; directories end with "/".',
    inputSchema: { type: 'object', properties: { path: text('Directory relative to the scratch area (default: its top)') } } },
]);
const READ_AS: Readonly<Record<string, string>> = Object.freeze({ scratch_read: 'read_file', scratch_list: 'list_dir' });

/**
 * Opens this conversation's scratch area under the layout's `scratch` resource `root` (already a verified private product directory):
 * holds the area in the service's scratch custody first (waiting while a removal of it is in flight), then creates `<owner>/<session>`
 * (0700, no link followed) and marks it used now (its age decides retention); a failed open releases the hold. The area is a workspace
 * scope of its own with the Core read floor (a protected name is refused here too); reads use the workspace read tools over it.
 */
export async function openScratchSession(root: string, key: string, limits: ScratchLimits, custody: Pick<ScratchActivity, 'hold' | 'lane'>,
  readLimits: { readonly maxResultBytes?: number } = {}): Promise<ScratchSession> {
  if (!KEY.test(key)) throw new ScratchError('SCRATCH_KEY_INVALID');
  const release = await custody.hold(key);
  try { return await openHeld(root, key, limits, custody, readLimits, release); }
  catch (error) { release(); throw error; }
}

async function openHeld(root: string, key: string, limits: ScratchLimits, custody: Pick<ScratchActivity, 'lane'>,
  readLimits: { readonly maxResultBytes?: number }, release: () => void): Promise<ScratchSession> {
  await ensureScratchDirectories(root, key.split('/'));
  const now = new Date();
  await utimes(join(root, ...key.split('/')), now, now);
  const tools = await createWorkspaceReadTools(join(root, ...key.split('/')), { deny: DEFAULT_WORKSPACE_READ_DENY,
    ...(readLimits.maxResultBytes ? { limits: { maxResultBytes: readLimits.maxResultBytes } } : {}) });
  const scope = tools.scope, dir = scope.root, measured = { root, key, dir, scope, limits };
  const base = { ...measured, async spend<T>(rel: string, bytes: number, write: () => Promise<T>, signal?: AbortSignal) {
    const handOn = await custody.lane(signal);
    try {
      const refused = await quotaCheck(measured, rel, bytes);
      return refused && !refused.ok ? { ok: false as const, error: refused.error } : { ok: true as const, value: await write() };
    } finally { handOn(); }
  } };
  const writes: WorkspaceEditArea = Object.freeze({ operation: SCRATCH_FILE_WRITE_OPERATION,
    async plan(tool: string, args: Record<string, unknown>): Promise<WorkspaceEditPlan> {
      const content = args['content'];
      if (tool !== 'scratch_write' || typeof content !== 'string') return { ok: false, error: tool === 'scratch_write' ? 'invalid-arguments' : 'unknown-tool' };
      const bytes = Buffer.byteLength(content, 'utf8'), encoded = Buffer.byteLength(encodeCommandProjection('effect-input', { content }), 'utf8');
      if (bytes > limits.writeMaxBytes) return quotaRefusal(`write: ${bytes} > ${limits.writeMaxBytes} bytes`);
      // The write travels as the effect's input: its encoded form (content plus JSON escaping) must fit the catalog bound too.
      if (encoded > SCRATCH_FILE_WRITE_OPERATION.inputMaxBytes) return quotaRefusal(`write: ${encoded} > ${SCRATCH_FILE_WRITE_OPERATION.inputMaxBytes} encoded bytes`);
      let planned = await planWorkspaceEdit(scope, 'write_file', { path: args['path'], content }, limits.writeMaxBytes);
      if (!planned.ok && planned.error === 'parent-not-found') planned = await planIntoNewDirectories(scope, args['path'], content);
      return planned.ok ? await quotaCheck(base, planned.rel, bytes) ?? planned : planned;
    },
    floored: () => false, targetId: (rel: string) => `${key}/${rel}`, target: (journal: string) => new ScratchFileTarget(base, journal),
    shown: (rel: string) => join(dir, ...rel.split('/')) });
  return Object.freeze({ ...base, writes, release, reads: (tool: string) => Object.hasOwn(READ_AS, tool),
    async read(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolOutcome> {
      const as = READ_AS[tool];
      if (!as) return { status: 'error', text: `[deckent] ${tool}: error=unknown-tool` };
      const result = await tools.execute(as, args, signal);
      return { ...result, text: result.text.replaceAll(`[deckent] ${as}:`, `[deckent] ${tool}:`) };
    },
    // Not a `scratch_write` effect (its content would ride in the intent, bounded at 1 MiB): the producing effect owns the bytes, the area
    // owns the quota and the file. The check and the write are one transition in the custody's write lane (Astra 2149 R2): an exclusive
    // 0600 temporary file in the (link-free, created here) directory, flushed, then renamed.
    async deposit(rel: string, data: Uint8Array, signal?: AbortSignal) {
      const parts = rel.split('/');
      if (parts.some(part => !part || part === '.' || part === '..')) return { ok: false as const, error: 'invalid-path' };
      const written = await base.spend(rel, data.byteLength, async () => {
        await ensureScratchDirectories(dir, parts.slice(0, -1));
        const path = join(dir, ...parts), temporary = join(dir, ...parts.slice(0, -1), `.deposit-${randomUUID()}`);
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
        return path;
      }, signal);
      return written.ok ? { ok: true as const, path: written.value, rel } : { ok: false as const, error: written.error };
    } });
}
