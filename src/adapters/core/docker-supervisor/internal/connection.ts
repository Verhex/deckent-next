import { lstat, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { SupervisorError } from '#engine/index.js';
import { identitySchema } from '#domain/index.js';

const path = z.string().min(1).refine(value => isAbsolute(value) && !value.includes(String.fromCharCode(0)) && !/[,\r\n]/u.test(value));
/** Ephemeral capability references only. No credential bytes in custody or task profiles. */
export const dockerConnectionSchema = z.object({ schemaVersion: z.literal(1), socketPath: path, bootstrapPath: path,
  bootstrapSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** alpha.56 D2: the catalog provider whose model hosts the gateway allows (absent only in records written before it; a new dispatch needs it). */
  provider: identitySchema.optional() }).strict().readonly();

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
/** U9-7a: the SIWC worker relay channel (one private host socket) and its two pinned standalone programs; never a credential path. */
export const dockerRelaySchema = z.object({ schemaVersion: z.literal(1), socketPath: path, bootstrapPath: path, bootstrapSha256: z.string().regex(/^[a-f0-9]{64}$/),
  helperPath: path, helperSha256: z.string().regex(/^[a-f0-9]{64}$/), policySha256: z.string().regex(/^[a-f0-9]{64}$/), bindingSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export const DOCKER_RELAY_TARGETS = Object.freeze({ socket: '/run/deckent-relay.sock', bootstrap: '/run/deckent-bootstrap.mjs', helper: '/run/deckent-siwc-helper.mjs' });
export async function dockerRelayMounts(input: z.infer<typeof dockerRelaySchema>, uid: number) {
  try {
    const relay = dockerRelaySchema.parse(input);
    const [socket, parent] = await Promise.all([lstat(relay.socketPath), lstat(dirname(relay.socketPath))]);
    if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077)
      || await realpath(relay.socketPath) !== relay.socketPath) throw new Error();
    for (const [file, sha256] of [[relay.bootstrapPath, relay.bootstrapSha256], [relay.helperPath, relay.helperSha256]] as const) {
      const stat = await lstat(file);
      if (!stat.isFile() || (stat.mode & 0o022) || await realpath(file) !== file || createHash('sha256').update(await readFile(file)).digest('hex') !== sha256) throw new Error();
    }
    return ['--mount', `type=bind,src=${relay.socketPath},dst=${DOCKER_RELAY_TARGETS.socket},readonly`, '--mount', `type=bind,src=${relay.bootstrapPath},dst=${DOCKER_RELAY_TARGETS.bootstrap},readonly`,
      '--mount', `type=bind,src=${relay.helperPath},dst=${DOCKER_RELAY_TARGETS.helper},readonly`];
  } catch { throw new SupervisorError('SUPERVISOR_OPTIONS_INVALID'); }
}
