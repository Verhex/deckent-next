import { lstat, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { SupervisorError } from '#engine/index.js';

const path = z.string().min(1).refine(value => isAbsolute(value) && !value.includes(String.fromCharCode(0)) && !/[,\r\n]/u.test(value));
/** Ephemeral capability references only. No credential bytes in custody or task profiles. */
export const dockerConnectionSchema = z.object({ schemaVersion: z.literal(1), socketPath: path, bootstrapPath: path,
  bootstrapSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();

export async function dockerConnectionMounts(input: z.infer<typeof dockerConnectionSchema>, uid: number) {
  try {
    const connection = dockerConnectionSchema.parse(input);
    const [socket, parent, bootstrap] = await Promise.all([lstat(connection.socketPath), lstat(dirname(connection.socketPath)), lstat(connection.bootstrapPath)]);
    if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) || !parent.isDirectory()
      || parent.uid !== uid || (parent.mode & 0o077) || !bootstrap.isFile() || (bootstrap.mode & 0o022)
      || await realpath(connection.socketPath) !== connection.socketPath || await realpath(connection.bootstrapPath) !== connection.bootstrapPath
      || createHash('sha256').update(await readFile(connection.bootstrapPath)).digest('hex') !== connection.bootstrapSha256) throw new Error();
    return ['--mount', `type=bind,src=${connection.socketPath},dst=/run/deckent-connection.sock,readonly`,
      '--mount', `type=bind,src=${connection.bootstrapPath},dst=/run/deckent-bootstrap.mjs,readonly`];
  } catch { throw new SupervisorError('SUPERVISOR_OPTIONS_INVALID'); }
}
