import { attestLocalInteractiveTerminal, localPrincipalChannel, localPrincipalPeer, readLocalOsIdentity } from '#adapters/index.js';
import { assertAuthorityWitness, type AuthorityWitness, type InstallerPermissionModesResult } from '#engine/index.js';
import type { OpenablePermissionMode } from '#domain/index.js';
import { ErrorRegistry, type ConfigLoadOptions } from '#platform/index.js';
import { openPermissionModesInstallation } from './policy-template.js';

/** CLI host only: preview → explicit confirmation → PRE-9 conditional writer. No runtime/MCP wire operation. */
export async function openOwnPermissionMode(root: string, input: { readonly scopeId: string; readonly mode: OpenablePermissionMode;
  readonly confirm: (preview: InstallerPermissionModesResult) => Promise<boolean>; readonly signal?: AbortSignal;
  /** A carrier binds its preview to the raw grant revision and consumes the owner's exact opened receipt. */
  readonly expect?: string; readonly onOpened?: (receipt: InstallerPermissionModesResult) => void }, options: ConfigLoadOptions = {},
  callerUid: number | undefined = process.getuid?.(), witness: AuthorityWitness = { attest: () => {
    const peer = localPrincipalPeer(); return attestLocalInteractiveTerminal(peer?.pid, peer?.uid);
  } }): Promise<boolean> {
  await assertAuthorityWitness('policyPermissionModes', localPrincipalChannel(), witness);
  const refuse = (result: InstallerPermissionModesResult): never => {
    throw ErrorRegistry.createError(result.status === 'conflict' ? 'PERMISSION_MODE_CONFLICT' : 'PERMISSION_MODE_DENIED',
      { params: { mode: input.mode, scope: input.scopeId, hint: 'modeOwner' } });
  };
  if (input.signal?.aborted) return false;
  // PRE-9 takes a wanted set. Keep every already managed mode, so opening one never closes the other.
  const identity = readLocalOsIdentity(), person = { issuer: identity.issuer, subject: identity.subject };
  const held = await openPermissionModesInstallation(root, input.scopeId, { modes: [], apply: false, person }, options, callerUid, witness);
  if (input.expect !== undefined && held.revision !== input.expect) throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
  if (!held.revision || !['preview', 'current'].includes(held.status)) return refuse(held);
  const modes = [...new Set([...held.modes.filter(mode => mode.managed === 'removed').map(mode => mode.mode), input.mode])];
  const preview = await openPermissionModesInstallation(root, input.scopeId, { modes, apply: false, person, expect: held.revision }, options, callerUid, witness);
  if (preview.status === 'current') { input.onOpened?.(preview); return true; }
  if (preview.status !== 'preview' || !preview.revision) return refuse(preview);
  if (input.signal?.aborted || !await input.confirm(preview) || input.signal?.aborted) return false;
  const result = await openPermissionModesInstallation(root, input.scopeId, { modes, apply: true, person, expect: preview.revision }, options, callerUid, witness);
  if (result.status !== 'applied' && result.status !== 'current') return refuse(result);
  input.onOpened?.(result);
  return true;
}
