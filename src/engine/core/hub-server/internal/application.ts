import { HUB_LIMITS, HUB_REVIEW_LEVELS, HubError, canonicalHubJson, hubEnvelopeSchema, hubPackageSchema, hubPackageSignatureSchema, parseHubContract,
  type HubEnvelope, type HubPackage, type HubPackageSignature } from '#domain/index.js';
import { ed25519KeyId, hasSecret, REDACTION_GATE_PATTERNS, sha256 } from '#platform/index.js';
import { canonicalHubManifest, hubPackageSignatureMessage, requireHubSignature, verifyHubPackage, type HubPackageFile } from '#engine/core/hub/index.js';
import { requireHubDependencies, newerHubVersion } from './dependencies.js';
import { HubServerError, hubActorSchema, hubRegisteredKeySchema, type HubRegisteredKey, type HubServerAction, type HubServerContext, type HubServerPorts, type HubStoredVersion, type HubServerTransaction, type HubServerSigner } from './ports.js';

export class HubServerApplication {
  constructor(readonly ports: HubServerPorts) {
    if (!/^[a-f0-9]{64}$/.test(ports.hubId) || !ports.scopeId) throw new HubServerError('HUB_STORE_UNSAFE');
  }
  private async authorize(context: HubServerContext, action: HubServerAction, resource: string, digest: string) {
    if (context.scopeId !== this.ports.scopeId || !hubActorSchema.safeParse(context.principal).success) throw new HubServerError('HUB_SERVER_DENIED');
    await this.ports.authority.require(context, action, resource, digest);
  }
  private async registered(keyId: string, role: HubRegisteredKey['role'], store: Pick<HubServerTransaction, 'key'> = this.ports.store): Promise<HubRegisteredKey> {
    const key = await store.key(keyId, role);
    if (!key?.active) throw new HubError('HUB_SIGNER_UNTRUSTED');
    return key;
  }
  private bound(context: HubServerContext, key: HubRegisteredKey) {
    if (key.principal.id !== context.principal.id || key.principal.kind !== context.principal.kind) throw new HubServerError('HUB_SERVER_DENIED');
  }
  private clock() {
    const now = this.ports.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new HubServerError('HUB_STORE_UNSAFE');
    return now;
  }
  private async signer(now: number) {
    const attestor = await this.ports.attestor(now);
    if (!attestor.key.active || attestor.key.role !== 'hub' || attestor.key.keyId !== attestor.signer.keyId
      || ed25519KeyId(attestor.signer.spki) !== attestor.key.keyId || attestor.key.publicKey !== attestor.signer.spki.toString('base64')) throw new HubError('HUB_SIGNER_UNTRUSTED');
    return attestor;
  }
  async register(context: HubServerContext, input: unknown) {
    const key = hubRegisteredKeySchema.parse(input), digest = sha256(canonicalHubJson(key));
    return this.ports.store.transaction(async store => {
      if (context.principal.kind !== 'person') throw new HubServerError('HUB_SERVER_DENIED');
      await this.authorize(context, 'register', key.keyId, digest);
      if (ed25519KeyId(Buffer.from(key.publicKey, 'base64')) !== key.keyId || key.role === 'publisher' && !key.publisherId
        || key.role === 'reviewer' && key.publisherId) throw new HubError('HUB_SIGNER_UNTRUSTED');
      const existing = await store.key(key.keyId, key.role);
      if (existing && canonicalHubJson({ ...existing, active: key.active, trustedAiReviewer: key.trustedAiReviewer }) !== canonicalHubJson(key)) throw new HubServerError('HUB_STORE_CONFLICT');
      const now = this.clock(), { signer } = await this.signer(now);
      await store.putKey(key);
      const receipt = await store.appendReceipt({ action: 'register', context, resource: key.keyId, digest, atMs: now }, signer);
      await this.authorize(context, 'register', key.keyId, digest);
      return receipt;
    });
  }
  async publish(context: HubServerContext, manifestInput: unknown, envelopeInput: unknown, inputFiles: readonly HubPackageFile[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const manifest = parseHubContract(hubPackageSchema, manifestInput, 'HUB_PACKAGE_INVALID', 'HUB_PACKAGE_SCHEMA_UNSUPPORTED');
    const digest = sha256(canonicalHubManifest(manifest));
    await this.authorize(context, 'publish', manifest.packageId, digest);
    // Snapshot caller-owned buffers before async storage; all validation/signing uses this same snapshot.
    if (inputFiles.length + 2 > HUB_LIMITS.packageMaxFiles || inputFiles.reduce((n, f) => n + f.bytes.byteLength, 0) > HUB_LIMITS.packageMaxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
    const files = inputFiles.map(f => ({ path: f.path, bytes: Buffer.from(f.bytes) }));
    const envelope = parseHubContract(hubEnvelopeSchema, envelopeInput, 'HUB_ENVELOPE_INVALID', 'HUB_ENVELOPE_SCHEMA_UNSUPPORTED');
    const verify = async (store: Pick<HubServerTransaction, 'key'> = this.ports.store) => {
      const publisherSignature = (envelope as HubEnvelope)?.signatures?.find(s => s.role === 'publisher');
      const publisher = await this.registered(publisherSignature?.keyId ?? '', 'publisher', store);
      this.bound(context, publisher);
      if (manifest.packageId.split('/')[0] !== publisher.publisherId) throw new HubServerError('HUB_SERVER_DENIED');
      if (manifest.provenance.authoredBy.kind !== context.principal.kind || manifest.provenance.origin === 'lessons(derived)' && context.principal.kind !== 'person') throw new HubServerError('HUB_SERVER_DENIED');
      if (envelope.signatures.some(s => s.role === 'hub')) throw new HubError('HUB_FOREIGN_PACKAGE');
      const signed = verifyHubPackage(manifest, envelope, files, { publisher, reviewers: [] });
      if (signed.signatures.length !== 1) throw new HubError('HUB_FOREIGN_PACKAGE');
      return { publisher, signed };
    };
    const verified = await verify();
    if (manifest.items.some(item => item.kind === 'skill' && item.files.some(f => ['deckent-package.json', 'deckent-envelope.json'].includes(f.path.toLowerCase())))) throw new HubError('HUB_SKILL_INVALID');
    const known = this.ports.knownSecrets();
    const secret = (text: string) => hasSecret(text, known) || REDACTION_GATE_PATTERNS.some(pattern => new RegExp(pattern.source, pattern.flags).test(text));
    if (secret(canonicalHubJson(manifest)) || files.some(file => secret(Buffer.from(file.bytes).toString('utf8')))) throw new HubServerError('HUB_SECRET_REFUSED');
    await this.requirePublication(this.ports.store, manifest, verified.publisher.publisherId!, this.clock());
    const artifacts: { path: string; artifact: HubStoredVersion['files'][number]['artifact'] }[] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      const artifact = await this.ports.artifacts.put(this.ports.scopeId, file.bytes);
      if (artifact.scopeId !== this.ports.scopeId || artifact.digest !== sha256(file.bytes) || artifact.byteLength !== file.bytes.byteLength) throw new HubError('HUB_DIGEST_MISMATCH');
      artifacts.push({ path: file.path, artifact });
    }
    signal?.throwIfAborted();
    return this.ports.store.transaction(async store => {
      signal?.throwIfAborted();
      await this.authorize(context, 'publish', manifest.packageId, digest);
      const { publisher, signed } = await verify(store), now = this.clock();
      if (signed.signatures.some(s => s.signedAtMs > now)) throw new HubError('HUB_SIGNATURE_INVALID');
      await this.requirePublication(store, manifest, publisher.publisherId!, now);
      const { signer, key } = await this.signer(now);
      const signature = await this.sign(manifest, signed, signer, { role: 'hub', signedAtMs: now });
      const accepted = { ...signed, signatures: [...signed.signatures, signature] };
      verifyHubPackage(manifest, accepted, files, { publisher, hub: key, reviewers: [] });
      signal?.throwIfAborted();
      await this.authorize(context, 'publish', manifest.packageId, digest);
      await store.insert({ manifest, envelope: accepted, files: artifacts, revision: 1 }, now, publisher.publisherId!);
      const receipt = await store.appendReceipt({ action: 'publish', context, resource: `${manifest.packageId}@${manifest.version}`, digest: sha256(canonicalHubJson(accepted)), atMs: now }, signer);
      signal?.throwIfAborted();
      await this.authorize(context, 'publish', manifest.packageId, digest);
      return { envelope: accepted, receipt };
    });
  }
  private async requirePublication(store: Pick<HubServerTransaction, 'latest' | 'publishesSince' | 'get'>, manifest: HubPackage, publisherId: string, now: number) {
    const previous = await store.latest(manifest.packageId);
    if (previous && !newerHubVersion(manifest.version, previous.manifest.version)) throw new HubServerError('HUB_VERSION_CONFLICT');
    if ((await store.publishesSince(publisherId, now - 60 * 60 * 1000)) >= HUB_LIMITS.publishesPerHour) throw new HubError('HUB_LIMIT_EXCEEDED');
    await requireHubDependencies(store, this.ports.hubId, manifest);
  }
  async review(context: HubServerContext, packageId: string, version: string, input: unknown) {
    const signature = hubPackageSignatureSchema.parse(input);
    return this.ports.store.transaction(async store => {
      const row = await this.requireVersion(packageId, version, store);
      await this.authorize(context, 'review', packageId, sha256(canonicalHubJson(row.envelope)));
      const reviewer = await this.registered(signature.keyId, 'reviewer', store); this.bound(context, reviewer);
      const publisher = await this.registered(row.envelope.signatures.find(s => s.role === 'publisher')!.keyId, 'publisher', store);
      const level = HUB_REVIEW_LEVELS.levels.find(l => l.id === signature.reviewLevel);
      if (signature.role !== 'reviewer' || !level || level.personOnly && reviewer.principal.kind !== 'person'
        || reviewer.principal.kind !== 'person' && !reviewer.trustedAiReviewer || reviewer.keyId === publisher.keyId || reviewer.principal.id === publisher.principal.id
        || row.envelope.signatures.some(s => s.role === 'reviewer' && s.keyId === signature.keyId)) throw new HubServerError('HUB_REVIEW_REFUSED');
      const now = this.clock();
      if (signature.signedAtMs > now) throw new HubServerError('HUB_REVIEW_REFUSED');
      requireHubSignature(reviewer, signature.keyId, hubPackageSignatureMessage(row.manifest, row.envelope, signature), signature.value);
      const envelope = { ...row.envelope, signatures: [...row.envelope.signatures, signature] };
      if (envelope.signatures.filter(s => s.role === 'reviewer').length > HUB_LIMITS.reviewerSignaturesMax) throw new HubError('HUB_LIMIT_EXCEEDED');
      const { signer } = await this.signer(now);
      await store.replaceEnvelope(packageId, version, row.revision, envelope);
      const receipt = await store.appendReceipt({ action: 'review', context, resource: `${packageId}@${version}`, digest: sha256(canonicalHubJson(envelope)), atMs: now }, signer);
      await this.authorize(context, 'review', packageId, sha256(canonicalHubJson(row.envelope)));
      return { envelope, receipt };
    });
  }
  private async sign(manifest: HubStoredVersion['manifest'], envelope: HubEnvelope, signer: HubServerSigner, signature: Omit<HubPackageSignature, 'algorithm' | 'keyId' | 'value'>): Promise<HubPackageSignature> {
    return { ...signature, keyId: signer.keyId, algorithm: 'ed25519', value: Buffer.from(await signer.sign(hubPackageSignatureMessage(manifest, envelope, signature))).toString('base64') };
  }
  private async requireVersion(packageId: string, version: string, store: Pick<HubServerTransaction, 'get'> = this.ports.store): Promise<HubStoredVersion> {
    const row = await store.get(packageId, version);
    if (!row) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
    return row;
  }
  async inspect(context: HubServerContext, packageId: string, version: string) {
    await this.authorize(context, 'read', packageId, '');
    return this.requireVersion(packageId, version);
  }
  async listSkills(context: HubServerContext, after = '', limit = HUB_LIMITS.searchPageMax) {
    await this.authorize(context, 'read', 'skills', '');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HUB_LIMITS.searchPageMax || after.length > HUB_LIMITS.packageMaxBytes) throw new HubError('HUB_LIMIT_EXCEEDED');
    return this.ports.store.skills(after, limit);
  }
  async readFile(context: HubServerContext, packageId: string, version: string, path: string) {
    const row = await this.inspect(context, packageId, version), file = row.files.find(f => f.path === path);
    if (!file) throw new HubServerError('HUB_RESOURCE_UNKNOWN');
    const bytes = await this.ports.artifacts.read(this.ports.scopeId, file.artifact);
    await this.authorize(context, 'read', packageId, row.envelope.payloadDigest);
    if (bytes.byteLength !== file.artifact.byteLength || sha256(bytes) !== file.artifact.digest) throw new HubError('HUB_DIGEST_MISMATCH');
    return bytes;
  }
}
