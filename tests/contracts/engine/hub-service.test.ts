import { mkdtempSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, type TestContext } from 'vitest';
import { HubModeratedApplication, HubServerError, hubKeyProofMessage, hubRosterMessage, hubModerationMessage, hubQueueId, verifyHubModerationEvidence,
  type HubModerationCommand, type HubServicePolicy, type HubServiceDependencies } from '#engine/core/hub-server/index.js';
import { canonicalHubJson, type HubPackageSignature } from '#domain/core/hub/index.js';
import { buildHubPackage, delegatedHubKey, hubKeyDelegationMessage, hubPackageSignatureMessage, hubRevocationFeedMessage } from '#engine/core/hub/index.js';
import { encodeHubBundle, type HubBundle, type HubClientDependencies } from '#engine/core/hub-client/index.js';
import { openHubStore, HUB_STORE_SCHEMA_VERSION } from '#adapters/core/hub-store/index.js';
import { createHubServiceHttpHandler } from '#surfaces/core/hub-mcp/index.js';
import { createHmacIntegrity, ed25519Signer, EMPTY_KNOWN_SECRETS, sha256, signatureMessage, verifyEd25519 } from '#platform/index.js';
import { bundle, publisher, hub, otherPublisher, fixture as clientFixture } from '../../fixtures/hub-client.js';

const roots: string[] = [], closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const seed = (byte: string) => ed25519Signer(Buffer.from(`302e020100300506032b657004220420${byte.repeat(32)}`, 'hex'));
const rootKey = seed('04'), moderator1 = seed('05'), moderator2 = seed('06'), moderator3 = seed('07'), feedKey = seed('08');
const code = (code: string) => expect.objectContaining({ code });
/** A root-signed `hub-key-delegation:1` (the H9 key ceremony's output); `by` signs it. */
const delegate = (key: typeof hub, purposes: ('attestation' | 'feed')[], notBefore = 0, notAfter = 100000, by = rootKey) => {
  const body = { schemaVersion: 1 as const, hubId: rootKey.keyId, keyId: key.keyId, publicKey: key.spki.toString('base64'), purposes, notBefore, notAfter };
  return { ...body, signature: { keyId: by.keyId, algorithm: 'ed25519' as const, value: by.sign(hubKeyDelegationMessage(body)).toString('base64') } };
};
const delegations: Readonly<Record<string, unknown>> = { [hub.keyId]: delegate(hub, ['attestation']), [feedKey.keyId]: delegate(feedKey, ['feed'], 0, 10_000_000) };
async function fixture(c: TestContext, extra: Partial<HubServicePolicy> = {}) {
  if (process.platform === 'win32') c.skip('verify-not-run: Hub POSIX custody; Windows refuses in hub-server contract');
  const root = mkdtempSync(join(tmpdir(), 'hub-service-')); roots.push(root);
  const options = { root, scopeId: 's', hubId: rootKey.keyId, busyTimeoutMs: 1000 }, opened = openHubStore(options); closers.push(opened.close);
  const integrity = createHmacIntegrity('fixture', Buffer.alloc(32, 9));
  const id = (subject: string) => integrity.sign(canonicalHubJson({ provider: 'fixture', subject }));
  let now = 100, allow = true;
  const policy: HubServicePolicy = { schemaVersion: 1, identityProviders: [{ id: 'fixture', issuer: 'https://idp.example', audience: 'hub-test' }],
    admins: [id('admin')], reservedHandles: ['admin'], confusables: { '0': 'o', '1': 'l' }, highRiskWorkClasses: ['high-risk'], maliciousReasons: ['malware'], reasons: { malware: 10, spam: 1, license: 3 },
    minAccountAgeMs: 100, challengeTtlMs: 5000, sessionTtlMs: 100000, deletionDelayMs: 500, emergencyConfirmMs: 1000,
    publishWindowMs: 10000, publishesPerProfile: 100, dayWindowMs: 100000, newPackagesPerProfile: 50, versionsPerPackage: 50,
    reportsPerAccount: 3, readWindowMs: 1000, readsPerAddress: 100, searchesPerAddress: 100, maxMembers: 20, maxKeys: 20, maxChallenges: 50, ...extra };
  const deps: HubServiceDependencies = { policy, integrity, rootPublicKey: rootKey.spki.toString('base64'),
    identity: { verify: async (input, expected) => {
      const p = input as { subject: string; passkey?: boolean; email?: boolean; challenge?: string };
      if (p.challenge !== expected.challenge) throw new HubServerError('HUB_ACCOUNT_REFUSED');
      return { subject: p.subject, email: `${p.subject}@private.example`, displayName: 'Private Name', emailVerified: p.email !== false, passkeyVerified: p.passkey !== false };
    } }, verifyDomain: (_domain, expected) => expected.startsWith('deckent-hub-verify=') };
  const ports = { ...opened, hubId: rootKey.keyId, scopeId: 's', now: () => now, knownSecrets: () => EMPTY_KNOWN_SECRETS,
    authority: { require: () => { if (!allow) throw new HubServerError('HUB_SERVER_DENIED'); } },
    feedSigner: () => ({ signer: feedKey, key: { keyId: feedKey.keyId, publicKey: feedKey.spki.toString('base64'), role: 'hub' as const, active: true } }),
    attestor: () => ({ signer: hub, key: { keyId: hub.keyId, publicKey: hub.spki.toString('base64'), role: 'hub' as const, active: true } }),
    delegation: (keyId: string) => delegations[keyId] ?? null };
  const app = new HubModeratedApplication(ports, deps), address = sha256('loopback fixture');
  const login = async (subject: string) => {
    const challenge = await app.accounts.begin('fixture', address), result = await app.accounts.login(challenge.id, { subject, challenge: challenge.id });
    return { ...result, context: await app.session(result.token) };
  };
  const owner = await login('owner'), admin = await login('admin'), mod1 = await login('mod1'), mod2 = await login('mod2'), mod3 = await login('mod3');
  const profile = await app.profiles.create(owner.context, { schemaVersion: 1, handle: 'acme', kind: 'organisation', displayName: 'ACME <safe>' });
  const key = (signer = publisher, principal = owner.context.principal) => ({ keyId: signer.keyId, publicKey: signer.spki.toString('base64'), role: 'publisher' as const,
    active: true, trustedAiReviewer: false, publisherId: '@acme', principal });
  const addKey = async (signer = publisher, principal = owner.context.principal) => {
    const k = key(signer, principal), challenge = await app.profiles.keyChallenge(owner.context, profile.id, k);
    return app.profiles.addKey(owner.context, profile.id, challenge.id, signer.sign(hubKeyProofMessage(rootKey.keyId, profile.id, challenge.id, k)).toString('base64'));
  };
  await addKey();
  const unsignedRoster = { schemaVersion: 1 as const, hubId: rootKey.keyId, sequence: 1, entries: [[moderator1, mod1], [moderator2, mod2], [moderator3, mod3]] .map(([signer, account], index) => {
    const s = signer as typeof hub, a = account as typeof mod1;
    return { keyId: s.keyId, publicKey: s.spki.toString('base64'), accountRef: a.accountId, role: index === 0 ? 'senior-moderator' as const : 'moderator' as const, notBefore: 0, notAfter: 100000 };
  }), signature: { keyId: rootKey.keyId, value: 'pending' } };
  const roster = { ...unsignedRoster, signature: { keyId: rootKey.keyId, value: rootKey.sign(hubRosterMessage(unsignedRoster)).toString('base64') } };
  await app.profiles.roster(admin.context, roster);
  const make = (version = '1.0.0', input: Parameters<typeof bundle>[0] = {}) => {
    const b = bundle({ ...input, version }), manifest = buildHubPackage({ ...b.manifest, packageId: `@acme/${input.name ?? 'invoice'}`,
      items: b.manifest.items.map(item => item.kind === 'agent' ? { ...item, skills: item.skills.map(s => ({ ...s, packageId: `@${s.packageId}` })) } : item) }).manifest;
    const envelope = { ...b.envelope, payloadDigest: sha256(canonicalHubJson(manifest)), signatures: [] }, sig = { role: 'publisher' as const, signedAtMs: 100 }, pub = input.publisher ?? publisher;
    return { manifest, files: b.files.map(file => file.path.startsWith('agents/') ? { ...file, bytes: Buffer.from(canonicalHubJson(manifest.items.find(i => i.kind === 'agent'))) } : file),
      envelope: { ...envelope, signatures: [{ ...sig, keyId: pub.keyId, algorithm: 'ed25519' as const, value: pub.sign(hubPackageSignatureMessage(manifest, envelope, sig)).toString('base64') }] } };
  };
  const publish = async (version = '1.0.0', input: Parameters<typeof bundle>[0] = {}, ctx = owner.context) => { const b = make(version, input); return app.publish(ctx, b.manifest, b.envelope, b.files); };
  const review = async (version = '1.0.0', signer = moderator1, ctx = mod1.context, name = 'invoice') => {
    const row = (await opened.store.get(`@acme/${name}`, version))!, payload = { role: 'reviewer' as const, reviewLevel: 'moderated', signedAtMs: now };
    const sig: HubPackageSignature = { ...payload, keyId: signer.keyId, algorithm: 'ed25519', value: signer.sign(hubPackageSignatureMessage(row.manifest, row.envelope, payload)).toString('base64') };
    return app.review(ctx, row.manifest.packageId, version, sig);
  };
  const act = async (action: HubModerationCommand['action'], targetId = hubQueueId('@acme/invoice', '1.0.0'), extras: Partial<HubModerationCommand> = {}, signer = moderator1, ctx = mod1.context) => {
    const command: HubModerationCommand = { schemaVersion: 1, commandId: `${action}-case`, action, targetKind: 'version', targetId, reason: 'spam', emergency: false,
      keyId: signer.keyId, signedAtMs: now, signature: 'pending', ...extras };
    command.signature = signer.sign(hubModerationMessage(rootKey.keyId, command)).toString('base64');
    return app.moderation.act(ctx, command);
  };
  return { app, ports, deps, root, options, opened, owner, admin, mod1, mod2, mod3, profile, address, login, id, key, addKey, roster, make, publish, review, act,
    time: (value: number) => { now = value; }, deny: () => { allow = false; } };
}

it('requires verified e-mail and passkey, binds one-time challenges and expires sessions (G39)', async c => {
  const f = await fixture(c), challenge = await f.app.accounts.begin('fixture', f.address);
  await expect(f.app.accounts.login(challenge.id, { subject: 'bad', challenge: challenge.id, passkey: false })).rejects.toThrow(code('HUB_ACCOUNT_REFUSED'));
  await expect(f.app.accounts.login(challenge.id, { subject: 'bad', challenge: challenge.id, email: false })).rejects.toThrow(code('HUB_ACCOUNT_REFUSED'));
  const account = await f.app.accounts.login(challenge.id, { subject: 'new', challenge: challenge.id });
  await expect(f.app.accounts.login(challenge.id, { subject: 'new', challenge: challenge.id })).rejects.toThrow();
  await f.app.accounts.logout(await f.app.session(account.token)); await expect(f.app.session(account.token)).rejects.toThrow();
  f.time(100101); await expect(f.app.session(f.owner.token)).rejects.toThrow(code('HUB_SERVER_DENIED'));
});

it('enforces reserved/confusable handles, profile ownership, key possession and domain challenges (G34/G40)', async c => {
  const f = await fixture(c);
  await expect(f.app.profiles.create(f.owner.context, { schemaVersion: 1, handle: 'admin', kind: 'person', displayName: 'Admin' })).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  await f.app.profiles.create(f.owner.context, { schemaVersion: 1, handle: 'cool', kind: 'person', displayName: 'Cool' });
  await expect(f.app.profiles.create(f.owner.context, { schemaVersion: 1, handle: 'c00l', kind: 'person', displayName: 'Alias' })).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  await expect(f.app.profiles.keyChallenge(f.mod1.context, f.profile.id, f.key(otherPublisher))).rejects.toThrow(code('HUB_SERVER_DENIED'));
  const k = f.key(otherPublisher), challenge = await f.app.profiles.keyChallenge(f.owner.context, f.profile.id, k);
  await expect(f.app.profiles.addKey(f.owner.context, f.profile.id, challenge.id, publisher.sign(hubKeyProofMessage(rootKey.keyId, f.profile.id, challenge.id, k)).toString('base64'))).rejects.toThrow(code('HUB_SIGNATURE_INVALID'));
  await f.app.profiles.addKey(f.owner.context, f.profile.id, challenge.id, otherPublisher.sign(hubKeyProofMessage(rootKey.keyId, f.profile.id, challenge.id, k)).toString('base64'));
  await expect(f.app.profiles.addKey(f.owner.context, f.profile.id, challenge.id, 'replay')).rejects.toThrow();
  const domain = await f.app.profiles.domainChallenge(f.owner.context, f.profile.id, 'acme.example');
  expect((await f.app.profiles.verifyDomain(f.owner.context, f.profile.id, domain.challengeId)).verifiedDomains).toEqual(['acme.example']);
  const signed = await f.app.publicProfile(f.owner.context, 'acme'), { signature, ...payload } = signed;
  expect(verifyEd25519(hub.spki, signatureMessage('hub-profile:1', canonicalHubJson({ hubId: rootKey.keyId, ...payload })), Buffer.from(signature.value, 'base64'))).toBe(true);
});

it('keeps intake private until two distinct people approve and retains moderated evidence after reopening (G35)', async c => {
  const f = await fixture(c); f.time(300); await f.publish();
  expect(await f.app.search(f.owner.context)).toEqual([]); await expect(f.app.inspect(f.owner.context, '@acme/invoice', '1.0.0')).rejects.toThrow(code('HUB_RESOURCE_UNKNOWN'));
  expect(await f.review()).toMatchObject({ approved: false, remaining: 1 });
  await expect(f.review()).rejects.toThrow(code('HUB_REVIEW_REFUSED'));
  expect(await f.app.listSkills(f.owner.context)).toEqual([]);
  expect(await f.review('1.0.0', moderator2, f.mod2.context)).toMatchObject({ approved: true, remaining: 0 });
  const row = await f.app.inspect(f.owner.context, '@acme/invoice', '1.0.0');
  expect(row.envelope.signatures.find(s => s.role === 'hub')).toMatchObject({ reviewLevel: 'moderated', moderatorKeyIds: [moderator1.keyId, moderator2.keyId] });
  expect((await f.app.evidence(f.owner.context, '@acme/invoice', '1.0.0')).roster.signature.keyId).toBe(rootKey.keyId);
  const opened = openHubStore(f.options); closers.push(opened.close);
  expect((await new HubModeratedApplication({ ...f.ports, store: opened.store }, f.deps).inspect(f.owner.context, '@acme/invoice', '1.0.0')).envelope).toEqual(row.envelope);
});

it('requires two-person review for AI publications and refuses AI administration or own-profile review (G35/G38)', async c => {
  const f = await fixture(c); f.time(300);
  await f.addKey(otherPublisher, { kind: 'ai', id: 'agent' });
  await f.publish('1.0.0', { publisher: otherPublisher, kind: 'ai' }, { scopeId: 's', principal: { id: 'agent', kind: 'ai' } });
  expect((await f.app.moderation.queue(f.mod1.context))[0]).toMatchObject({ required: 2 });
  await expect(f.app.profiles.create({ ...f.owner.context, principal: { kind: 'ai', id: f.owner.accountId } }, { schemaVersion: 1, handle: 'fake', kind: 'person', displayName: 'Fake' })).rejects.toThrow(code('HUB_SERVER_DENIED'));
  const invitation = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'publisher' });
  await f.app.profiles.respond(f.mod1.context, invitation.id, 'accept');
  await expect(f.review()).rejects.toThrow(code('HUB_REVIEW_REFUSED'));
  await expect(f.app.register(f.admin.context, f.key())).rejects.toThrow(code('HUB_SERVER_DENIED'));
});

it('accepts only an increasing offline-root-signed moderator roster (G33)', async c => {
  const f = await fixture(c);
  await expect(f.app.profiles.roster(f.admin.context, f.roster)).rejects.toThrow(code('HUB_REVIEW_REFUSED'));
  const forged = { ...f.roster, sequence: 2, signature: { keyId: hub.keyId, value: 'pending' } };
  forged.signature.value = hub.sign(hubRosterMessage(forged)).toString('base64');
  await expect(f.app.profiles.roster(f.admin.context, forged)).rejects.toThrow(code('HUB_SIGNER_UNTRUSTED'));
  await expect(f.app.profiles.roster(f.mod1.context, forged)).rejects.toThrow(code('HUB_SERVER_DENIED'));
});

it('enforces account age and atomic publish rates without admitting a blocked version (G39)', async c => {
  const f = await fixture(c, { publishesPerProfile: 1 });
  await expect(f.publish()).rejects.toThrow(code('HUB_ACCOUNT_REFUSED')); f.time(300); await f.publish();
  await expect(f.publish('1.0.1')).rejects.toThrow(code('HUB_RATE_REFUSED'));
  expect(await f.opened.store.get('@acme/invoice', '1.0.1')).toBeNull();
  f.time(10300); await f.publish('1.0.1');
});

it('applies first-package and supporting-file review policy independently on each version', async c => {
  const f = await fixture(c); f.time(300); await f.publish(); await f.review(); await f.review('1.0.0', moderator2, f.mod2.context);
  await f.publish('1.0.1'); expect(await f.review('1.0.1')).toMatchObject({ approved: true });
  await f.publish('1.0.2', { supporting: [{ path: 'references/note.txt', mediaType: 'text/plain', bytes: Buffer.from('Note') }] });
  expect(await f.review('1.0.2')).toMatchObject({ approved: false, remaining: 1 });
  expect((await f.app.reviewBundle(f.mod2.context, '@acme/invoice', '1.0.2', moderator2.keyId)).previousManifest?.version).toBe('1.0.1');
});

it('hides only listings, restores visibility and requires two signed moderators for permanent revocation', async c => {
  const f = await fixture(c); f.time(300); await f.publish(); await f.review(); await f.review('1.0.0', moderator2, f.mod2.context);
  await f.act('hide'); expect(await f.app.search(f.owner.context)).toEqual([]);
  expect(await f.app.inspect(f.owner.context, '@acme/invoice', '1.0.0')).toBeDefined(); await f.act('restore'); expect(await f.app.search(f.owner.context)).toHaveLength(1);
  expect(await f.act('revoke')).toMatchObject({ applied: false }); expect(await f.app.search(f.owner.context)).toHaveLength(1);
  expect(await f.act('revoke', undefined, {}, moderator2, f.mod2.context)).toMatchObject({ applied: true });
  await expect(f.app.readFile(f.owner.context, '@acme/invoice', '1.0.0', 'skills/invoice/SKILL.md')).rejects.toThrow(code('HUB_RESOURCE_UNKNOWN'));
  expect(await f.opened.store.revocations([{ kind: 'package-version', id: '@acme/invoice@1.0.0' }])).toEqual([expect.objectContaining({ severity: 'revoke' })]);
});

it('keeps emergency senior revocation effective and escalates missing confirmation to admins', async c => {
  const f = await fixture(c); f.time(300); await f.publish();
  await expect(f.act('revoke', undefined, { emergency: true }, moderator2, f.mod2.context)).rejects.toThrow(code('HUB_REVIEW_REFUSED'));
  expect(await f.act('revoke', undefined, { emergency: true })).toMatchObject({ applied: true, confirmByMs: 1300 });
  f.time(1400); expect(await f.app.moderation.escalate(f.admin.context)).toEqual(['revoke-case']);
  expect(await f.act('revoke', undefined, { emergency: true }, moderator2, f.mod2.context)).toMatchObject({ applied: true, confirmByMs: null });
});

it('rates reports, prioritises severity and assigns appeals to a different moderator', async c => {
  const f = await fixture(c); f.time(300); await f.publish(); await f.act('reject');
  const targetId = hubQueueId('@acme/invoice', '1.0.0');
  const report = await f.app.report(f.owner.context, { targetId, reason: 'malware', appealOf: 'reject-case' });
  await f.app.report(f.owner.context, { targetId, reason: 'spam', appealOf: null });
  expect((await f.app.reports(f.mod2.context, moderator2.keyId))[0]?.id).toBe(report.id);
  await expect(f.act('hide', targetId, { commandId: 'appeal', appealId: report.id })).rejects.toThrow(code('HUB_REVIEW_REFUSED'));
  await f.app.report(f.owner.context, { targetId, reason: 'spam', appealOf: null });
  await expect(f.app.report(f.owner.context, { targetId, reason: 'spam', appealOf: null })).rejects.toThrow(code('HUB_RATE_REFUSED'));
});

it('serves escaped public pages from the moderated API and rejects cross-origin or unauthenticated writes', async c => {
  const f = await fixture(c); f.time(300); await f.publish(); await f.review(); await f.review('1.0.0', moderator2, f.mod2.context);
  const handler = createHubServiceHttpHandler(f.app, { endpoint: 'https://hub.example/', addressId: () => f.address, publicContext: f.owner.context });
  const page = await handler.fetch(new Request('https://hub.example/profiles/acme'));
  expect(page.status).toBe(200); expect(await page.text()).toContain('ACME &lt;safe&gt;');
  const api = await handler.fetch(new Request('https://hub.example/api/packages')); expect((await api.json() as unknown[])).toHaveLength(1);
  const { createHubHttpHandler } = await import('#surfaces/core/hub-mcp/index.js');
  const shared = createHubHttpHandler(f.app, { endpoint: 'https://hub.example/mcp', authorizationServers: ['https://idp.example'], scopes: ['hub'], allowedOrigins: [],
    verifier: { verifyAccessToken: async token => ({ token, clientId: 'fixture', resource: new URL('https://hub.example/mcp'), expiresAt: 4_000_000_000, scopes: ['hub'] }) },
    context: () => f.owner.context, service: { addressId: (_request, peer) => { expect(peer?.address).toBe('127.0.0.7'); return f.address; }, publicContext: f.owner.context } }, { extensionId: 'test.example/hub' });
  try { expect((await shared.fetch(new Request('https://hub.example/api/packages', { headers: { origin: 'https://hub.example', 'x-forwarded-for': 'spoofed' } }), { address: '127.0.0.7' })).status).toBe(200); }
  finally { await shared.close(); }
  const controller = new AbortController();
  const pending = handler.fetch(new Request('https://hub.example/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({}), duplex: 'half', signal: controller.signal } as RequestInit));
  controller.abort(); expect((await pending).status).toBe(504);

  expect((await handler.fetch(new Request('https://hub.example/api/service', { method: 'POST', headers: { origin: 'https://evil.example' } }))).status).toBe(403);
  expect((await handler.fetch(new Request('https://hub.example/api/service', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(401);
});

it('retains no personal text in the chained audit and deletes personal rows under retention policy', async c => {
  const f = await fixture(c), disposable = await f.login('disposable');
  await f.app.accounts.remove(disposable.context); f.time(1000); expect(await f.app.accounts.maintain(f.admin.context)).toEqual({ deleted: 1 });
  const audit = await f.app.accounts.audit(f.admin.context), encoded = canonicalHubJson(audit);
  expect(encoded).not.toContain('Private Name'); expect(encoded).not.toContain('@private.example'); expect(audit.length).toBeGreaterThan(0);
  const db = new DatabaseSync(join(f.root, 'hub.sqlite'));
  expect(db.prepare("SELECT id FROM hub_service_records WHERE area='personal' AND id=?").get(disposable.accountId)).toBeUndefined();
  db.prepare("UPDATE hub_service_audit SET record=json_set(record,'$.reason','forged') WHERE sequence=1").run(); db.close();
  await expect(f.app.accounts.audit(f.admin.context)).rejects.toThrow(code('HUB_STORE_UNSAFE'));
});

it('rolls cancellation and policy loss back before publication or review can become visible', async c => {
  const f = await fixture(c); f.time(300); const b = f.make(), controller = new AbortController(); controller.abort();
  await expect(f.app.publish(f.owner.context, b.manifest, b.envelope, b.files, controller.signal)).rejects.toThrow();
  expect(await f.opened.store.get('@acme/invoice', '1.0.0')).toBeNull(); await f.publish();
  f.deny(); await expect(f.review()).rejects.toThrow(code('HUB_SERVER_DENIED'));
  expect((await f.opened.store.get('@acme/invoice', '1.0.0'))?.envelope.signatures).toHaveLength(2);
});

it('backs up Hub v2 before service migration and refuses future versions or backup overwrite', async c => {
  const f = await fixture(c); f.opened.close(); closers.splice(closers.indexOf(f.opened.close), 1);
  const path = join(f.root, 'hub.sqlite'), db = new DatabaseSync(path);
  db.exec('DROP TABLE hub_service_records; DROP TABLE hub_service_audit; PRAGMA user_version=2'); db.close();
  const reopened = openHubStore(f.options); reopened.close(); const backup = `${path}.v2.bak`;
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  const migrated = new DatabaseSync(path); expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(HUB_STORE_SCHEMA_VERSION);
  migrated.exec('PRAGMA user_version=99'); migrated.close(); expect(() => openHubStore(f.options)).toThrow(code('HUB_STORE_UNSAFE'));
  copyFileSync(backup, path); const down = new DatabaseSync(path); expect(down.prepare('PRAGMA user_version').get()?.user_version).toBe(2); down.close();
  expect(() => openHubStore(f.options)).toThrow(code('HUB_STORE_UNSAFE'));
});

it('recovers a proved replacement key only after a separate moderator approves and revokes the lost key', async c => {
  const f = await fixture(c); f.time(300);
  await f.publish(); await f.review(); await f.review('1.0.0', moderator2, f.mod2.context);
  const k = f.key(otherPublisher), challenge = await f.app.profiles.keyChallenge(f.owner.context, f.profile.id, k);
  const recovery = await f.app.profiles.requestRecovery(f.owner.context, f.profile.id, challenge.id, publisher.keyId,
    otherPublisher.sign(hubKeyProofMessage(rootKey.keyId, f.profile.id, challenge.id, k)).toString('base64'));
  expect(await f.opened.store.key(otherPublisher.keyId, 'publisher')).toBeNull();
  await f.act('recover-key', f.profile.id, { targetKind: 'profile', recoveryId: recovery.id });
  expect((await f.opened.store.key(publisher.keyId, 'publisher'))?.active).toBe(false);
  expect(await f.opened.store.revocations([{ kind: 'key', id: publisher.keyId }])).toEqual([expect.objectContaining({ severity: 'revoke' })]);
  await f.publish('1.0.1', { publisher: otherPublisher }); expect(await f.review('1.0.1')).toMatchObject({ approved: false, remaining: 1 });
});

it('verifies signed profile/roster evidence offline and refuses a forged profile or online-signed roster', async c => {
  const { verifyHubModerationEvidence } = await import('#engine/core/hub-server/index.js');
  const f = await fixture(c); f.time(300); const b = f.make(); await f.publish(); await f.review(); await f.review('1.0.0', moderator2, f.mod2.context);
  const row = await f.app.inspect(f.owner.context, '@acme/invoice', '1.0.0'), evidence = await f.app.evidence(f.owner.context, '@acme/invoice', '1.0.0');
  const anchors = { hubId: rootKey.keyId, rootPublicKey: rootKey.spki.toString('base64'), attestationKey: f.ports.attestor().key };
  expect(verifyHubModerationEvidence(evidence, { ...b, envelope: row.envelope }, anchors).publisherKind).toBe('person');
  expect(() => verifyHubModerationEvidence({ ...evidence, profile: { ...evidence.profile, handle: 'forged' } }, { ...b, envelope: row.envelope }, anchors)).toThrow();
  const roster = { ...evidence.roster, signature: { keyId: hub.keyId, value: hub.sign(hubRosterMessage(evidence.roster)).toString('base64') } };
  expect(() => verifyHubModerationEvidence({ ...evidence, roster }, { ...b, envelope: row.envelope }, anchors)).toThrow(code('HUB_SIGNER_UNTRUSTED'));
  const log = await f.app.publicLog(f.owner.context);
  expect(log).toHaveLength(1);
  const entry = log[0] as { record: unknown; signature: { value: string; keyId: string } };
  expect(entry.signature.keyId).toBe(hub.keyId);
  expect(verifyEd25519(hub.spki, signatureMessage('hub-moderation-log:1', canonicalHubJson(entry.record)), Buffer.from(entry.signature.value, 'base64'))).toBe(true);
});

it('a real H8 package and feed reach the H2 client only through root-signed key delegations (Astra A56 C2)', async c => {
  const f = await fixture(c); f.time(300); const b = f.make(); await f.publish(); await f.review(); await f.review('1.0.0', moderator2, f.mod2.context);
  // The H8 server never signs with an online key the root has not delegated.
  const undelegated = new HubModeratedApplication({ ...f.ports, delegation: () => null }, f.deps);
  await expect(undelegated.profiles.create(f.owner.context, { schemaVersion: 1, handle: 'nodeleg', kind: 'person', displayName: 'No' })).rejects.toThrow(code('HUB_STORE_UNSAFE'));
  const row = await f.app.inspect(f.owner.context, '@acme/invoice', '1.0.0'), evidence = await f.app.evidence(f.owner.context, '@acme/invoice', '1.0.0');
  const served: HubBundle = { ...b, envelope: row.envelope, delegation: (await f.app.packageDelegation(row.envelope))! }, feed = await f.app.revocations(f.owner.context);
  expect(feed).toMatchObject({ signature: { keyId: feedKey.keyId }, delegation: { keyId: feedKey.keyId, purposes: ['feed'] } });
  // H2 client: the source pins only the root; the moderation resolver takes the attestation key from the root-verified delegation.
  const root = { hubId: rootKey.keyId, publicKey: rootKey.spki.toString('base64') };
  // (The client core applies the trusted-clock rule itself; the resolver only binds the evidence to the delegated key.)
  const resolveTrust: NonNullable<HubClientDependencies['resolveTrust']> = async (_source, value, _principal, _store, nowMs) => {
    const attestation = value.envelope.signatures.find(s => s.role === 'hub')!;
    return verifyHubModerationEvidence(evidence, value, { hubId: root.hubId, rootPublicKey: root.publicKey,
      attestationKey: delegatedHubKey(root, attestation.keyId, value.delegation, 'attestation', attestation.signedAtMs, { nowMs, stored: true }) });
  };
  const client = await clientFixture({ resolveTrust }); roots.push(client.root);
  await client.app.addSource({ schemaVersion: 1, scopeId: 's', commandId: 'add-h8', hubId: root.hubId, publicKey: root.publicKey, expectedRevision: null,
    endpoint: 'https://hub.example', label: 'H8', local: false, trustPolicy: 'hub-moderated' });
  const install = (commandId: string, value: HubBundle, feedValue: unknown = feed) => client.app.installFile({ schemaVersion: 1, scopeId: 's', commandId, hubId: root.hubId,
    bundles: [encodeHubBundle(value)], feed: feedValue, workClassMapping: {} });
  const { delegation: _served, ...bare } = served, { delegation: _feed, ...unsignedFeed } = feed, signedAt = row.envelope.signatures.find(s => s.role === 'hub')!.signedAtMs;
  void _served; void _feed;
  // No delegation, a feed-only delegation, a window that ended before the hub signature, one the online key signed itself, or one that ended
  // before the client's now although the self-asserted signedAtMs (300) lies inside it (backdating with an ended key): never accepted.
  for (const [id, value] of [['bare', bare], ['purpose', { ...served, delegation: delegate(hub, ['feed']) }], ['expired', { ...served, delegation: delegate(hub, ['attestation'], 0, signedAt) }],
    ['self', { ...served, delegation: delegate(hub, ['attestation'], 0, 100000, hub) }], ['backdated', { ...served, delegation: delegate(hub, ['attestation'], 0, 500) }]] as const)
    await expect(install(id, value as HubBundle)).rejects.toThrow(code('HUB_SIGNER_UNTRUSTED'));
  await expect(install('feed-bare', served, unsignedFeed)).rejects.toThrow(code('HUB_SIGNER_UNTRUSTED'));
  // The real server output installs, re-verifies from the stored bundle and exports with its delegation.
  await expect(install('h8', served)).resolves.toMatchObject({ result: [expect.objectContaining({ packageId: '@acme/invoice', state: 'installed' })] });
  const query = { schemaVersion: 1, scopeId: 's', hubId: root.hubId, packageId: '@acme/invoice', version: '1.0.0' };
  await expect(client.app.verify(query)).resolves.toMatchObject({ packageId: '@acme/invoice' });
  expect(JSON.parse(Buffer.from(await client.app.exportFile(query)).toString('utf8'))).toMatchObject({ delegation: { keyId: hub.keyId } });
  const signed = (by: typeof hub, sequence: number, entries: readonly object[] = [], delegation: unknown = by === rootKey ? undefined : delegate(by, ['feed'], 0, 10_000_000)) => {
    const payload = { schemaVersion: 1 as const, hubId: root.hubId, sequence, issuedAtMs: 400, nextRefreshBy: 4000000, entries, ...(delegation ? { delegation } : {}) };
    return { ...payload, signature: { keyId: by.keyId, algorithm: 'ed25519', value: by.sign(hubRevocationFeedMessage(payload as never)).toString('base64') } };
  };
  const apply = (commandId: string, value: unknown) => client.app.applyRevocations({ schemaVersion: 1, scopeId: 's', commandId, hubId: root.hubId, feed: value });
  const revokeKey = { kind: 'key', id: feedKey.keyId, severity: 'revoke', reason: 'compromised', atMs: 400 };
  // Feeds: a key revoked in the feed itself, or a feed delegation that ended before the client's now, are refused.
  await expect(apply('revoke-feed-key', signed(feedKey, feed.sequence + 1, [revokeKey]))).rejects.toThrow(code('HUB_SIGNER_UNTRUSTED'));
  await expect(apply('feed-ended', signed(feedKey, feed.sequence + 1, [], delegate(feedKey, ['feed'], 0, 500)))).rejects.toThrow(code('HUB_SIGNER_UNTRUSTED'));
  // Revocation parity: the scope's local signer revocations withdraw the catalog overlay (stored feed signed by that key) and refuse its next feed.
  const item = (await client.app.inspect({ ...query }))!.items[0]!, catalog = await client.catalog.openStore('read');
  const overlay = (revoked?: string[]) => catalog.upstream!('s', item.kind, item.id, item.revision, 1000, undefined, revoked);
  expect(await overlay()).toBe('clear'); expect(await overlay([feedKey.keyId])).toBe('withdrawn'); catalog.close();
  Object.assign(client.catalog, { revocations: { list: async () => [{ scopeId: 's', keyId: feedKey.keyId, by: { issuer: 'os', subject: 'u' }, atMs: 900, commandId: 'r' }] } });
  await expect(apply('local-revoked', signed(feedKey, feed.sequence + 1))).rejects.toThrow(code('HUB_SIGNER_UNTRUSTED'));
  Object.assign(client.catalog, { revocations: undefined });
  // … and so does an accepted hub entry (a root-signed yank of the feed key).
  await apply('root-yank', signed(rootKey, feed.sequence + 1, [{ ...revokeKey, severity: 'yank' }]));
  await expect(apply('entry-revoked', signed(feedKey, feed.sequence + 2))).rejects.toThrow(code('HUB_SIGNER_UNTRUSTED'));
  // Stored content keeps its historical signing time: after the attestation delegation ended, re-verifying the installed bundle still passes.
  client.time(200000); await expect(client.app.verify(query)).resolves.toMatchObject({ packageId: '@acme/invoice' });
});

it('cannot count a suspended moderator vote during final approval and allows an independent appeal review', async c => {
  const f = await fixture(c); f.time(300); await f.publish(); await f.review();
  await f.act('suspend', f.mod1.accountId, { commandId: 'suspend-mod', targetKind: 'account' }, moderator2, f.mod2.context);
  await expect(f.review('1.0.0', moderator3, f.mod3.context)).rejects.toThrow(code('HUB_REVIEW_REFUSED'));
  await f.act('reject', undefined, { commandId: 'reject-by-mod2' }, moderator2, f.mod2.context);
  const appeal = await f.app.report(f.owner.context, { targetId: hubQueueId('@acme/invoice', '1.0.0'), reason: 'license', appealOf: 'reject-by-mod2' });
  await f.act('restore', undefined, { commandId: 'appeal-restore', appealId: appeal.id }, moderator3, f.mod3.context);
  expect((await f.app.moderation.queue(f.mod3.context))[0]).toMatchObject({ state: 'pending-review', approvals: [] });
});

it('requires two people to ban an account while preserving its narrow authenticated appeal path', async c => {
  const f = await fixture(c); f.time(300); await f.publish();
  await f.act('ban', f.owner.accountId, { targetKind: 'account', reason: 'malware' });
  expect((await f.opened.store.get('@acme/invoice', '1.0.0'))?.manifest).toBeDefined();
  await f.act('ban', f.owner.accountId, { targetKind: 'account', reason: 'malware' }, moderator2, f.mod2.context);
  await expect(f.app.session(f.owner.token)).rejects.toThrow(code('HUB_SERVER_DENIED'));
  const restricted = await f.app.session(f.owner.token, true);
  await expect(f.app.profiles.create(restricted, { schemaVersion: 1, handle: 'forbidden', kind: 'person', displayName: 'Forbidden' })).rejects.toThrow(code('HUB_SERVER_DENIED'));
  expect(await f.app.report(restricted, { targetId: f.owner.accountId, reason: 'license', appealOf: 'ban-case' })).toMatchObject({ accountId: f.owner.accountId });
});

it('refuses the root online or one shared attestation/feed key before service state can be signed', async c => {
  const f = await fixture(c);
  const shared = new HubModeratedApplication({ ...f.ports, feedSigner: f.ports.attestor }, f.deps);
  await expect(shared.profiles.create(f.owner.context, { schemaVersion: 1, handle: 'shared', kind: 'person', displayName: 'Shared' })).rejects.toThrow(code('HUB_STORE_UNSAFE'));
  const rootOnline = new HubModeratedApplication({ ...f.ports, attestor: () => ({ signer: rootKey,
    key: { keyId: rootKey.keyId, publicKey: rootKey.spki.toString('base64'), role: 'hub', active: true } }) }, f.deps);
  await expect(rootOnline.profiles.create(f.owner.context, { schemaVersion: 1, handle: 'root', kind: 'person', displayName: 'Root' })).rejects.toThrow(code('HUB_STORE_UNSAFE'));
});

it('bounds recovery keys under the same profile key limit as ordinary key enrollment', async c => {
  const f = await fixture(c, { maxKeys: 1 }), k = f.key(otherPublisher);
  const challenge = await f.app.profiles.keyChallenge(f.owner.context, f.profile.id, k);
  const proof = otherPublisher.sign(hubKeyProofMessage(rootKey.keyId, f.profile.id, challenge.id, k)).toString('base64');
  await expect(f.app.profiles.requestRecovery(f.owner.context, f.profile.id, challenge.id, publisher.keyId, proof)).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  await expect(f.app.profiles.addKey(f.owner.context, f.profile.id, challenge.id, proof)).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
});


it('requires invitee consent through the authenticated service API before signing membership (H8B)', async c => {
  const f = await fixture(c);
  const handler = createHubServiceHttpHandler(f.app, { endpoint: 'https://hub.example/', addressId: () => f.address, publicContext: f.owner.context });
  const request = (token: string, operation: string, input: unknown) => handler.fetch(new Request('https://hub.example/api/service', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: canonicalHubJson({ operation, input }) }));
  const members = [...f.profile.members, { accountId: f.mod1.accountId, role: 'publisher' }];
  expect((await request(f.owner.token, 'profile.members', { profileId: f.profile.id, members })).status).toBe(403);
  const before = await f.app.publicProfile(f.owner.context, 'acme');
  const invitation = await (await request(f.owner.token, 'profile.invite', { profileId: f.profile.id, member: members[1] })).json() as { id: string };
  expect(await f.app.publicProfile(f.owner.context, 'acme')).toEqual(before);
  expect((await request(f.mod2.token, 'profile.invitation.respond', { invitationId: invitation.id, decision: 'accept' })).status).toBe(403);
  expect((await request(f.owner.token, 'profile.invitation.respond', { invitationId: invitation.id, decision: 'accept' })).status).toBe(403);
  await expect(f.app.profiles.respond({ ...f.owner.context, principal: f.mod1.context.principal }, invitation.id, 'accept')).rejects.toThrow(code('HUB_SERVER_DENIED'));
  expect(await (await request(f.mod2.token, 'profile.invitations', {})).json()).toEqual([]);
  expect(await (await request(f.mod1.token, 'profile.invitations', {})).json()).toMatchObject([{ id: invitation.id, state: 'pending' }]);
  const response = await request(f.mod1.token, 'profile.invitation.respond', { invitationId: invitation.id, decision: 'accept' });
  expect(response.status).toBe(200);
  const { profile } = await response.json() as { profile: typeof f.profile };
  expect(profile.members).toEqual(members); expect(profile.sequence).toBe(before.sequence + 1);
  const { signature, ...payload } = profile;
  expect(verifyEd25519(hub.spki, signatureMessage('hub-profile:1', canonicalHubJson({ hubId: rootKey.keyId, ...payload })), Buffer.from(signature.value, 'base64'))).toBe(true);
  await expect(f.app.profiles.respond(f.mod1.context, invitation.id, 'accept')).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  await expect(f.app.profiles.members(f.owner.context, f.profile.id, [f.profile.members[0]!, { accountId: f.mod1.accountId, role: 'owner' }])).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  const reopened = openHubStore(f.options); closers.push(reopened.close);
  const app = new HubModeratedApplication({ ...f.ports, store: reopened.store }, f.deps);
  expect(await app.profiles.invitations(f.mod1.context)).toMatchObject([{ id: invitation.id, state: 'accepted' }]);
  expect((await app.publicProfile(f.owner.context, 'acme')).members).toEqual(members);
  const audit = canonicalHubJson(await f.app.accounts.audit(f.admin.context));
  expect(audit).toContain('profile-invite'); expect(audit).toContain('profile-invitation-accepted');
});

it('does not let pending invitations sabotage moderation or newly accepted old accounts bypass age gates (H8B)', async c => {
  const f = await fixture(c); f.time(300);
  const young = await f.login('young-owner');
  await f.app.profiles.members(f.owner.context, f.profile.id, f.profile.members);
  // Existing accounts are old enough, but their new memberships have their own age.
  const invitation = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'owner' });
  await f.publish(); expect(await f.review()).toMatchObject({ approved: false });
  await f.app.profiles.respond(f.mod1.context, invitation.id, 'accept');
  await f.addKey(otherPublisher, f.mod1.context.principal);
  await expect(f.publish('1.0.1', { publisher: otherPublisher }, f.mod1.context)).rejects.toThrow(code('HUB_ACCOUNT_REFUSED'));
  await f.app.profiles.members(f.mod1.context, f.profile.id, [{ accountId: f.mod1.accountId, role: 'owner' }]);
  const aiSigner = seed('09'), aiContext = { scopeId: 's', principal: { kind: 'ai' as const, id: 'agent' } };
  const k = f.key(aiSigner, aiContext.principal);
  const challenge = await f.app.profiles.keyChallenge(f.mod1.context, f.profile.id, k);
  await f.app.profiles.addKey(f.mod1.context, f.profile.id, challenge.id, aiSigner.sign(hubKeyProofMessage(rootKey.keyId, f.profile.id, challenge.id, k)).toString('base64'));
  await expect(f.publish('1.0.2', { publisher: aiSigner, kind: 'ai' }, aiContext)).rejects.toThrow(code('HUB_ACCOUNT_REFUSED'));
  const fresh = await f.app.profiles.create(young.context, { schemaVersion: 1, handle: 'young', kind: 'organisation', displayName: 'Young' });
  const older = await f.app.profiles.invite(young.context, fresh.id, { accountId: f.mod2.accountId, role: 'owner' });
  await f.app.profiles.respond(f.mod2.context, older.id, 'accept');
  const consent = await f.opened.store.transaction(async tx => tx.service!.get('membership-consents', fresh.id));
  expect(consent).toMatchObject({ createdAtMs: 300, members: [{ accountId: young.accountId, acceptedAtMs: 300 }, { accountId: f.mod2.accountId, acceptedAtMs: 300 }] });
  const freshSigner = seed('0a'), freshKey = { ...f.key(freshSigner, f.mod2.context.principal), publisherId: '@young' };
  const freshChallenge = await f.app.profiles.keyChallenge(young.context, fresh.id, freshKey);
  await f.app.profiles.addKey(young.context, fresh.id, freshChallenge.id,
    freshSigner.sign(hubKeyProofMessage(rootKey.keyId, fresh.id, freshChallenge.id, freshKey)).toString('base64'));
  const b = f.make('1.0.0', { publisher: freshSigner, agent: false }), manifest = { ...b.manifest, packageId: '@young/invoice' }, envelope = { ...b.envelope, payloadDigest: sha256(canonicalHubJson(manifest)) };
  const signature = { role: 'publisher' as const, signedAtMs: 300 };
  envelope.signatures = [{ ...signature, keyId: freshSigner.keyId, algorithm: 'ed25519', value: freshSigner.sign(hubPackageSignatureMessage(manifest, envelope, signature)).toString('base64') }];
  await expect(f.app.publish(f.mod2.context, manifest, envelope, b.files)).rejects.toThrow(code('HUB_ACCOUNT_REFUSED'));

  f.time(400); await f.publish('1.0.1', { publisher: otherPublisher }, f.mod1.context);
  await f.publish('1.0.2', { publisher: aiSigner, kind: 'ai' }, aiContext);
  await f.app.publish(f.mod2.context, manifest, envelope, b.files);
});

it('makes decline and policy expiry terminal, audited decisions without adding a member (H8B)', async c => {
  const f = await fixture(c, { challengeTtlMs: 20 });
  const declined = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'owner' });
  expect(await f.app.profiles.respond(f.mod1.context, declined.id, 'decline')).toMatchObject({ invitation: { state: 'declined' }, profile: null });
  await expect(f.app.profiles.respond(f.mod1.context, declined.id, 'accept')).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  const expired = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'owner' });
  f.time(120);
  expect(await f.app.profiles.respond(f.mod1.context, expired.id, 'accept')).toMatchObject({ invitation: { state: 'expired' }, profile: null });
  await expect(f.app.profiles.respond(f.mod1.context, expired.id, 'accept')).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  const maintained = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod2.accountId, role: 'owner' });
  f.time(140); await f.app.accounts.maintain(f.admin.context);
  expect(await f.app.profiles.invitations(f.mod2.context)).toMatchObject([{ id: maintained.id, state: 'expired' }]);
  expect((await f.app.publicProfile(f.owner.context, 'acme')).members).toEqual(f.profile.members);
  const audit = canonicalHubJson(await f.app.accounts.audit(f.admin.context));
  expect(audit).toContain('profile-invitation-declined'); expect(audit).toContain('profile-invitation-expired');
});

it('bounds invitation writes and acceptance capacity and rolls cancellation back (H8B)', async c => {
  const f = await fixture(c, { maxMembers: 2 });
  const first = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'publisher' });
  await expect(f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'publisher' })).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  const second = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod2.accountId, role: 'publisher' });
  const abort = new AbortController(); abort.abort();
  await expect(f.app.profiles.respond(f.mod1.context, first.id, 'accept', abort.signal)).rejects.toThrow();
  expect((await f.app.publicProfile(f.owner.context, 'acme')).members).toEqual(f.profile.members);
  await f.app.profiles.respond(f.mod1.context, first.id, 'accept');
  await expect(f.app.profiles.respond(f.mod2.context, second.id, 'accept')).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  await f.app.profiles.members(f.owner.context, f.profile.id, f.profile.members);
  const limited = new HubModeratedApplication(f.ports, { ...f.deps, policy: { ...f.deps.policy, maxChallenges: 1 } });
  await expect(limited.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod3.accountId, role: 'publisher' })).rejects.toThrow(code('HUB_RATE_REFUSED'));
  f.time(5100); await expect(limited.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod3.accountId, role: 'publisher' })).resolves.toMatchObject({ state: 'pending' });
});

it('never drops an unconsented legacy member or leaves their key active when an invitation is accepted (H8C)', async c => {
  const f = await fixture(c); f.time(300);
  const legacy = f.key(otherPublisher, f.mod1.context.principal);
  await f.opened.store.transaction(async tx => {
    await tx.putKey(legacy);
    await f.app.saveProfile(tx, { ...f.profile, members: [...f.profile.members, { accountId: f.mod1.accountId, role: 'publisher' }], sequence: f.profile.sequence + 1,
      keys: [...f.profile.keys, { keyId: legacy.keyId, publicKey: legacy.publicKey, principalId: f.mod1.accountId, principalKind: 'person', memberAccountId: f.mod1.accountId, addedAtMs: 300, state: 'active' }] });
  });
  const invitation = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod2.accountId, role: 'publisher' });
  const { profile } = await f.app.profiles.respond(f.mod2.context, invitation.id, 'accept');
  expect(profile!.members.map(m => m.accountId)).toEqual([f.owner.accountId, f.mod1.accountId, f.mod2.accountId]);
  expect(profile!.keys.find(k => k.keyId === legacy.keyId)?.state).toBe('active');
});

it('refuses to invite or accept an account that is already listed and rejects duplicate member ids (H8D)', async c => {
  const f = await fixture(c); f.time(300);
  await f.opened.store.transaction(async tx => {
    await f.app.saveProfile(tx, { ...f.profile, members: [...f.profile.members, { accountId: f.mod1.accountId, role: 'publisher' }], sequence: f.profile.sequence + 1 });
  });
  await expect(f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'owner' })).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  const duplicate = { ...f.profile, members: [...f.profile.members, { accountId: f.owner.accountId, role: 'publisher' as const }] };
  await expect(f.opened.store.transaction(async tx => f.app.saveProfile(tx, duplicate))).rejects.toThrow();
});

it('rechecks inviter ownership and account moderation when an invitation is accepted (H8B)', async c => {
  const f = await fixture(c); f.time(300);
  const owner = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'owner' });
  await f.app.profiles.respond(f.mod1.context, owner.id, 'accept');
  const pending = await f.app.profiles.invite(f.mod1.context, f.profile.id, { accountId: f.mod2.accountId, role: 'publisher' });
  await f.app.profiles.members(f.owner.context, f.profile.id, f.profile.members);
  await expect(f.app.profiles.respond(f.mod2.context, pending.id, 'accept')).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  const suspended = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod3.accountId, role: 'publisher' });
  await f.act('suspend', f.mod3.accountId, { targetKind: 'account' }, moderator2, f.mod2.context);
  await expect(f.app.profiles.respond(f.mod3.context, suspended.id, 'accept')).rejects.toThrow(code('HUB_SERVER_DENIED'));
});

it('recovers only creator consent from verified legacy profile audit without changing the Hub SQL schema (H8B)', async c => {
  const f = await fixture(c, { maxMembers: 2 }); f.time(300);
  await f.opened.store.transaction(async tx => {
    tx.service!.remove('membership-consents', f.profile.id);
    await f.app.saveProfile(tx, { ...f.profile, members: [...f.profile.members, { accountId: f.mod1.accountId, role: 'owner' }] });
  });
  await expect(f.app.profiles.invite(f.mod1.context, f.profile.id, { accountId: f.mod2.accountId, role: 'publisher' })).rejects.toThrow(code('HUB_SERVER_DENIED'));
  // Invites never duplicate or drop the unconsented legacy member; the owner removes them through members().
  await expect(f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'owner' })).rejects.toThrow(code('HUB_PROFILE_REFUSED'));
  await f.app.profiles.members(f.owner.context, f.profile.id, f.profile.members);
  const invitation = await f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod1.accountId, role: 'owner' });
  await f.app.profiles.respond(f.mod1.context, invitation.id, 'accept');
  expect((await f.app.publicProfile(f.owner.context, 'acme')).members).toHaveLength(2);
  await f.opened.store.transaction(async tx => tx.service!.remove('membership-consents', f.profile.id));
  const db = new DatabaseSync(join(f.root, 'hub.sqlite'));
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(HUB_STORE_SCHEMA_VERSION);
  db.prepare("UPDATE hub_service_audit SET record=json_set(record,'$.actor','forged') WHERE json_extract(record,'$.action')='profile-create'").run(); db.close();
  await expect(f.app.profiles.invite(f.owner.context, f.profile.id, { accountId: f.mod2.accountId, role: 'publisher' })).rejects.toThrow(code('HUB_STORE_UNSAFE'));
});
