import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';
import type { ProjectInstructionSource, ProjectInstructionView } from '#engine/index.js';
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

/** The file a trust card showed: its path and identity. */
export type ExpectedInstructionFile = Readonly<{ path: string; dev: number; ino: number }>;
/** Trust lives in a private user-global managed directory, never a workspace-controlled record. */
/** `files` narrows the candidates (a worker selection reads exactly one file); the default keeps the terminal's DECKENT.md → AGENTS.md order. */
export async function openProjectInstructionReader(rootInput: string, trustDirectory: string | null, known?: KnownSecretSnapshot, files: readonly string[] = REGISTRY.files) {
  const root = await realpath(rootInput), identity = await stat(root);
  const rootDigest = instructionDigest(`${root}\0${identity.dev}\0${identity.ino}`);
  const sessionTrusted = new Set<string>();
  if (trustDirectory) {
    const info = await lstat(trustDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error('unsafe');
    const trustRoot = await realpath(trustDirectory), rel = relative(root, trustRoot);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('unsafe');
  }
  const trustPath = (digest: string) => join(trustDirectory!, instructionDigest(`${rootDigest}\0${digest}`));
  const load = async (): Promise<ProjectInstructionView> => {
    try {
      const currentRoot = await stat(root);
      if (currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino) throw new Error('unsafe');
      for (const name of files) {
        const read = await readIdentifiedFile(root, name, REGISTRY.maxBytes);
        if (read === null) continue;
        const { bytes } = read;
        const source: ProjectInstructionSource = { path: join(root, name), bytes: bytes.length, digest: instructionDigest(bytes), content: redactForRecord(bytes.toString('utf8'), known),
          identity: { dev: read.dev, ino: read.ino } };
        if (Buffer.byteLength(source.content) > REGISTRY.maxBytes) return { status: 'blocked', reason: 'size' };
        // Only an owner-private, no-follow record counts; an absent/invalid cache asks again.
        let trusted = sessionTrusted.has(source.digest);
        if (trustDirectory && !trusted) {
          try {
            const info = await lstat(trustPath(source.digest));
            if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600) {
              trusted = (await readInstructionFile(trustDirectory, instructionDigest(`${rootDigest}\0${source.digest}`), 256))?.toString('utf8') === source.digest;
            }
          } catch { /* fail closed: cached consent is a convenience */ }
        }
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
  const sameFile = (source: ProjectInstructionSource, expected?: ExpectedInstructionFile) => !expected
    || (source.path === expected.path && source.identity.dev === expected.dev && source.identity.ino === expected.ino);
  return { root, identity: { dev: identity.dev, ino: identity.ino }, inspect: load, async trust(digest: string, expected?: ExpectedInstructionFile): Promise<ProjectInstructionView> {
    const current = await load();
    if (current.status !== 'trust-required' && current.status !== 'ready') return current;
    if (!sameFile(current.source, expected)) throw new Error('changed');
    if (current.source.digest !== digest) return { status: 'trust-required', source: current.source };
    if (trustDirectory) {
      try {
        const handle = await open(trustPath(digest), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(digest); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    // Accept the exact already-masked snapshot; later disk changes never mutate this context.
    sessionTrusted.add(digest);
    return { status: 'ready', source: current.source };
  },
  /** Takes back consent for exactly this folder and digest (true: a persisted record was removed). An absent record is already untrusted.
   * With `expected`, only while that exact file with that digest is still the one read here (else `changed`, nothing removed). */
  async revoke(digest: string, expected?: ExpectedInstructionFile): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('unsafe');
    if (expected) {
      const current = await load();
      if ((current.status !== 'trust-required' && current.status !== 'ready') || !sameFile(current.source, expected) || current.source.digest !== digest) throw new Error('changed');
    }
    sessionTrusted.delete(digest);
    if (!trustDirectory) return false;
    try {
      const info = await lstat(trustPath(digest));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe');
      await unlink(trustPath(digest));
      return true;
    } catch (error) { if (missing(error)) return false; throw error; }
  } };
}
