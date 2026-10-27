import { displayAddress } from '#platform/index.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { RuntimeLauncherError } from './launch.js';

const diagnostic = z.object({ op: z.enum(['model-discovery', 'workspace-discovery', 'provider-probe']),
  code: z.enum(['MODEL_CONNECT_DISCOVERY_UNAVAILABLE', 'MODEL_CONNECT_DISCOVERY_INVALID', 'MODEL_CONNECT_DISCOVERY_LIMIT', 'PROVIDER_PROBE_REFUSED']),
  cause: z.enum(['no-credential', 'credential-rejected', 'access-denied', 'rate-limit', 'spend-limit', 'limit-reached', 'http-status',
    'redirect', 'network', 'timeout', 'invalid-list', 'not-listable']), status: z.number().int().min(100).max(599).nullable(), // alpha.56.1: the tried address, display form only
  address: z.string().max(2048).transform(text => displayAddress(text)).optional().catch(undefined) }).strip();
/** The existing service log, with the launcher's private/no-follow custody. Only a closed diagnostic projection is appended. */
export async function appendRuntimeProviderDiagnostic(path: string, input: unknown): Promise<void> {
  const event = diagnostic.parse(input);
  if (process.platform === 'win32' || !constants.O_NOFOLLOW) throw new RuntimeLauncherError('RUNTIME_LAUNCH_UNSUPPORTED');
  const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new RuntimeLauncherError('RUNTIME_LAUNCH_FAILED');
    await file.write(`${JSON.stringify(event)}\n`);
  } finally { await file.close(); }
}
