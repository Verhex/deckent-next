import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import config from './config.json' with { type: 'json' };

export type FixtureAvailability = Readonly<{ status: 'available'; platform: NodeJS.Platform } | {
  status: 'verify-not-run'; reason: 'platform-unsupported' | 'loopback-denied' | 'binary-unavailable'; platform: NodeJS.Platform;
}>;
export class FixtureUnavailableError extends Error {
  constructor(readonly availability: Extract<FixtureAvailability, { status: 'verify-not-run' }>) {
    super(JSON.stringify(availability)); this.name = 'FixtureUnavailableError';
  }
}
/** Pure pre-access capability gate; an unsupported platform creates no root, socket or PTY. */
export function fixtureAvailability(platform: NodeJS.Platform = process.platform): FixtureAvailability {
  return platform === 'linux' ? { status: 'available', platform } : { status: 'verify-not-run', reason: 'platform-unsupported', platform };
}
export function loopbackAvailability(error: unknown, platform: NodeJS.Platform = process.platform): FixtureAvailability {
  if (error && typeof error === 'object' && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) {
    return { status: 'verify-not-run', reason: 'loopback-denied', platform };
  }
  throw error; // Address conflicts, invalid config and other failures remain failures, never skips.
}
async function probeLoopback(): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.http.port, config.http.host, resolve); });
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
export async function checkFixtureAvailability(platform: NodeJS.Platform = process.platform, probe: () => Promise<void> = probeLoopback): Promise<FixtureAvailability> {
  const capability = fixtureAvailability(platform);
  if (capability.status !== 'available') return capability;
  try { await probe(); return capability; } catch (error) { return loopbackAvailability(error, platform); }
}
export async function recordFixtureAvailability(surface: 'sdk' | 'runtime', availability: FixtureAvailability): Promise<void> {
  console.info(JSON.stringify({ surface, ...availability }));
  const destination = process.env['DECKENT_TEST_ERP_PROOF'];
  if (destination) await writeFile(join(destination, `${surface}-availability.json`), JSON.stringify({ surface, ...availability }) + '\n');
}
