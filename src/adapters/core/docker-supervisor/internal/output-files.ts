import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { outputFileNameSchema, type CollectedOutputFile } from '#engine/index.js';
const budget = z.number().int().positive().safe();
const pathSchema = z.string().min(1).refine(path => !path.includes('\\') && !path.includes(String.fromCharCode(0))
  && !isAbsolute(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
export const dockerOutputFilesSchema = z.object({ maxBytes: budget, maxFiles: budget,
  files: z.array(z.object({ name: outputFileNameSchema, path: pathSchema, maxBytes: budget }).strict()).min(1),
}).strict().refine(value => value.files.length <= value.maxFiles
  && new Set(value.files.map(file => file.name)).size === value.files.length
  && value.files.reduce((remaining, file) => remaining - file.maxBytes, value.maxBytes) >= 0).readonly();
/** Linux descriptor-relative traversal: never follow worker-controlled symlinks or block on a FIFO.
 * Workspace belongs to a stopped container. The host itself is trusted; other workers cannot mount it. */
export async function collectDockerOutputFiles(workspace: string, input: z.infer<typeof dockerOutputFilesSchema>) {
  const settings = dockerOutputFilesSchema.parse(input); const result: CollectedOutputFile[] = [];
  for (const file of settings.files) {
    const handles: FileHandle[] = [];
    try {
      if (process.platform !== 'linux' || await realpath(workspace) !== workspace) throw new Error('unsafe');
      let directory = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(directory);
      const parts = file.path.split('/');
      for (const part of parts.slice(0, -1)) {
        directory = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(directory);
      }
      const handle = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push(handle); const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid!()) throw new Error('unsafe');
      if (before.size > file.maxBytes) throw new Error('too-large');
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break; offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('changed');
      result.push(Object.freeze({ name: file.name, status: 'collected', bytes }));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const message = error instanceof Error ? error.message : '';
      const reason = code === 'ENOENT' ? 'missing' : code === 'ELOOP' || code === 'ENOTDIR' || message === 'unsafe' ? 'unsafe'
        : message === 'too-large' ? 'too-large' : message === 'changed' ? 'changed' : 'read-failed';
      result.push(Object.freeze({ name: file.name, status: 'unavailable', reason }));
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }
  return Object.freeze(result);
}
