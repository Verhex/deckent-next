import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { serializeJsonDocument, writeTextAtomic } from '#platform/index.js';
import { delegationOwner, delegationPrincipalClass, type VerifiedPrincipal } from '#domain/index.js';
import { personalCustodyEvidenceSchema, PersonalCustodyError, RENEWABLE_SECRET_PREFIX,
  type PersonalCustodyOwner, type SecretStore, type SecretStoreContext, type SecretStoreDescriptor } from '#engine/index.js';
import { ENCRYPTED_FILE_SECRET_STORE_ID } from './encrypted.js';
import { initializePrivateSecretDocument } from './file.js';
import { custodyDigest, observePersonalStoreHost, personalPrivateFile, type PersonalHostObservation } from './personal-host.js';
import { PERSONAL_CUSTODY_REGISTRY as registry } from './personal-registry.js';

const provenance = new WeakMap<SecretStoreDescriptor, Readonly<{ store: SecretStore; context: SecretStoreContext }>>();
/** Called only by the registered factory composition. An equal descriptor object is not the opened store. */
export function rememberPersonalStoreInstance(store: SecretStore, context: SecretStoreContext): SecretStore {
  provenance.set(store.descriptor, Object.freeze({ store, context: Object.freeze({ ...context }) }));
  return store;
}
export interface PersonalStoreContext {
  /** Trusted composition refreshes authentication, membership, profile and installation binding, never from request-supplied evidence. */
  snapshot(): Promise<Readonly<{ owner: PersonalCustodyOwner; actor: VerifiedPrincipal;
    profile: { id: string; version: number; digest: string }; locationDigest: string; peer?: { pid: number; uid: number; witness: string } }>>;
  witness(): Promise<boolean>;
  /** Explicit witnessed reconnect may adopt identical-owner token-free registration history; never a renewable session. */
  reconnect?: boolean;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/u), text = z.string().min(1).max(256), count = z.number().int().nonnegative().safe();
const bindingSchema = z.object({ schemaVersion: z.literal(1), bindingId: z.string().uuid(), generation: count,
  uid: count, installationId: text, principal: z.object({ issuer: text, subject: text }).strict(),
  locationDigest: hash, installationLocationDigest: hash, keyIdentityDigest: hash,
  cleanup: z.object({ state: z.literal('complete'), revision: count }).strict() }).strict();
/** The installation's existing custody lock owns this record. Host observation injection is a code-only test seam. */
export function personalStoreAssertion(root: string | null, context: PersonalStoreContext,
  selected: () => Promise<{ store: string | null; digest: string | null }>,
  observe: (root: string, uid: number) => Promise<PersonalHostObservation> = observePersonalStoreHost) {
  return async (descriptor: SecretStoreDescriptor, owner: PersonalCustodyOwner) => {
    const known = provenance.get(descriptor);
    if (!known || known.context.vault || !root || known.context.root !== root || descriptor.id !== ENCRYPTED_FILE_SECRET_STORE_ID)
      throw new PersonalCustodyError('shared-store');
    const verified = await context.snapshot(), os = userInfo(), actorOwner = delegationOwner(verified.actor);
    if (!isDeepStrictEqual(verified.owner, owner) || !verified.actor.scopeIds.includes(owner.scopeId)
      || !isDeepStrictEqual(actorOwner, owner.principal)) throw new PersonalCustodyError('non-person-owner');
    if (verified.peer && (verified.peer.uid !== os.uid || verified.peer.pid < 1 || !verified.peer.witness)) throw new PersonalCustodyError('foreign-os-owner');
    if (os.uid < 1 || owner.principal.issuer !== hostname() || owner.principal.subject !== String(os.uid))
      throw new PersonalCustodyError('foreign-os-owner');
    if (!hash.safeParse(verified.profile.digest).success) throw new PersonalCustodyError('profile-unresolved');
    const selection = await selected();
    if (selection.store !== descriptor.id) throw new PersonalCustodyError('binding-changed');
    const freshHost = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([observe(root, os.uid), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PersonalCustodyError('unknown-locality')), registry.probeTimeoutMs); timer.unref();
      })]); } finally { clearTimeout(timer); }
    };
    let host = await freshHost();
    const path = join(root, registry.bindingFile), saved = await personalPrivateFile(path, os.uid, registry.metadataMaxBytes, true);
    let binding: z.infer<typeof bindingSchema>;
    if (saved) {
      try { binding = bindingSchema.parse(JSON.parse(saved.text)); }
      catch { throw new PersonalCustodyError('cleanup-pending'); }
    } else {
      if (delegationPrincipalClass(verified.actor) !== 'person' || !['os-user', 'linux-so-peercred'].includes(verified.actor.assurance)
        || !await context.witness()) throw new PersonalCustodyError('unbound-store');
      const protectedNames = (await known.store.listNames()).filter(name => name.startsWith(RENEWABLE_SECRET_PREFIX));
      if (protectedNames.length) {
        if (!context.reconnect) throw new PersonalCustodyError('unbound-store');
        for (const name of protectedNames) {
          let record: unknown;
          try { record = JSON.parse(await known.store.get(name) ?? ''); } catch { throw new PersonalCustodyError('cleanup-pending'); }
          // Old registration is history only. No old token is reused or erased and no other person's history is rebound.
          const parsed = z.object({ owner: z.unknown(), tokens: z.null(), state: z.enum(['registration', 'disconnected']) }).passthrough().safeParse(record);
          if (!parsed.success || !isDeepStrictEqual(parsed.data.owner, owner)) throw new PersonalCustodyError('cleanup-pending');
        }
      }
      if (!host.pairPresent) {
        await initializePrivateSecretDocument(known.store);
        host = await freshHost();
      }
      if (!host.keyIdentityDigest) throw new PersonalCustodyError('unsafe-root');
      binding = bindingSchema.parse({ schemaVersion: 1, bindingId: randomUUID(), generation: 1, uid: os.uid,
        installationId: owner.installationId, principal: owner.principal, locationDigest: host.locationDigest,
        installationLocationDigest: verified.locationDigest, keyIdentityDigest: host.keyIdentityDigest, cleanup: { state: 'complete', revision: 1 } });
      await writeTextAtomic(path, serializeJsonDocument(binding));
    }
    if (binding.uid !== os.uid || binding.installationId !== owner.installationId || !isDeepStrictEqual(binding.principal, owner.principal)
      || binding.locationDigest !== host.locationDigest || binding.installationLocationDigest !== verified.locationDigest
      || binding.keyIdentityDigest !== host.keyIdentityDigest) throw new PersonalCustodyError('binding-changed');
    if (!host.pairPresent) throw new PersonalCustodyError('binding-changed');
    const linked = await personalPrivateFile(path, os.uid, registry.metadataMaxBytes, true), after = await freshHost();
    if (!linked || linked.text !== serializeJsonDocument(binding) || custodyDigest(after) !== custodyDigest(host)
      || !isDeepStrictEqual(selection, await selected())) throw new PersonalCustodyError('binding-changed');
    return personalCustodyEvidenceSchema.parse({ schemaVersion: 1, producer: 'local-os-store', owner,
      os: { uid: os.uid, assurance: verified.peer ? 'linux-so-peercred' : 'os-user', peerPid: verified.peer?.pid ?? null, connectionWitness: verified.peer?.witness ?? null }, profile: verified.profile,
      store: { backendId: descriptor.id, instanceBindingId: binding.bindingId, generation: binding.generation,
        role: 'personal-main', selectionDigest: selection.digest },
      host: { locationDigest: host.locationDigest, keyIdentityDigest: host.keyIdentityDigest, mountEvidenceDigest: host.mountEvidenceDigest, locality: 'local', control: 'os-account-exclusive' }, cleanup: binding.cleanup, observedAtMs: Date.now() });
  };
}
