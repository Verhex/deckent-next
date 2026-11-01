import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, opendir, readdir, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse } from 'node:path';
import { EffectTargetError, type EffectTarget, type EffectApplyRequest } from '#engine/index.js';
import { pathWithin as inside, PRIVATE_PERMISSION_MASK, readPinnedFile, recordedProcessState, removePinnedFile, removeEmptyPinnedDirectory } from '#platform/index.js';
/** `members`: the resource owner's naming, one anchored pattern per level below `path`; a last-level match is one owned tree. */
export interface CacheRemovalResource { readonly resourceId: string; readonly path: string; readonly ownershipDigest: string; readonly members: readonly string[] }
export interface CacheRemovalBounds { readonly maxEntries: number; readonly maxDepth: number }
/** Astra 2862/2864/2867 R2: writers of a resource written at process exit (Node's compile cache) record themselves (`<directory>/<pid>-…`); the removal `fence`
 * (exclusive, first; kept until the members are gone) stops new ones, then `<directory>` is renamed to `<directory>.<id>` (the linearization point);
 * removal waits for every record's process in every records directory — unreadable or outliving `budgetMs` refuses. The records are coordination,
 * never a member: removed with the cache but no part of the members or their version (the rename and a withdrawn record never move it; Astra 2876 R1:
 * a removed cache with an ended writer's leftover record observes as absent, so lookup proves `applied`), and a `<directory>` that reappears during
 * the removal is a late writer's, left to it. */
export type CacheWriterWitness = Readonly<{ resourceId: string; directory: string; fence: string; budgetMs: number; pollMs: number }>;
const rejected = (): never => { throw new EffectTargetError('EFFECT_TARGET_REJECTED'); };
/** The live records directory or one a removal renamed (`<directory>.<16 hex>`). */
const recordsDirectory = (witness: CacheWriterWitness, name: string) => name === witness.directory || name.startsWith(`${witness.directory}.`) && /^[0-9a-f]{16}$/u.test(name.slice(witness.directory.length + 1));
/** Disposal is restricted to the owner's named members below a registered path; unlisted entries and non-empty parents stay.
 * Directory removal is bounded, link-free and never recursive rm. */
export class InstallationCacheRemovalTarget implements EffectTarget {
  readonly kind: string;
  constructor(private readonly binding: string, private readonly resources: readonly CacheRemovalResource[],
    private readonly protectedPaths: readonly string[], private readonly bounds: CacheRemovalBounds,
    private readonly withCustody: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly operation = { kind: 'installation-cache', id: 'installation.remove-cache' }, private readonly writers?: CacheWriterWitness) {
    this.kind = operation.kind;
    if (process.platform === 'win32' || !process.getuid) rejected();
    if (!Number.isSafeInteger(bounds.maxEntries) || bounds.maxEntries < 1 || !Number.isSafeInteger(bounds.maxDepth) || bounds.maxDepth < 0) rejected();
  }
  identity() { return this.binding; }
  private resource(target: { kind: string; id: string }) {
    const found = this.resources.find(item => item.resourceId === target.id);
    if (target.kind !== this.kind || !found || !/^[a-f0-9]{64}$/u.test(found.ownershipDigest) || !isAbsolute(found.path)
      || found.path === parse(found.path).root || !found.members.length || found.members.some(pattern => !/^\^.*\$$/u.test(pattern))
      || this.protectedPaths.some(path => inside(found.path, path) || inside(path, found.path))) return rejected();
    return found;
  }
  private async scan(resource: CacheRemovalResource, removing = false) {
    const path = resource.path, witness = resource.resourceId === this.writers?.resourceId ? this.writers : undefined;
    // Reject symlink ancestors as well as links inside the disposable tree, even for an absent leaf.
    for (let ancestor = dirname(path);;) {
      if (await realpath(ancestor) !== ancestor) rejected();
      const info = await lstat(ancestor);
      if (!info.isDirectory() || (info.mode & 0o022) && !(info.mode & 0o1000)) rejected();
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    const entries: { path: string; directory: boolean; dev: number; ino: number; mtime: number; ctime: number; size: number }[] = [], records = new Set<string>();
    const members: string[] = [], unlisted: string[] = [], parents: string[] = [];
    const check = (info: import('node:fs').Stats, depth: number) => {
      if (depth > this.bounds.maxDepth || entries.length + unlisted.length >= this.bounds.maxEntries || info.isSymbolicLink()
        || info.uid !== process.getuid?.() || (info.mode & PRIVATE_PERMISSION_MASK) || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) rejected();
    };
    const visit = async (file: string, depth: number, record: boolean): Promise<void> => {
      const info = await lstat(file); check(info, depth);
      entries.push({ path: file, directory: info.isDirectory(), dev: info.dev, ino: info.ino, mtime: info.mtimeMs, ctime: info.ctimeMs, size: info.size }); if (record) records.add(file);
      if (info.isDirectory()) for await (const child of await opendir(file)) await visit(join(file, child.name), depth + 1, record);
    };
    // Only the owner's named members are claimed; anything else (a same-user stray file, another product's record) is kept and reported.
    const level = async (directory: string, depth: number): Promise<void> => {
      const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT' && directory === path) return null; throw error; });
      if (!info) return;
      check(info, depth); if (!info.isDirectory()) rejected();
      if (depth) parents.push(directory);
      for await (const child of await opendir(directory)) {
        const file = join(directory, child.name);
        if (!depth && witness && (child.name === witness.fence || removing && child.name === witness.directory)) continue; else if (!new RegExp(resource.members[depth]!, 'u').test(child.name)) { if (entries.length + unlisted.length >= this.bounds.maxEntries) rejected(); unlisted.push(file); }
        else if (depth === resource.members.length - 1) { const record = !depth && !!witness && recordsDirectory(witness, child.name); if (!record) members.push(file); await visit(file, depth + 1, record); }
        else await level(file, depth + 1);
      }
    };
    await level(path, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en')); members.sort(); unlisted.sort();
    const content = entries.filter(entry => !records.has(entry.path));
    return { entries, members, unlisted, parents: [...parents, path], version: content.length ? createHash('sha256').update(JSON.stringify(content)).digest('hex') : null };
  }
  /** Owner-named members, the unlisted entries a removal keeps, and the members' exact version (null when no member remains). */
  async inspect(target: { kind: string; id: string }) { const { members, unlisted, version } = await this.scan(this.resource(target)); return { members, unlisted, version }; }
  async observe(target: { kind: string; id: string }) { return { version: (await this.scan(this.resource(target))).version }; }
  async apply(request: EffectApplyRequest) {
    if (request.operation.id !== this.operation.id || request.operation.version !== 1) rejected();
    const resource = this.resource(request.target);
    return this.withCustody(async () => {
      await this.writersEnded(resource);
      const scan = await this.scan(resource, true);
      if (scan.version !== request.expectedVersion) throw new EffectTargetError('EFFECT_TARGET_PRECONDITION');
      let started = false;
      try {
        for (const entry of scan.entries.sort((a, b) => b.path.length - a.path.length)) {
          // Review follow-up: removal goes through the pinned parent (no link followed); a file must still be the scanned one, a member folder empty.
          const now = entry.directory ? null : (await readPinnedFile(entry.path).catch(() => null))?.identity, same = now && now.dev === entry.dev && now.ino === entry.ino;
          if (!entry.directory && (!same || now.size !== entry.size || now.mtimeMs !== entry.mtime)) rejected();
          started = true; if (entry.directory) await removeEmptyPinnedDirectory(entry.path, true); else await removePinnedFile(entry.path, now!);
        }
        // The fence goes once every member is gone; a parent that still holds an unlisted entry (or a writer's new one) is kept, never a member.
        if (resource.resourceId === this.writers?.resourceId) { const fence = join(resource.path, this.writers.fence), read = await readPinnedFile(fence); if (read) await removePinnedFile(fence, read.identity); }
        for (const parent of scan.parents.sort((a, b) => b.length - a.length)) await removeEmptyPinnedDirectory(parent);
        return { version: null };
      } catch (cause) { if (started) throw new EffectTargetError('EFFECT_TARGET_UNKNOWN', { cause }); throw cause; }
    });
  }
  private async writersEnded(resource: CacheRemovalResource) {
    const witness = this.writers; if (witness?.resourceId !== resource.resourceId) return;
    const fence = join(resource.path, witness.fence), until = performance.now() + witness.budgetMs, alive = async (file: string) => {
      const read = await readPinnedFile(file).catch(() => rejected()); if (!read) return false;   // withdrawn by its writer after the listing
      const record = (() => { try { return JSON.parse(read.bytes.toString('utf8')) as { pid?: unknown; startedAtMs?: unknown } | null; } catch { return null; } })(), pid = record?.pid, started = record?.startedAtMs;
      return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && typeof started === 'number' && Number.isFinite(started) && basename(file).startsWith(`${pid}-`) ? recordedProcessState(pid, started) === 'alive' : rejected(); };
    // The fence first (an existing one of a refused removal must be this user's plain single-link file, mode & 077 == 0); then no new writer fills.
    if (await open(fence, 'wx', 0o600).then(handle => handle.close(), async (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? 'absent'
      : error.code !== 'EEXIST' || ((await readPinnedFile(fence).catch(() => null))?.mode ?? 0o777) & PRIVATE_PERMISSION_MASK ? rejected() : undefined) === 'absent') return;
    // The linearization point: records made before it move with the directory and are waited for; a writer after it sees the fence.
    await rename(join(resource.path, witness.directory), join(resource.path, `${witness.directory}.${randomBytes(8).toString('hex')}`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') rejected(); });
    const listing = (directory: string) => readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : rejected());
    const recorded = async () => (await Promise.all((await listing(resource.path)).filter(name => recordsDirectory(witness, name))
      .map(async name => (await listing(join(resource.path, name))).map(record => join(resource.path, name, record))))).flat();
    while ((await Promise.all((await recorded()).map(alive))).some(Boolean)) {
      if (performance.now() >= until) rejected(); await new Promise(resolve => setTimeout(resolve, witness.pollMs)); }
  }
  async lookup(target: { kind: string; id: string }, idempotencyKey: string) {
    void idempotencyKey;
    return (await this.observe(target)).version === null ? { status: 'applied' as const, version: null } : null;
  }
}
