import { describe, expect, it, vi } from 'vitest';

vi.mock('node:module', async importOriginal => {
  const original = await importOriginal<typeof import('node:module')>();
  return { ...original, createRequire: () => (() => { throw new Error('NATIVE_MODULE_MISSING'); }) as unknown as NodeJS.Require };
});

const { listenWithPeerIdentity } = await import('../../../src/adapters/core/local-runtime-socket/internal/peer.js');
const { acquireLedgerLock } = await import('../../../src/adapters/core/local-runtime-socket/internal/ledger-lock.js');

// On Linux a native module that cannot be loaded is not a platform refusal: LOCAL_RUNTIME_UNSUPPORTED ("requires Linux") would mislead.
describe.skipIf(process.platform !== 'linux')('native peer module load failure on Linux', () => {
  it('reports the native component as unavailable, keeping the cause, instead of "requires Linux"', () => {
    expect(() => listenWithPeerIdentity('/tmp/never.sock', 1, () => undefined, 10, 1))
      .toThrowError(expect.objectContaining({ code: 'LOCAL_RUNTIME_NATIVE_UNAVAILABLE', cause: expect.objectContaining({ message: 'NATIVE_MODULE_MISSING' }) }));
    expect(() => acquireLedgerLock('/tmp/never-ledger-lock'))
      .toThrowError(expect.objectContaining({ code: 'LOCAL_RUNTIME_NATIVE_UNAVAILABLE' }));
  });
});
