import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { redactForRecord, withConfigWriteLock, type KnownSecretSnapshot } from '#platform/index.js';
import type { CommittedInstructionSource, ProjectInstructionSource, ProjectInstructionView } from '#engine/index.js';
import REGISTRY from './registry.json' with { type: 'json' };

export const PROJECT_INSTRUCTION_REGISTRY = REGISTRY;
export const instructionDigest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** No symlink, hardlink, FIFO or device, also for any directory of a nested name. Reads allocate only the registry bound plus one byte. */
export async function readInstructionFile(root: string, name: string, maxBytes: number): Promise<Buffer | null> {
  return (await readIdentifiedFile(root, name, maxBytes))?.bytes ?? null;
}
/** The same bounded read, also naming the identity of the file it verified (for a trust card's binding). */
async function readIdentifiedFile(root: string, name: string, maxBytes: number): Promise<Readonly<{ bytes: Buffer; dev: number; ino: number }> | null> {
  const path = join(root, name);
  let info, directory = root;
  for (const part of name.split('/').slice(0, -1)) {
    directory = join(directory, part);
    try { info = await lstat(directory); } catch (error) { if (missing(error)) return null; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe');
  }
  try { info = await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe');
  if (info.size > maxBytes) throw new Error('size');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || info.dev !== opened.dev || info.ino !== opened.ino) throw new Error('unsafe');
    const bytes = Buffer.alloc(maxBytes + 1); let used = 0;
    while (used < bytes.length) {
      const result = await handle.read(bytes, used, bytes.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > maxBytes) throw new Error('size');
    const after = await lstat(path), end = await handle.stat();
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || end.size !== opened.size || end.mtimeMs !== opened.mtimeMs) throw new Error('unsafe');
    return { bytes: bytes.subarray(0, used), dev: opened.dev, ino: opened.ino };
  } finally { await handle.close(); }
}

/** Legacy folder + content trust (REVISE 2738 R1, lead): the bare records that already existed when this release first opened the trust folder
 * (alpha.53's, such as a work target trusted before alpha.54), sealed once in one private snapshot before any write of this release. Only these
 * unlock a committed read; a folder + content record written later (no target, the terminal) never does. The snapshot is rewritten only to
 * remove entries, atomically under the shared write lock; alpha.53 never reads it. Lines: `<record name> <digest>`, bounded by registry data. */
const HEX = /^[a-f0-9]{64}$/u, LEGACY = REGISTRY.legacyTrust, LEGACY_HEADER = 'deckent-legacy-folder-trust:1\n';
const DIGEST_CHARS = instructionDigest('').length, LEGACY_BYTES = Buffer.byteLength(LEGACY_HEADER) + LEGACY.maxEntries * (2 * DIGEST_CHARS + ' \n'.length);
/** An owner-private, single-link, no-follow 0600 file of the trust folder, up to `max` bytes; anything else reads as null (fail closed). */
async function privateRecord(directory: string, name: string, max: number): Promise<string | null> {
  try {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) return null;
    return (await readInstructionFile(directory, name, max))?.toString('utf8') ?? null;
  } catch { return null; }
}
async function legacyEntries(directory: string): Promise<Map<string, string> | null> {
  const text = await privateRecord(directory, LEGACY.file, LEGACY_BYTES);
  if (text === null || !text.startsWith(LEGACY_HEADER)) return null;
  const entries = new Map<string, string>();
  for (const line of text.slice(LEGACY_HEADER.length).split('\n').filter(Boolean)) {
    const [name, digest, extra] = line.split(' ');
    if (extra !== undefined || !name || !digest || !HEX.test(name) || !HEX.test(digest)) return null;
    entries.set(name, digest);
  }
  return entries;
}
/** O_EXCL temporary, fsync, rename, directory fsync: a crash leaves the old or the new snapshot. */
async function writeLegacy(directory: string, entries: ReadonlyMap<string, string>) {
  const temporary = join(directory, `.${LEGACY.file}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try { await handle.writeFile(LEGACY_HEADER + [...entries].map(([name, digest]) => `${name} ${digest}\n`).join('')); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(directory, LEGACY.file)); renamed = true;
    const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { if (!renamed) await unlink(temporary).catch(() => undefined); }
}
/** Seals the snapshot once (every reader of this release calls it before it can write); a failure refuses the store, never writes unsnapshotted. */
async function captureLegacy(directory: string) {
  const path = join(directory, LEGACY.file);
  const present = async () => { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } };
  if (await present()) return;
  await withConfigWriteLock(path, async () => {
    if (await present()) return;
    const entries = new Map<string, string>();
    for await (const entry of await opendir(directory)) {
      if (entries.size >= LEGACY.maxEntries) break; // beyond the bound a legacy trust is asked again (fail closed)
      if (!HEX.test(entry.name)) continue;
      const body = await privateRecord(directory, entry.name, DIGEST_CHARS);
      if (body !== null && HEX.test(body)) entries.set(entry.name, body); // the bare-digest (folder + content) form only
    }
    await writeLegacy(directory, entries);
  });
}
/** Removes one entry (true: it was there); an absent or invalid snapshot is left as it is (nothing in it counts). */
async function forgetLegacy(directory: string, name: string) {
  if (!(await legacyEntries(directory))?.has(name)) return false;
  return withConfigWriteLock(join(directory, LEGACY.file), async () => {
    const entries = await legacyEntries(directory);
    if (!entries?.delete(name)) return false;
    await writeLegacy(directory, entries); return true;
  });
}

/** The file a trust card showed: its path and, for a working-tree read, its identity (null for a committed blob, bound by path and digest). */
export type ExpectedInstructionFile = Readonly<{ path: string; dev: number | null; ino: number | null }>;
/** Trust lives in a private user-global managed directory, never a workspace-controlled record. */
/** `files` narrows the candidates (a worker selection reads exactly one file); the default keeps the terminal's DECKENT.md → AGENTS.md order.
 * `committed` (alpha.54 R1: a work target's base ref) reads each file from that ref's commit instead of the working tree.
 * Trust records (REVISE 2738 R1, owner Q5): a working-tree read keys consent by this folder + content digest, as alpha.53 did. A committed read
 * keys a NEW grant by folder + ref + digest in its own tagged form, so another ref or the working tree with the same bytes is not trusted by it.
 * Legacy rule: a committed read also honours a folder + digest record, but only one sealed in the legacy snapshot (it existed before this release
 * first opened the store); it never writes that form. Its revoke removes its ref record and the legacy entry, never the folder's own record. */
export async function openProjectInstructionReader(rootInput: string, trustDirectory: string | null, known?: KnownSecretSnapshot, files: readonly string[] = REGISTRY.files,
  committed?: CommittedInstructionSource) {
  const root = await realpath(rootInput), identity = await stat(root);
  const rootDigest = instructionDigest(`${root}\0${identity.dev}\0${identity.ino}`);
  const sessionTrusted = new Set<string>();
  if (trustDirectory) {
    const info = await lstat(trustDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error('unsafe');
    const trustRoot = await realpath(trustDirectory), rel = relative(root, trustRoot);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('unsafe');
    await captureLegacy(trustDirectory);
  }
  // A record's name binds what it trusts; its content names its kind (the bare digest is the folder + content form, never written for a ref).
  const ref = committed?.ref ?? null, REF_TAG = 'ref-trust:1';
  const folderRecord = (digest: string) => ({ name: instructionDigest(`${rootDigest}\0${digest}`), body: digest });
  const refRecord = (digest: string, at: string) => ({ name: instructionDigest(`${rootDigest}\0${REF_TAG}\0${at}\0${digest}`), body: `${REF_TAG}\n${digest}` });
  const grant = (digest: string) => ref === null ? folderRecord(digest) : refRecord(digest, ref); // what a trust here writes
  const recorded = async ({ name, body }: { name: string; body: string }) => (await privateRecord(trustDirectory!, name, 256)) === body;
  const consented = async (digest: string) => ref === null ? recorded(folderRecord(digest)) : await recorded(refRecord(digest, ref))
    || (await recorded(folderRecord(digest)) && (await legacyEntries(trustDirectory!))?.get(folderRecord(digest).name) === digest);
  const load = async (): Promise<ProjectInstructionView> => {
    try {
      const currentRoot = await stat(root);
      if (currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino) throw new Error('unsafe');
      for (const name of files) {
        const read = committed ? await committed.read(name, REGISTRY.maxBytes) : await readIdentifiedFile(root, name, REGISTRY.maxBytes);
        if (read === null) continue;
        const { bytes } = read;
        const source: ProjectInstructionSource = { path: committed ? `${committed.ref}:${name}` : join(root, name), bytes: bytes.length, digest: instructionDigest(bytes),
          content: redactForRecord(bytes.toString('utf8'), known),
          identity: 'commit' in read ? { kind: 'ref', ref: committed!.ref, commit: read.commit, blobOid: read.blobOid } : { kind: 'file', dev: read.dev, ino: read.ino } };
        if (Buffer.byteLength(source.content) > REGISTRY.maxBytes) return { status: 'blocked', reason: 'size' };
        // Only an owner-private, no-follow record counts; an absent/invalid cache asks again.
        let trusted = sessionTrusted.has(grant(source.digest).name);
        if (!trusted && trustDirectory) trusted = await consented(source.digest); // fail closed: cached consent is a convenience
        const endRoot = await stat(root);
        if (endRoot.dev !== identity.dev || endRoot.ino !== identity.ino) throw new Error('unsafe');
        return { status: trusted ? 'ready' : 'trust-required', source };
      }
      return { status: 'absent' };
    } catch (error) {
      const reason = error instanceof Error && (error.message === 'size' || error.message === 'unsafe') ? error.message : 'unreadable';
      return { status: 'blocked', reason };
    }
  };
  // REVISE 2734 R1: a writer that names the exact file it showed acts only when the read just before the write is that file (path + identity).
  const sameFile = ({ path, identity }: ProjectInstructionSource, expected?: ExpectedInstructionFile) => !expected || (path === expected.path
    && (identity.kind === 'file' ? identity.dev === expected.dev && identity.ino === expected.ino : expected.dev === null && expected.ino === null));
  return { root, identity: { dev: identity.dev, ino: identity.ino }, inspect: load, async trust(digest: string, expected?: ExpectedInstructionFile): Promise<ProjectInstructionView> {
    const current = await load();
    if (current.status !== 'trust-required' && current.status !== 'ready') return current;
    if (!sameFile(current.source, expected)) throw new Error('changed');
    if (current.source.digest !== digest) return { status: 'trust-required', source: current.source };
    const { name, body } = grant(digest);
    if (trustDirectory) {
      try {
        const handle = await open(join(trustDirectory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    // Accept the exact already-masked snapshot; later disk changes never mutate this context.
    sessionTrusted.add(name);
    return { status: 'ready', source: current.source };
  },
  /** Takes back consent for exactly this folder and digest: a working-tree read removes the folder + digest record, a committed read this ref's
   * record — never another ref's nor the folder's own; both drop the legacy entry, so a later folder trust never reopens a ref (true: something
   * persisted was removed). An absent record is already untrusted.
   * With `expected`, only while that exact file with that digest is still the one read here (else `changed`, nothing removed). */
  async revoke(digest: string, expected?: ExpectedInstructionFile): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('unsafe');
    if (expected) {
      const current = await load();
      if ((current.status !== 'trust-required' && current.status !== 'ready') || !sameFile(current.source, expected) || current.source.digest !== digest) throw new Error('changed');
    }
    sessionTrusted.delete(grant(digest).name);
    if (!trustDirectory) return false;
    const path = join(trustDirectory, grant(digest).name);
    let removed = false;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe');
      await unlink(path); removed = true;
    } catch (error) { if (!missing(error)) throw error; }
    return await forgetLegacy(trustDirectory, folderRecord(digest).name) || removed;
  } };
}
