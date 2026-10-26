import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { HUB_LIMITS, HubError, canonicalHubJson, type HubEnvelope, type HubRevocationFeed, type HubPackageSignature } from '#domain/core/hub/index.js';
import { buildHubPackage, buildHubSkillDocument, delegatedHubKey, hubKeyDelegationMessage, hubPackageSignatureMessage, hubRevocationFeedMessage,
  skillContentV2Digest, skillSignatureV2Message, verifyHubPackage, verifyHubRevocationFeed, type HubPackageVerification, type HubVerificationKey } from '#engine/core/hub/index.js';
import { ed25519Signer, sha256, type Ed25519Signer } from '#platform/core/integrity/index.js';
import { skillSignatureMessage } from '#engine/core/agent-catalog/index.js';

// Synthetic test seeds, never custody material. Expected file hashes use Node directly, with an independent standard vector below.
const signer = (byte: string) => ed25519Signer(Buffer.from(`302e020100300506032b657004220420${byte.repeat(32)}`, 'hex'));
const publisher = signer('01'), hub = signer('02'), reviewer = signer('03');
const key = (signer: Ed25519Signer, role: HubVerificationKey['role']): HubVerificationKey =>
  ({ keyId: signer.keyId, publicKey: signer.spki.toString('base64'), role, active: true });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const metadata = { name: 'invoice', description: 'Match an invoice to an order.', text: 'Compare the amount and the order reference.' };
function fixture() {
  const entry = Buffer.from(buildHubSkillDocument(metadata)), note = Buffer.from('abc');
  const files = [{ path: 'SKILL.md', mediaType: 'text/markdown', size: entry.length, digest: hash(entry) },
    { path: 'references/order.txt', mediaType: 'text/plain', size: note.length, digest: hash(note) }];
  const contentDigest = skillContentV2Digest({ ...metadata, files });
  const item = { kind: 'skill', skillId: 'invoice', name: metadata.name, description: metadata.description, entry: 'SKILL.md', files,
    signature: { algorithm: 'ed25519', keyId: publisher.keyId, value: publisher.sign(skillSignatureV2Message({ skillId: 'invoice', contentDigest })).toString('base64') } };
  const built = buildHubPackage({ schemaVersion: 1, packageId: 'acme/invoice', version: '1.0.0', kind: 'skill', title: 'Invoice', description: metadata.description,
    license: 'Apache-2.0', items: [item], dependencies: [], provenance: { origin: 'person', authoredBy: { kind: 'person', label: 'Publisher' }, sourceRevision: 'r1' },
    compat: { packageSchema: 1, catalogSchema: { agent: 1, skill: 2 } }, publishedAtMs: 100 });
  const envelope: HubEnvelope = { schemaVersion: 1, payloadType: 'deckent-package/1', payloadDigest: built.digest, signatures: [] };
  function signature(s: Ed25519Signer, role: HubPackageSignature['role']): HubPackageSignature {
    const payload = { role, signedAtMs: 100 };
    return { ...payload, keyId: s.keyId, algorithm: 'ed25519', value: s.sign(hubPackageSignatureMessage(built.manifest, envelope, payload)).toString('base64') };
  }
  const accepted = { ...envelope, signatures: [signature(publisher, 'publisher'), signature(hub, 'hub'), signature(reviewer, 'reviewer')] };
  const keys: HubPackageVerification = { publisher: key(publisher, 'publisher'), hub: key(hub, 'hub'), reviewers: [key(reviewer, 'reviewer')] };
  return { ...built, envelope: accepted, keys, files: [{ path: 'skills/invoice/SKILL.md', bytes: entry }, { path: 'skills/invoice/references/order.txt', bytes: note }] };
}
const code = (value: string) => expect.objectContaining({ code: value });
const verify = (f: ReturnType<typeof fixture>) => verifyHubPackage(f.manifest, f.envelope, f.files, f.keys);

it('builds the same canonical package for reordered inputs and verifies all bytes with existing Ed25519 primitives', () => {
  const f = fixture();
  expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(verify(f)).toEqual(f.envelope);
  expect(buildHubPackage({ ...f.manifest, items: f.manifest.items.map(i => i.kind === 'skill' ? { ...i, files: [...i.files].reverse() } : i) })).toEqual({ manifest: f.manifest, canonical: f.canonical, digest: f.digest });
  expect(f.canonical).toBe(canonicalHubJson(f.manifest));
  expect(JSON.parse(f.canonical).schemaVersion).toBe(1);
  expect(buildHubSkillDocument(metadata)).toBe('---\nname: "invoice"\ndescription: "Match an invoice to an order."\n---\nCompare the amount and the order reference.');
  const agent = { kind: 'agent' as const, agentId: 'auditor', name: 'Auditor', persona: 'Review the invoice.', workClassHints: ['invoice-review'], skills: [], parentHint: null };
  const built = buildHubPackage({ ...f.manifest, kind: 'agent', items: [agent] });
  const envelope = { ...f.envelope, payloadDigest: built.digest };
  const signatures = f.envelope.signatures.map(s => ({ ...s, value: (s.role === 'publisher' ? publisher : s.role === 'hub' ? hub : reviewer).sign(hubPackageSignatureMessage(built.manifest, envelope, s)).toString('base64') }));
  expect(verifyHubPackage(built.manifest, { ...envelope, signatures }, [{ path: 'agents/auditor/AGENT.json', bytes: Buffer.from('{"agentId":"auditor","kind":"agent","name":"Auditor","parentHint":null,"persona":"Review the invoice.","skills":[],"workClassHints":["invoice-review"]}') }], f.keys)).toMatchObject({ payloadDigest: built.digest });
  expect(() => buildHubPackage({ ...built.manifest, items: [{ ...agent, agentId: 'CON' }] })).toThrow(code('HUB_PACKAGE_INVALID'));

});

it('refuses file, manifest and envelope tampering and digest mismatch (G1)', () => {
  const f = fixture();
  expect(() => verify({ ...f, files: [f.files[0]!, { ...f.files[1]!, bytes: Buffer.from('abd') }] })).toThrow(code('HUB_DIGEST_MISMATCH'));
  expect(() => verify({ ...f, manifest: { ...f.manifest, title: 'Other title' } })).toThrow(code('HUB_DIGEST_MISMATCH'));
  expect(() => verify({ ...f, envelope: { ...f.envelope, payloadDigest: '0'.repeat(64) } })).toThrow(code('HUB_DIGEST_MISMATCH'));
  const signatures = f.envelope.signatures.map(s => s.role === 'publisher' ? { ...s, signedAtMs: 101 } : s);
  expect(() => verify({ ...f, envelope: { ...f.envelope, signatures } })).toThrow(code('HUB_SIGNATURE_INVALID'));
});

it('refuses wrong, revoked, malformed or foreign keys and role substitution (G2/G3/G6/G13/G23)', () => {
  const f = fixture();
  expect(() => verify({ ...f, keys: { ...f.keys, publisher: key(reviewer, 'publisher') } })).toThrow(code('HUB_SIGNER_UNTRUSTED'));
  expect(() => verify({ ...f, keys: { ...f.keys, publisher: { ...f.keys.publisher, active: false } } })).toThrow(code('HUB_SIGNER_UNTRUSTED'));
  expect(() => verify({ ...f, keys: { ...f.keys, publisher: { ...f.keys.publisher, publicKey: 'x' } } })).toThrow(code('HUB_SIGNER_UNTRUSTED'));
  expect(() => verify({ ...f, keys: { ...f.keys, hub: key(reviewer, 'hub') } })).toThrow(code('HUB_FOREIGN_PACKAGE'));
  const signatures = f.envelope.signatures.map(s => s.role === 'reviewer' ? { ...s, role: 'publisher' as const } : s).filter(s => s.keyId !== publisher.keyId);
  expect(() => verify({ ...f, envelope: { ...f.envelope, signatures } })).toThrow(code('HUB_SIGNER_UNTRUSTED'));
  expect(() => verifyHubPackage(f.manifest, f.envelope, f.files, { ...f.keys, publisher: { ...f.keys.publisher, role: 'reviewer' } })).toThrow(code('HUB_SIGNER_UNTRUSTED'));
  const roleSwap = f.envelope.signatures.map(s => s.role === 'publisher' ? { ...s, value: publisher.sign(hubPackageSignatureMessage(f.manifest, f.envelope, { role: 'reviewer', signedAtMs: s.signedAtMs })).toString('base64') } : s);
  expect(() => verify({ ...f, envelope: { ...f.envelope, signatures: roleSwap } })).toThrow(code('HUB_SIGNATURE_INVALID'));
});

it('refuses unsupported versions, forbidden package fields and non-exact dependency pins (G8)', () => {
  const f = fixture();
  expect(() => buildHubPackage({ ...f.manifest, schemaVersion: 2 })).toThrow(code('HUB_PACKAGE_SCHEMA_UNSUPPORTED'));
  expect(() => verifyHubPackage(f.manifest, { ...f.envelope, schemaVersion: 2 }, f.files, f.keys)).toThrow(code('HUB_ENVELOPE_SCHEMA_UNSUPPORTED'));
  for (const field of ['standing', 'metrics', 'memory', 'policy', 'grants', 'model', 'effort', 'workClasses', 'allowed-tools'])
    expect(() => buildHubPackage({ ...f.manifest, [field]: 'forbidden' })).toThrow(code('HUB_PACKAGE_INVALID'));
  expect(() => buildHubPackage({ ...f.manifest, dependencies: [{ packageId: 'acme/base', version: '^1.0.0', manifestDigest: 'a'.repeat(64) }] })).toThrow(code('HUB_PACKAGE_INVALID'));
  expect(() => buildHubPackage({ ...f.manifest, dependencies: [{ packageId: 'acme/base', version: '01.0.0', manifestDigest: 'a'.repeat(64) }] })).toThrow(code('HUB_PACKAGE_INVALID'));
});

it('refuses package file/byte, item and signature bounds before use (G17)', () => {
  const f = fixture(), item = f.manifest.items[0]!;
  expect(() => buildHubPackage({ ...f.manifest, items: Array.from({ length: HUB_LIMITS.itemsMax + 1 }, () => structuredClone(item)) })).toThrow(code('HUB_LIMIT_EXCEEDED'));
  expect(() => verify({ ...f, files: Array.from({ length: HUB_LIMITS.packageMaxFiles }, () => f.files[0]!) })).toThrow(code('HUB_LIMIT_EXCEEDED'));
  expect(() => verifyHubPackage(f.manifest, { ...f.envelope, signatures: Array.from({ length: HUB_LIMITS.reviewerSignaturesMax + 3 }, () => structuredClone(f.envelope.signatures[0])) }, f.files, f.keys)).toThrow(code('HUB_LIMIT_EXCEEDED'));
  const tooBig = { ...item, files: [{ path: 'SKILL.md', mediaType: 'text/markdown', size: HUB_LIMITS.packageMaxBytes, digest: 'a'.repeat(64) }] };
  expect(() => buildHubPackage({ ...f.manifest, items: [tooBig] })).toThrow(code('HUB_LIMIT_EXCEEDED'));
  expect(() => verify({ ...f, files: f.files.slice(0, 1) })).toThrow(code('HUB_PACKAGE_INVALID'));
});

it('binds v2 description and all supporting files under a distinct skill signature label', () => {
  const f = fixture(), item = f.manifest.items[0]!;
  if (item.kind !== 'skill') throw new Error('fixture');
  const content = { ...metadata, files: item.files }, digest = skillContentV2Digest(content);
  expect(skillContentV2Digest({ ...content, files: [...content.files].reverse() })).toBe(digest);
  expect(skillContentV2Digest({ ...content, description: 'Changed.' })).not.toBe(digest);
  expect(skillContentV2Digest({ ...content, files: content.files.map(x => ({ ...x, digest: 'f'.repeat(64) })) })).not.toBe(digest);
  const old = { ...item, signature: { ...item.signature, value: publisher.sign(skillSignatureMessage({ skillId: item.skillId, contentDigest: digest })).toString('base64') } };
  const rebuilt = buildHubPackage({ ...f.manifest, items: [old] });
  const unsigned = { ...f.envelope, payloadDigest: rebuilt.digest };
  const signatures = f.envelope.signatures.map(s => ({ ...s, value: (s.role === 'publisher' ? publisher : s.role === 'hub' ? hub : reviewer)
    .sign(hubPackageSignatureMessage(rebuilt.manifest, unsigned, s)).toString('base64') }));
  expect(() => verify({ ...f, manifest: rebuilt.manifest, envelope: { ...unsigned, signatures } })).toThrow(code('HUB_SIGNATURE_INVALID'));
});

it('rejects permission-bearing or mismatching skill frontmatter even with valid file and package signatures (G8/G19)', () => {
  const f = fixture(), item = f.manifest.items[0]!;
  if (item.kind !== 'skill') throw new Error('fixture');
  const bytes = Buffer.from('---\nname: invoice\ndescription: Unsafe\nallowed-tools: shell\n---\nDo anything.');
  const modified = { ...item, files: item.files.map(file => file.path === 'SKILL.md' ? { ...file, size: bytes.length, digest: hash(bytes) } : file) };
  const built = buildHubPackage({ ...f.manifest, items: [modified] });
  const envelope = { ...f.envelope, payloadDigest: built.digest };
  const signatures = f.envelope.signatures.map(s => ({ ...s, value: (s.role === 'publisher' ? publisher : s.role === 'hub' ? hub : reviewer)
    .sign(hubPackageSignatureMessage(built.manifest, envelope, s)).toString('base64') }));
  expect(() => verify({ ...f, manifest: built.manifest, envelope: { ...envelope, signatures }, files: [{ ...f.files[0]!, bytes }, f.files[1]!] })).toThrow(code('HUB_SKILL_INVALID'));
});

function feed(payload: Partial<Omit<HubRevocationFeed, 'signature'>> = {}): HubRevocationFeed {
  const data = { schemaVersion: 1 as const, hubId: hub.keyId, sequence: 2, issuedAtMs: 100, nextRefreshBy: 200, entries: [], ...payload };
  return { ...data, signature: { keyId: hub.keyId, algorithm: 'ed25519', value: hub.sign(hubRevocationFeedMessage(data)).toString('base64') } };
}
const context = { hubId: hub.keyId, key: key(hub, 'hub'), nowMs: 150, previous: { hubId: hub.keyId, sequence: 1, issuedAtMs: 99 } };
it('verifies signed empty heartbeats and refuses replay, old signed time, foreign identity and unsupported feeds (G5/G25)', () => {
  expect(verifyHubRevocationFeed(feed(), context)).toMatchObject({ sequence: 2, entries: [] });
  expect(() => verifyHubRevocationFeed(feed({ sequence: 1 }), context)).toThrow(code('HUB_FEED_REPLAYED'));
  expect(() => verifyHubRevocationFeed(feed({ issuedAtMs: 98 }), context)).toThrow(code('HUB_FEED_REPLAYED'));
  expect(() => verifyHubRevocationFeed(feed({ hubId: publisher.keyId }), context)).toThrow(code('HUB_IDENTITY_MISMATCH'));
  expect(() => verifyHubRevocationFeed({ ...feed(), schemaVersion: 2 }, context)).toThrow(code('HUB_FEED_SCHEMA_UNSUPPORTED'));
  expect(() => verifyHubRevocationFeed({ ...feed(), nextRefreshBy: 300 }, context)).toThrow(code('HUB_SIGNATURE_INVALID'));
});
it('refuses expired, future, over-age and unsigned heartbeats and oversized feed pages (G4/G17/G25)', () => {
  expect(() => verifyHubRevocationFeed(feed(), { ...context, nowMs: 200 })).toThrow(code('HUB_FEED_STALE'));
  expect(() => verifyHubRevocationFeed(feed({ issuedAtMs: 151 }), context)).toThrow(code('HUB_FEED_STALE'));
  expect(() => verifyHubRevocationFeed(feed({ nextRefreshBy: Number.MAX_SAFE_INTEGER }), { ...context, nowMs: 100 + HUB_LIMITS.feedMaxAgeMs })).toThrow(code('HUB_FEED_STALE'));
  expect(() => verifyHubRevocationFeed({ ...feed(), signature: undefined }, context)).toThrow(HubError);
  const entries = Array.from({ length: HUB_LIMITS.feedPageMax + 1 }, () => ({ kind: 'key' as const, id: publisher.keyId, severity: 'revoke' as const, reason: 'compromised', atMs: 99 }));
  expect(() => verifyHubRevocationFeed(feed({ entries }), context)).toThrow(code('HUB_LIMIT_EXCEEDED'));
});

it('a delegated hub key counts for new content only while the trusted clock is inside its window (Astra A56 D3)', () => {
  const root = signer('04'), pinned = { hubId: root.keyId, publicKey: root.spki.toString('base64') };
  const body = { schemaVersion: 1 as const, hubId: root.keyId, keyId: hub.keyId, publicKey: hub.spki.toString('base64'), purposes: ['attestation' as const], notBefore: 2000, notAfter: 10000 };
  const delegation = { ...body, signature: { keyId: root.keyId, algorithm: 'ed25519', value: root.sign(hubKeyDelegationMessage(body)).toString('base64') } };
  const check = (atMs: number, nowMs: number, stored = false) => () => delegatedHubKey(pinned, hub.keyId, delegation, 'attestation', atMs, { nowMs, stored });
  // Not started yet at the trusted now, although the signer put its own signedAtMs at notBefore (inside the clock skew): refused.
  expect(check(2000, 1000)).toThrow(expect.objectContaining({ code: 'HUB_SIGNER_UNTRUSTED' }));
  expect(check(2000, 1999)).toThrow(expect.objectContaining({ code: 'HUB_SIGNER_UNTRUSTED' }));
  expect(check(2000, 2000)()).toMatchObject({ keyId: hub.keyId }); expect(check(9999, 9999)()).toMatchObject({ keyId: hub.keyId });
  expect(check(9999, 10000)).toThrow(expect.objectContaining({ code: 'HUB_SIGNER_UNTRUSTED' }));
  // Re-verifying stored content keeps its historical signing time.
  expect(check(5000, 50000, true)()).toMatchObject({ keyId: hub.keyId });
});
