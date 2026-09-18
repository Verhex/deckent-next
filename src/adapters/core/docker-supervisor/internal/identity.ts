import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { sandboxRequestSchema, SupervisorError, type SandboxRequest } from '#engine/index.js';
import { dockerSupervisorOptionsSchema, type DockerSupervisorOptions } from './options.js';
/** Single TS owner of Docker request bytes and fence digests. Config resolution remains composition-owned. */
export function identifyDockerRequest(input: SandboxRequest, options: DockerSupervisorOptions) {
  const settings = dockerSupervisorOptionsSchema.safeParse(options);
  if (!settings.success || !isAbsolute(settings.data.workspaceRoot) || !isAbsolute(settings.data.executable)) throw new SupervisorError('SUPERVISOR_OPTIONS_INVALID');
  const parsed = sandboxRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.argv.some(value => value.includes('\0'))) throw new SupervisorError('SUPERVISOR_REQUEST_INVALID');
  const digest = createHash('sha256').update(JSON.stringify({ request: parsed.data, options: settings.data })).digest('hex');
  const handle = 'deckent-' + createHash('sha256').update(JSON.stringify(parsed.data.identity)).digest('hex');
  return Object.freeze({ request: parsed.data, options: settings.data, digest, handle });
}
