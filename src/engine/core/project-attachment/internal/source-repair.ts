import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assessAttachmentLocation, encodeCommandProjection,
  readableInstallationRegistrationSchema, type InstallationBinding, type InstallationSource, type ReadableInstallationRegistration } from '#domain/index.js';
import { classifyInstallationRebinding, type RegisteredInstallationBinding } from '#engine/core/bootstrap-identity/index.js';

const decimalDevice = /^\d{1,20}$/u;
export const bindingKey = (binding: InstallationBinding) => createHash('sha256').update(encodeCommandProjection('installation-binding-key:1', {
  machineDigest: 'machineDigest' in binding ? binding.machineDigest : null, canonicalRoot: binding.canonicalRoot, device: binding.device, inode: binding.inode,
})).digest('hex');

/** The observation and candidate both come from the identity owner's one locked capture. */
export function planSourceRepair(registration: ReadableInstallationRegistration, identity: RegisteredInstallationBinding, observed: InstallationSource,
  fits: (candidate: ReadableInstallationRegistration) => boolean) {
  const { location: old, ...source } = registration.source, { location, ...fresh } = observed;
  const { binding, capture, candidate, outcome } = identity;
  if (!binding || !isDeepStrictEqual(source, fresh) || identity.identity.installationId !== source.installationId
    || !decimalDevice.test(location.device)) return null;

  const retained = registration.schemaVersion === 3 ? registration.lineage : undefined;
  const from = bindingKey(binding), ahead = retained?.fromBinding === from && retained.toBinding !== from;
  const live = retained?.toBinding === from || ahead ? retained : undefined;
  const devices = new Set([...(live ? [live.headDevice, ...live.pastDevices] : []), binding.device]);
  const samePlace = old.canonicalRoot === binding.canonicalRoot && old.inode === binding.inode;
  const filesystemIdentity = capture.filesystemIdentity ?? null;
  const deviceOnly = outcome === 'relocated' && classifyInstallationRebinding(binding, capture) === 'device-only';
  // H-back leaves the same legacy location tuple with L2 evidence and a settled lineage.
  const sameLegacyLocation = samePlace && old.device === binding.device && (!('filesystemIdentity' in old)
    || (retained?.fromBinding === from && retained.toBinding === from && retained.headDevice === old.device
      && isDeepStrictEqual(retained.filesystemIdentity, old.filesystemIdentity)
      && assessAttachmentLocation(old, { ...location, filesystemIdentity })));

  let repair: 'H-back' | 'H-fwd' | 'S1' | 'S2';
  if (ahead && outcome === 'match') repair = 'H-back';
  else if (ahead && deviceOnly && samePlace) repair = 'H-fwd';
  else if (deviceOnly && sameLegacyLocation) repair = 'S1';
  else if (binding.schemaVersion === 3 && outcome === 'match' && samePlace && !('filesystemIdentity' in old)
    && !assessAttachmentLocation(old, { ...location, filesystemIdentity }) && devices.has(old.device)) repair = 'S2';
  else return null;

  const changeBinding = repair === 'H-fwd' || repair === 'S1', referenced = new Set(registration.entries.map(entry => entry.attachment.location.device));
  const pastDevices = [...devices].filter(device => device !== location.device && decimalDevice.test(device) && referenced.has(device));
  const base = { ...registration, schemaVersion: 3 as const, lineage: {
    headIntentId: randomUUID(), headAtMs: Date.now(), fromBinding: from, toBinding: changeBinding ? bindingKey(candidate) : from,
    headDevice: location.device, filesystemIdentity, pastDevices,
  } };
  const withLocation = (next: ReadableInstallationRegistration['source']['location']) =>
    readableInstallationRegistrationSchema.parse({ ...base, source: { ...observed, location: next } });
  let next = withLocation(location);
  if (filesystemIdentity) {
    const stronger = withLocation({ ...location, filesystemIdentity });
    if (fits(stronger)) next = stronger;
  }
  return { repair, next, kind: changeBinding ? 'device-only' as const : 'registration-only' as const };
}
