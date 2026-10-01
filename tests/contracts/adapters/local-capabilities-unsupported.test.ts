import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLocalRuntimeSocketGuard, LocalOsSessionAuthority, LocalRuntimeSocketError } from '#adapters/index.js';
import { SessionAuthenticationError } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const nativePlatform = process.platform;
const platforms: NodeJS.Platform[] = nativePlatform === 'linux' ? ['darwin', 'win32'] : [nativePlatform];
const clock = { sample: () => ({ wallMs: 1000, monotonicMs: 100 }) };

// Linux executes only a platform-guard simulation. Native macOS/Windows execute their actual guard.
// This proves truthful refusal before custody/session admission, never non-Linux runtime support.
describe(nativePlatform === 'linux' ? 'local capability refusal: simulated non-Linux platform guards' : `local capability refusal: native ${nativePlatform}`, () => {
  it.each(platforms)('refuses %s socket custody and live OS session before creating an endpoint or granting authority', async platform => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-unsupported-local-')); roots.push(root);
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    if (nativePlatform === 'linux') Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      const options = { endpoint: join(root, 'runtime.sock'), maxConnections: 1, inputMaxBytes: 1024, responseMaxBytes: 1024,
        headerTimeoutMs: 100, responseTimeoutMs: 100, acceptRetryDelayMs: 1, acceptRetryLimit: 1 };
      const transport = await acquireLocalRuntimeSocketGuard(options).catch((error: unknown) => error);
      expect(transport).toBeInstanceOf(LocalRuntimeSocketError);
      expect(transport).toMatchObject({ code: 'LOCAL_RUNTIME_UNSUPPORTED' });
      const session = await LocalOsSessionAuthority.create(['scope'], 1000, clock).catch((error: unknown) => error);
      expect(session).toBeInstanceOf(SessionAuthenticationError);
      expect(session).toMatchObject({ code: 'SESSION_REQUIRED' });
      expect(await readdir(root)).toEqual([]);
    } finally { Object.defineProperty(process, 'platform', original); }
  });
});
