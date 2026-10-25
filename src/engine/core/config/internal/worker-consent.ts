import { isAiPrincipal } from '#domain/index.js';
import { ErrorRegistry, type DeckentConfig } from '#platform/index.js';
import type { ConfigWriteInput } from './contract.js';
/** Consent stays in the existing config transaction: immutable records, person witness and the same policy/approval/CAS/audit owner. */
export async function assertWorkerConsentChange(input: ConfigWriteInput, before: DeckentConfig, after: DeckentConfig,
  witness: ((operation: string) => Promise<void>) | undefined) {
  const previous = before.toolchains.image, next = after.toolchains.image;
  if (JSON.stringify(previous.providers) !== JSON.stringify(next.providers)) throw ErrorRegistry.createError('WORKER_IMAGE_PROVIDERS_READ_ONLY');
  if (JSON.stringify(previous.consents) === JSON.stringify(next.consents)) return;
  if (isAiPrincipal(input.principal) || input.principal.assurance !== 'os-user') throw ErrorRegistry.createError('TOOLCHAIN_UPDATE_TERMINAL_ONLY');
  if (!witness) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: 'workerImage' } });
  await witness('workerImage');
  const added = next.consents.slice(previous.consents.length);
  if (added.length !== 1 || JSON.stringify(next.consents.slice(0, previous.consents.length)) !== JSON.stringify(previous.consents)) throw ErrorRegistry.createError('WORKER_IMAGE_CONSENT_INVALID');
  const record = added[0]!;
  if (record.id !== input.commandId || record.scopeId !== input.scopeId || record.person.id !== input.principal.id
    || record.person.issuer !== input.principal.issuer || record.person.subject !== input.principal.subject
    || previous.consents.some(consent => consent.id === record.id)) throw ErrorRegistry.createError('WORKER_IMAGE_CONSENT_INVALID');
}
