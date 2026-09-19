import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { LocalPeerShutdownAuthentication, readLocalOsIdentity, type LocalPeerIdentity } from '../../../src/adapters/index.js';

const os = userInfo();
const peer: LocalPeerIdentity = Object.freeze({ pid: 123, uid: os.uid, gid: os.gid, assurance: 'linux-so-peercred' });

describe('local peer shutdown authentication', () => {
  it('binds native peer evidence to the current OS principal and externally supplied scopes', async () => {
    const actor = await new LocalPeerShutdownAuthentication(peer, ['service-scope']).verify(undefined);
    expect(actor).toEqual({
      principal: { ...readLocalOsIdentity(), scopeIds: ['service-scope'] },
      evidence: { method: 'os-peer', pid: peer.pid, uid: peer.uid, gid: peer.gid },
    });
    expect(Object.isFrozen(actor)).toBe(true);
    expect(Object.isFrozen(actor.principal)).toBe(true);
  });

  it('rejects client credentials rather than accepting a wire-authored persona', async () => {
    const verifier = new LocalPeerShutdownAuthentication(peer, ['service-scope']);
    await expect(verifier.verify({ principal: readLocalOsIdentity() })).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('rejects foreign UID, forged assurance, and invalid kernel evidence', async () => {
    const invalid = [
      { ...peer, uid: peer.uid + 1 },
      { ...peer, assurance: 'client-declared' },
      { ...peer, pid: 0 },
      { ...peer, gid: -1 },
      { ...peer, pid: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const candidate of invalid) {
      const verifier = new LocalPeerShutdownAuthentication(candidate as LocalPeerIdentity, ['service-scope']);
      await expect(verifier.verify(undefined)).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    }
  });

  it('rejects invalid policy-resolved scopes instead of deriving scope from peer evidence', async () => {
    for (const scopes of [[], [''], ['valid', '']]) {
      await expect(new LocalPeerShutdownAuthentication(peer, scopes).verify(undefined))
        .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    }
  });
});
