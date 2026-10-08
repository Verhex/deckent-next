import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { redactForRecord, type KnownSecretSnapshot } from '#platform/index.js';
import type { ProjectInstructionSource, ProjectInstructionView } from '#engine/index.js';
import REGISTRY from './registry.json' with { type: 'json' };

export const PROJECT_INSTRUCTION_REGISTRY = REGISTRY;
export const instructionDigest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** No symlink, hardlink, FIFO or device. Reads allocate only the registry bound plus one byte. */
export async function readInstructionFile(root: string, name: string, maxBytes: number): Promise<Buffer | null> {
  const path = join(root, name);
  let info;
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
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}

/** Trust lives in a private user-global managed directory, never a workspace-controlled record. */
export async function openProjectInstructionReader(rootInput: string, trustDirectory: string | null, known?: KnownSecretSnapshot) {
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
      for (const name of REGISTRY.files) {
        const bytes = await readInstructionFile(root, name, REGISTRY.maxBytes);
        if (bytes === null) continue;
        const source: ProjectInstructionSource = { path: join(root, name), bytes: bytes.length, digest: instructionDigest(bytes), content: redactForRecord(bytes.toString('utf8'), known) };
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
  return { root, inspect: load, async trust(digest: string): Promise<ProjectInstructionView> {
    const current = await load();
    if (current.status !== 'trust-required' && current.status !== 'ready') return current;
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
  } };
}
