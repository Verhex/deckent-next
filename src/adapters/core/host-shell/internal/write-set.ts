import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffectApprovalGate } from '#engine/index.js';
import { normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath, resolveGlobalScopePaths, resolveProductLayout, type ProductLayout } from '#platform/index.js';

/**
 * SHELL-OVERLAY bounds of one sandbox write set (fail closed: over any of them the whole set is refused, never partly applied): entries
 * listed in the upper directory plus the lower files a deleted or replaced directory removes, the bytes of all written files, one file.
 */
export const SANDBOX_WRITE_SET_BOUNDS = Object.freeze({ maxEntries: 2_000, maxTotalBytes: 64 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024, maxDepth: 32 });
const HELPER = fileURLToPath(new URL('../native/build/Release/shell-overlay-scan', import.meta.url));
const HELPER_TIMEOUT_MS = 10_000;

/** One change the sandboxed command made to the project, as the lower (the real project) must receive it. `lowerVersion`: the sha256 of the
 * lower file when scanned, or `absent` — the write's precondition. */
export type SandboxWriteChange = { readonly kind: 'write'; readonly rel: string; readonly digest: string; readonly size: number; readonly mode: number;
  readonly lowerVersion: string } | { readonly kind: 'delete'; readonly rel: string; readonly lowerVersion: string }
  /** A lower directory the command removed (Astra 2180 R1): an entry like the others — classified, decided, its own effect — applied after the
   * removals beneath it and only when it is empty then (the file target's `empty-directory` version). */
  | { readonly kind: 'rmdir'; readonly rel: string };
/** Why an entry cannot be applied at all (not a policy question: the kind of file). */
export type SandboxWriteRefusal = 'symbolic-link' | 'special-file' | 'hard-link' | 'setuid-setgid' | 'not-a-regular-file';
export type SandboxWriteSetScan = {
  readonly ok: true;
  readonly changes: readonly SandboxWriteChange[];
  readonly refused: readonly { readonly rel: string; readonly reason: SandboxWriteRefusal }[];
  /** Lower paths that changed after the call started (their ctime is not older than the start mark): the project moved under the call. */
  readonly conflicts: readonly string[];
  /** New directories the command left empty (not applied: directories are created only as parents of an applied file). */
  readonly emptyDirectories: readonly string[];
  /** Upper directory modes by path (a created parent gets the mode the command gave it). */
  readonly directoryModes: ReadonlyMap<string, number>;
  /** Directories the command made that the lower lacks (absent there, or a file there it replaced): a parent the apply would create, so
   * each is classified and decided like an entry before any is made (Astra 2182 R3). */
  readonly newDirectories: ReadonlySet<string>;
} | { readonly ok: false; readonly reason: string };

interface UpperEntry { readonly type: string; readonly mode: number; readonly nlink: number; readonly size: number; readonly rdev: readonly [number, number];
  readonly flags: string; readonly rel: string }

/** Runs the native lister (it reads the overlay xattrs Node cannot) and parses its NUL-terminated records. */
function listUpper(upper: string, maxEntries: number): Promise<{ readonly ok: true; readonly entries: readonly UpperEntry[] } | { readonly ok: false; readonly reason: string }> {
  return new Promise(resolve => {
    execFile(HELPER, [upper, String(maxEntries)], { encoding: 'buffer', maxBuffer: maxEntries * 4_200 + 65_536, timeout: HELPER_TIMEOUT_MS, env: {} }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as { code?: unknown }).code;
        resolve({ ok: false, reason: code === 3 ? `more than ${maxEntries} entries` : `the write set could not be listed (${String(stderr).trim().split('\n')[0] || String(code)})` });
        return;
      }
      const entries: UpperEntry[] = [];
      for (const record of stdout.toString('utf8').split('\0')) {
        if (record === '') continue;
        const match = /^([fdlcbps?]) ([0-7]+) (\d+) (\d+) (\d+) (\d+) ([-ormw]+) (.+)$/su.exec(record);
        if (!match) { resolve({ ok: false, reason: 'the write set listing was not understood' }); return; }
        entries.push({ type: match[1]!, mode: Number.parseInt(match[2]!, 8), nlink: Number(match[3]), size: Number(match[4]), rdev: [Number(match[5]), Number(match[6])],
          flags: match[7]!, rel: match[8]! });
      }
      resolve({ ok: true, entries });
    });
  });
}

const sha256File = async (path: string): Promise<string | null> => {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally { await handle.close(); }
};

/**
 * Reads the change set a sandboxed command left in its overlay upper directory (SHELL-OVERLAY, design §4–§5), against the real project
 * (`lower`). Called only after the command and every process it started ended (the PID namespace ends with the call), on Deckent's own
 * private directory. Overlay semantics under `userxattr` (kernel forces `redirect_dir=nofollow`, `metacopy=off`): a `c 0:0` entry is a
 * whiteout (deletion); a directory marked opaque hides every lower entry it does not hold; a rename is a deletion plus a creation (no
 * redirects). `redirect`/`metacopy`/whiteout-xattr metadata never appears under those settings and refuses the whole set if it does.
 * Links, special files, hard-linked and setuid/setgid files are refused per entry. Lower paths are only `lstat`ed and hashed, never
 * followed. A lower path whose ctime is not older than `startMark` (the call directory's own ctime, same kernel clock) changed during
 * the call: it is a conflict.
 */
export async function scanSandboxWriteSet(upper: string, lower: string, startMark: bigint,
  bounds: typeof SANDBOX_WRITE_SET_BOUNDS = SANDBOX_WRITE_SET_BOUNDS): Promise<SandboxWriteSetScan> {
  const listed = await listUpper(upper, bounds.maxEntries);
  if (!listed.ok) return listed;
  const inUpper = new Map(listed.entries.map(entry => [entry.rel, entry] as const));
  const changes: SandboxWriteChange[] = [], refused: { rel: string; reason: SandboxWriteRefusal }[] = [], conflicts = new Set<string>();
  const emptyDirectories: string[] = [], directoryModes = new Map<string, number>(), newDirectories = new Set<string>();
  let count = listed.entries.length, bytes = 0;
  const over = () => count > bounds.maxEntries ? `more than ${bounds.maxEntries} entries` : bytes > bounds.maxTotalBytes ? `more than ${bounds.maxTotalBytes} bytes` : null;
  const lowerInfo = async (rel: string) => { try { return await lstat(join(lower, rel), { bigint: true }); } catch { return null; } };
  const changed = (info: { readonly ctimeNs: bigint }, rel: string) => { if (info.ctimeNs >= startMark) conflicts.add(rel); };
  /** A lower file removed (its version is the precondition); a lower link cannot be removed through the file target: refused. */
  const removeFile = async (rel: string): Promise<string | null> => {
    const info = await lowerInfo(rel);
    if (!info) return null;
    changed(info, rel);
    if (info.isSymbolicLink()) { refused.push({ rel, reason: 'symbolic-link' }); return null; }
    if (!info.isFile()) { refused.push({ rel, reason: 'special-file' }); return null; }
    const version = await sha256File(join(lower, rel));
    if (version === null) { refused.push({ rel, reason: 'not-a-regular-file' }); return null; }
    changes.push({ kind: 'delete', rel, lowerVersion: version });
    return null;
  };
  /** A lower directory removed (Astra 2180 R1: never outside the entry path); a directory changed during the call is a conflict. */
  const removeDirectory = async (rel: string) => {
    const info = await lowerInfo(rel);
    if (!info?.isDirectory()) return;
    changed(info, rel);
    changes.push({ kind: 'rmdir', rel });
  };
  /** Every lower entry under a deleted or replaced directory, except the names the upper still holds (`keep`), deepest directories last. */
  const removeTree = async (rel: string, depth: number, keep: (child: string) => boolean): Promise<string | null> => {
    if (depth > bounds.maxDepth) return 'a deleted directory is deeper than the bound';
    let names;
    try { names = await readdir(join(lower, rel), { withFileTypes: true }); } catch { return `a deleted directory could not be read (${rel})`; }
    for (const entry of names) {
      const child = posix.join(rel, entry.name);
      if (keep(child)) continue;
      if (++count > bounds.maxEntries) return over();
      if (entry.isDirectory()) {
        const refusedTree = await removeTree(child, depth + 1, () => false);
        if (refusedTree) return refusedTree;
        await removeDirectory(child);
      } else {
        const refusedFile = await removeFile(child);
        if (refusedFile) return refusedFile;
      }
    }
    return null;
  };
  for (const entry of listed.entries) {
    const { rel } = entry;
    if (/[rmw]/.test(entry.flags)) return { ok: false, reason: `unsupported overlay metadata (${rel})` };
    const below = await lowerInfo(rel);
    if (entry.type === 'c' && entry.rdev[0] === 0 && entry.rdev[1] === 0) {
      // Overlayfs writes a whiteout only over a lower entry that existed at the unlink: a lower that is gone now was removed during the call.
      if (!below) { conflicts.add(rel); continue; }
      if (below.isDirectory()) {
        const refusedTree = await removeTree(rel, 0, () => false);
        if (refusedTree) return { ok: false, reason: refusedTree };
        await removeDirectory(rel);
      } else await removeFile(rel);
      continue;
    }
    if (entry.type === 'd') {
      directoryModes.set(rel, entry.mode & 0o777);
      if (!below?.isDirectory()) newDirectories.add(rel);
      if (below && !below.isDirectory()) await removeFile(rel);
      else if (below && entry.flags.includes('o')) {
        // Opaque over a lower directory: what the lower holds and the upper does not is gone (the directory was removed and made again).
        const refusedTree = await removeTree(rel, 0, child => inUpper.has(child));
        if (refusedTree) return { ok: false, reason: refusedTree };
      }
      if (!below && !listed.entries.some(other => other.rel.startsWith(`${rel}/`))) emptyDirectories.push(rel);
      continue;
    }
    if (entry.type === 'l') { refused.push({ rel, reason: 'symbolic-link' }); continue; }
    if (entry.type !== 'f') { refused.push({ rel, reason: 'special-file' }); continue; }
    if (entry.nlink > 1) { refused.push({ rel, reason: 'hard-link' }); continue; }
    if ((entry.mode & 0o7000) !== 0) { refused.push({ rel, reason: 'setuid-setgid' }); continue; }
    if (entry.size > bounds.maxFileBytes) return { ok: false, reason: `a file is larger than ${bounds.maxFileBytes} bytes (${rel})` };
    bytes += entry.size;
    const tooMuch = over();
    if (tooMuch) return { ok: false, reason: tooMuch };
    const digest = await sha256File(join(upper, rel));
    if (digest === null) return { ok: false, reason: `a written file could not be read (${rel})` };
    let lowerVersion = 'absent';
    if (below) {
      changed(below, rel);
      if (below.isSymbolicLink()) { refused.push({ rel, reason: 'symbolic-link' }); continue; }
      if (below.isDirectory()) {
        // A lower directory replaced by a file: its whole tree goes first.
        const refusedTree = await removeTree(rel, 0, () => false);
        if (refusedTree) return { ok: false, reason: refusedTree };
        await removeDirectory(rel);
      } else if (below.isFile()) {
        const version = await sha256File(join(lower, rel));
        if (version === null) { refused.push({ rel, reason: 'not-a-regular-file' }); continue; }
        // A copy-up without a change (opened for writing, touched) is no change.
        if (version === digest && (Number(below.mode) & 0o777) === (entry.mode & 0o777)) { conflicts.delete(rel); continue; }
        lowerVersion = version;
      } else { refused.push({ rel, reason: 'special-file' }); continue; }
    }
    changes.push({ kind: 'write', rel, digest, size: entry.size, mode: entry.mode & 0o777, lowerVersion });
  }
  const tooMuch = over();
  if (tooMuch) return { ok: false, reason: tooMuch };
  // File removals first, then directory removals deepest first, then writes: a lower directory replaced by a file is emptied and removed
  // before the file is written.
  const order = (change: SandboxWriteChange) => change.kind === 'delete' ? 0 : change.kind === 'rmdir' ? 1 : 2;
  const depth = (change: SandboxWriteChange) => change.kind === 'rmdir' ? -change.rel.split('/').length : 0;
  return { ok: true, changes: [...changes].sort((a, b) => order(a) - order(b) || depth(a) - depth(b)), refused, conflicts: [...conflicts].sort(), emptyDirectories, directoryModes,
    newDirectories };
}

/** A call's private directory: `upper` and `work` for the overlay and the start mark (the directory's own ctime, the kernel clock). */
export interface SandboxWriteSetDirectory { readonly dir: string; readonly upper: string; readonly work: string; readonly mark: bigint }
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };
/** Removes a call directory (the kernel may leave `work/work` without permissions). */
export async function removeSandboxWriteSetDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(async () => {
    await chmod(join(dir, 'work', 'work'), 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
}
/**
 * Creates a call's directory under `root` (a private directory outside the project; never reused: `EEXIST` refuses) after removing the
 * directories whose service process is gone — a crash before their set was applied: nothing of them is ever applied late (design §3).
 */
export async function prepareSandboxWriteSetDirectory(root: string, callKey: string): Promise<SandboxWriteSetDirectory | null> {
  for (const entry of await readdir(root).catch(() => [] as string[])) {
    const owner = await readFile(join(root, entry, 'owner.json'), 'utf8').then(text => Number(JSON.parse(text).pid)).catch(() => null);
    if (owner !== null && owner !== process.pid && !alive(owner)) await removeSandboxWriteSetDirectory(join(root, entry));
  }
  const dir = join(root, callKey);
  try {
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: 'wx' });
    await mkdir(join(dir, 'upper'), { mode: 0o700 }); await mkdir(join(dir, 'work'), { mode: 0o700 });
    return { dir, upper: join(dir, 'upper'), work: join(dir, 'work'), mark: (await lstat(dir, { bigint: true })).ctimeNs };
  } catch { return null; }
}

/** The edit cell a write-set entry is decided under (the same three an edit tool call can be), or a path the edit rules deny. */
export type SandboxWriteCell = 'edit' | 'edit-floor' | 'edit-authority' | 'edit-self-source';
export type SandboxWriteDecision = { readonly ok: true; readonly gate: EffectApprovalGate }
  | { readonly ok: false; readonly reason: 'write-floor' | 'configuration-file' | 'approval-required' | 'denied-by-policy' | 'audit-unavailable' };
/** Decides one entry exactly like an edit of that path (design §6); the decision's owner audits a relaxation before handing out the gate. */
export interface SandboxWriteDecider { decide(rel: string, cell: SandboxWriteCell): Promise<SandboxWriteDecision> }
export interface SandboxWriteSetReport {
  /** The whole set was not applied (its bound or its listing); null otherwise. */
  readonly refused: string | null;
  readonly applied: readonly string[];
  readonly notApplied: readonly { readonly rel: string; readonly reason: string }[];
  /** The project changed under the call: nothing was applied. */
  readonly conflicts: readonly string[];
  /** Entries whose outcome is unknown: read the file to see its state. */
  readonly unknown: readonly string[];
  readonly emptyDirectories: readonly string[];
  /** New directories made as parents of applied entries (each decided like an entry; not a C11 record of its own). */
  readonly createdDirectories: readonly string[];
  /** Stopped before the end (cancellation, a precondition that changed at write time, an unknown outcome): the rest was not tried. */
  readonly stopped: boolean;
}
const REASONS: Readonly<Record<string, string>> = {
  'write-floor': 'write floor: the owner approves — use edit_file/write_file',
  'configuration-file': 'the installation\'s configuration file: the owner approves — use edit_file/write_file', 'approval-required': 'needs the owner\'s approval — use edit_file/write_file',
  'denied-by-policy': 'denied by policy', 'audit-unavailable': 'the decision could not be recorded', denied: 'denied path', 'symbolic-link': 'symbolic link',
  'special-file': 'special file', 'hard-link': 'hard link', 'setuid-setgid': 'setuid/setgid bit', 'not-a-regular-file': 'not a regular file',
  'parent-refused': 'its directory could not be created', 'not-empty': 'something beneath it was not applied, so it is not empty', rejected: 'the write was refused', conflict: 'changed during the apply (conflict)',
};
const list = (items: readonly string[], max = 20) => items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')}, … (${items.length - max} more)`;
/** The result lines (trusted metadata, bounded): what the project received from the call and what it did not, and why. */
export function describeSandboxWriteSet(report: SandboxWriteSetReport): string {
  if (report.refused !== null) return `[deckent] write set: nothing was applied (${report.refused}); the project is unchanged.`;
  return [report.conflicts.length ? `[deckent] write set: nothing was applied — the project changed during the call: ${list(report.conflicts)}.` : '',
    report.applied.length ? `[deckent] write set: applied ${report.applied.length} (${list(report.applied)}).` : '',
    report.notApplied.length ? `[deckent] write set: not applied: ${list(report.notApplied.map(entry => `${entry.rel} (${REASONS[entry.reason] ?? entry.reason})`), 12)}.` : '',
    report.unknown.length ? `[deckent] write set: outcome unknown (read the file to see its state): ${list(report.unknown)}.` : '',
    report.stopped ? '[deckent] write set: stopped before the end; the rest was not applied.' : '',
    report.createdDirectories.length ? `[deckent] write set: new directories created: ${list(report.createdDirectories.map(directory => `${directory}/`))}.` : '',
    report.emptyDirectories.length ? `[deckent] write set: empty new directories were not created: ${list(report.emptyDirectories)}.` : ''].filter(Boolean).join('\n');
}

/**
 * Applies a scanned write set (design §5–§6) through the caller's ports: `classify` is the edit path rules (a denied path, else its cell),
 * `decider` the edit decision, `execute` one entry's C11 effect with the gate the decision handed out. A conflict found by the scan
 * applies nothing; deletions go first, then emptied directories, then writes (with their missing parents); a changed precondition or an
 * unknown outcome stops the rest. Nothing is applied to a path the decision did not allow — a new parent directory included (Astra 2182
 * R3): after the write's own decision, each one it needs is classified as a directory and decided like an entry (once per set, shown as
 * `dir/`); when any is refused,
 * none of them is made and the write is not applied (`parent-refused`); `ensureParents` makes only the decided ones.
 */
export async function applySandboxWriteSet(input: { readonly scan: SandboxWriteSetScan; readonly decider: SandboxWriteDecider;
  /** The edit path rules for one entry (a directory removal or a new parent directory, `mkdir`, is classified as a directory: its own name
   * and what lies beneath it). */
  readonly classify: (rel: string, kind: SandboxWriteChange['kind'] | 'mkdir') => SandboxWriteCell | 'denied';
  /** Makes the missing directories above `rel`, only those `admit` names (the decided ones); false when any other would be needed. */
  readonly ensureParents: (rel: string, modeOf: (directory: string) => number, admit: (directory: string) => boolean) => Promise<boolean>;
  readonly execute: (change: SandboxWriteChange, gate: EffectApprovalGate) => Promise<void>; readonly signal: AbortSignal }): Promise<SandboxWriteSetReport> {
  const { scan } = input;
  const report = { refused: null, applied: [] as string[], notApplied: [] as { rel: string; reason: string }[], conflicts: [] as readonly string[], unknown: [] as string[],
    emptyDirectories: [] as readonly string[], createdDirectories: [] as string[], stopped: false };
  if (!scan.ok) return { ...report, refused: scan.reason };
  report.notApplied.push(...scan.refused);
  if (scan.conflicts.length) return { ...report, conflicts: scan.conflicts };
  report.emptyDirectories = scan.emptyDirectories;
  const shown = (change: SandboxWriteChange) => change.kind === 'rmdir' ? `${change.rel}/` : change.rel;
  // Astra 2180 R1: a directory removal is an entry like any other (classified, decided, its own effect, reported); it is held back when
  // anything beneath it stayed (held back, refused or unknown), since the directory is not empty then.
  const stayedBeneath = (rel: string) => [...report.notApplied.map(entry => entry.rel), ...report.unknown].some(other => other.startsWith(`${rel}/`));
  // Astra 2182 R3: the new directories above a write, shallowest first, each decided once per set like an entry; the new ones this write
  // still needs, or null when one of them is refused (reported once, as `dir/` with its own reason).
  const verdicts = new Map<string, boolean>(), created = new Set<string>();
  const newParents = async (rel: string): Promise<string[] | null> => {
    const needed: string[] = [], segments = rel.split('/');
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join('/');
      if (!scan.newDirectories.has(directory) || created.has(directory)) continue;
      let allowed = verdicts.get(directory);
      if (allowed === undefined) {
        const cell = input.classify(directory, 'mkdir');
        const decision = cell === 'denied' ? { ok: false as const, reason: 'denied' } : await input.decider.decide(`${directory}/`, cell);
        allowed = decision.ok;
        verdicts.set(directory, allowed);
        if (!decision.ok) report.notApplied.push({ rel: `${directory}/`, reason: decision.reason });
      }
      if (!allowed) return null;
      needed.push(directory);
    }
    return needed;
  };
  for (const phase of ['delete', 'rmdir', 'write'] as const) {
    for (const change of scan.changes.filter(entry => entry.kind === phase)) {
      if (report.stopped || input.signal.aborted) { report.stopped = true; break; }
      if (change.kind === 'rmdir' && stayedBeneath(change.rel)) { report.notApplied.push({ rel: shown(change), reason: 'not-empty' }); continue; }
      const cell = input.classify(change.rel, change.kind);
      if (cell === 'denied') { report.notApplied.push({ rel: shown(change), reason: 'denied' }); continue; }
      const decision = await input.decider.decide(change.rel, cell);
      if (!decision.ok) { report.notApplied.push({ rel: shown(change), reason: decision.reason }); continue; }
      // The entry's own reason comes first (a refused entry never decides its directories); then each new directory it needs.
      const parents = change.kind === 'write' ? await newParents(change.rel) : [];
      if (parents === null) { report.notApplied.push({ rel: change.rel, reason: 'parent-refused' }); continue; }
      if (change.kind === 'write' && !await input.ensureParents(change.rel, directory => scan.directoryModes.get(directory) ?? 0o755, directory => verdicts.get(directory) === true)) {
        report.notApplied.push({ rel: change.rel, reason: 'parent-refused' }); continue;
      }
      for (const directory of parents) { created.add(directory); report.createdDirectories.push(directory); }
      try { await input.execute(change, decision.gate); report.applied.push(shown(change)); }
      catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code === 'EFFECT_PRECONDITION_CHANGED') { report.notApplied.push({ rel: shown(change), reason: 'conflict' }); report.stopped = true; }
        else if (code === 'EFFECT_OUTCOME_UNKNOWN') { report.unknown.push(shown(change)); report.stopped = true; }
        else report.notApplied.push({ rel: shown(change), reason: code === 'POLICY_DENIED' ? 'denied-by-policy' : code === 'EFFECT_APPROVAL_REQUIRED' ? 'approval-required' : 'rejected' });
      }
    }
  }
  return report;
}

/**
 * Where a call's write-set directories may live (SHELL-OVERLAY design §0.1, §3): the project data root's `fileEffects`, then the global state
 * root's — the first private one whose real path neither holds nor sits inside the project (overlay layers may not nest). None → no write set.
 */
export async function sandboxWriteSetRoot(projectRoot: string, layout: ProductLayout, environment: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const project = await realpath(projectRoot);
  const outside = (path: string) => { const down = relative(project, path), up = relative(path, project);
    return down !== '' && (down.startsWith('..') || isAbsolute(down)) && (up.startsWith('..') || isAbsolute(up)); };
  const candidates: (() => Promise<string>)[] = [
    async () => join(await prepareProductDirectory(layout, 'fileEffects'), 'sandbox-writes'),
    async () => {
      const global = resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, environment), environment).stateDir;
      return join(productResourcePath(resolveProductLayout({ projectRoot: global, root: global }), 'fileEffects'), 'sandbox-writes', createHash('sha256').update(project).digest('hex').slice(0, 16));
    },
  ];
  for (const candidate of candidates) {
    try {
      const path = await candidate();
      await mkdir(path, { recursive: true, mode: 0o700 });
      const real = await realpath(path), info = await stat(real);
      if (real === path && info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid!() && outside(real)) return real;
    } catch { /* the next candidate */ }
  }
  return null;
}
