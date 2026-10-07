import { describe, expect, it } from 'vitest';
import { hostShellRealm, openShellRealm, sandboxWriteView, shellPostureFacts, shellWritePosture, type ShellRealmResolution } from '#adapters/index.js';
import { agentShellPostureSchema } from '#domain/index.js';

// POSTURE (T2-FOLLOWUP, L1 D2): the card's structured facts come from the same resolution and write view the realm's sentence describes.
type Usable = Extract<ShellRealmResolution, { ok: true }>;
const sandbox = (kind: 'bubblewrap' | 'landlock', extra: Partial<Usable> = {}): Usable => ({ ok: true, realm: { kind, run: hostShellRealm.run }, marker: `sandbox: ${kind}`, notice: null,
  posture: () => `${kind} sentence`, containment: 'sandbox', ...extra });
const view = (authority: Parameters<typeof shellWritePosture>[0], tier: Parameters<typeof shellWritePosture>[1], fullAccess = false) => {
  const write = shellWritePosture(authority, tier, fullAccess);
  return sandboxWriteView({ repositoryWritable: fullAccess }, write);
};

describe('shell posture facts (T2-FOLLOWUP POSTURE)', () => {
  it('mirrors the write view: owner-approved writable with .git read-only, unattended read-only, the narrow set except the floor', () => {
    expect(shellPostureFacts(sandbox('bubblewrap'), view('owner-approved', 'modify'))).toEqual({ realm: 'bubblewrap', containment: 'sandbox', project: 'writable', git: 'read-only',
      network: 'closed', passedOver: [] });
    expect(shellPostureFacts(sandbox('landlock'), view('unattended', 'modify'))).toMatchObject({ project: 'read-only', git: 'read-only', network: 'closed' });
    expect(shellPostureFacts(sandbox('bubblewrap'), view('unattended', 'narrow-mutating'))).toMatchObject({ project: 'writable-except-floor' });
  });
  it('a full-access card: an open realm reaches the network and writes .git; a realm that cannot open stays closed or moves to the host', () => {
    const open = view('owner-approved', 'modify', true);
    expect(shellPostureFacts(sandbox('bubblewrap', { opens: true }), open)).toMatchObject({ git: 'writable', network: 'reachable', containment: 'sandbox' });
    const kept = openShellRealm(sandbox('landlock'), 'require-sandbox');
    expect(shellPostureFacts(kept, open)).toMatchObject({ realm: 'landlock', network: 'closed' });
    const moved = openShellRealm(sandbox('landlock', { rejected: [{ kind: 'bubblewrap', reason: 'absent' }] }), 'prefer-sandbox');
    expect(shellPostureFacts(moved, open)).toEqual({ realm: 'host', containment: 'host', project: 'writable', git: 'writable', network: 'reachable', passedOver: ['bubblewrap'] });
  });
  it('a degraded sandbox says so, and every result is a valid wire value', () => {
    const facts = shellPostureFacts(sandbox('landlock', { containment: 'degraded' }), view('owner-approved', 'modify'));
    expect(facts.containment).toBe('degraded');
    expect(agentShellPostureSchema.parse(facts)).toEqual(facts);
  });
});

