import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorRegistry, sha256 } from '#platform/index.js';
import type { FirstCommitGit } from './first-commit.js';
const receiptSchema = z.object({ schemaVersion: z.literal(1), commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  pathsDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const recoveryNames = { receipt: 'deckent-first-commit-recovery.json', paths: 'deckent-first-commit-paths.nul' };
const PRIVATE_ACCESS_MASK = 0o077;
const GIT_ROW_OVERHEAD = 144; // mode, object type/hash and stage beside a maximum-size path.
const fail = (): never => { throw ErrorRegistry.createError('SETUP_FIRST_COMMIT_CHANGED'); };
async function privateRead(path: string, max: number) {
  if (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & PRIVATE_ACCESS_MASK) !== 0 || stat.size > max) fail();
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
export type FirstCommitRecovery = Readonly<{ state: 'none' | 'settled' | 'prepared' }> | Readonly<{ state: 'pending'; commit: string; paths: readonly string[];
  pathsFile: string; locked: boolean; overlap: readonly string[]; command: string | null }>;
/** No mutation. Same-path staged blobs are never erased by an offered recovery command. */
export async function inspectFirstCommitRecovery(git: FirstCommitGit, maxFiles: number, pathBytes: number): Promise<FirstCommitRecovery> {
  const directory = await git(['rev-parse', '--absolute-git-dir']);
  if (directory.code !== 0) return { state: 'none' };
  const gitDir = directory.stdout.trim();
  let raw: string;
  try { raw = await privateRead(join(gitDir, recoveryNames.receipt), 512); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' }; throw error; }
  const receipt = receiptSchema.parse(JSON.parse(raw)), pathsFile = join(gitDir, recoveryNames.paths);
  const nul = await privateRead(pathsFile, maxFiles * pathBytes);
  if (sha256(nul) !== receipt.pathsDigest || !nul.endsWith('\0')) fail();
  const paths = nul.split('\0').filter(Boolean);
  if (!paths.length || paths.length > maxFiles || paths.some(path => path.startsWith('/') || path.split('/').includes('..'))) fail();
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.code === 1) return { state: 'prepared' }; // Crash before update-ref: unborn; no committed effect to recover.
  if (head.code !== 0) fail();
  if (head.stdout.trim() !== receipt.commit) fail();
  const outputBytes = maxFiles * (pathBytes + GIT_ROW_OVERHEAD);
  const cached = await git(['ls-files', '--stage', '-z'], { outputBytes }), tree = await git(['ls-tree', '-r', '-z', receipt.commit], { outputBytes });
  if (cached.code !== 0 || cached.overflow || tree.code !== 0 || tree.overflow) fail();
  const entries = (text: string, treeMode: boolean) => new Map(text.split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t'), fields = row.slice(0, tab).split(' ');
    return [row.slice(tab + 1), `${fields[0]} ${fields[treeMode ? 2 : 1]}${!treeMode && fields[2] !== '0' ? ' conflict' : ''}`];
  }));
  const index = entries(cached.stdout, false), committed = entries(tree.stdout, true);
  const overlap = paths.filter(path => index.has(path) && index.get(path) !== committed.get(path));
  if (!overlap.length && paths.every(path => index.get(path) === committed.get(path))) return { state: 'settled' };
  const locked = await lstat(join(gitDir, 'index.lock')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
  // Shell single-quote escaping is independent of the filename contents. Git parses NUL literal pathspecs.
  const quoted = `'${pathsFile.replaceAll("'", "'\\''")}'`;
  return { state: 'pending', commit: receipt.commit, paths, pathsFile, overlap, locked,
    command: locked || overlap.length ? null : `git --literal-pathspecs reset -q ${receipt.commit} --pathspec-from-file=${quoted} --pathspec-file-nul` };
}
