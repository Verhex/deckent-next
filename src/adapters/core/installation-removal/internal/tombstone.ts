import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { generateEd25519Pair, ed25519Signer, signatureMessage, verifyEd25519, sha256, ErrorRegistry, writeTextAtomic, uninstallHoldPath } from '#platform/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import type { UninstallPlan, UninstallResult } from '#engine/index.js';
import { uninstallRecoveryDirectory } from './inventory.js';
const PRIVATE_PERMISSION_MASK = 0o077;
const fail = (): never => { throw ErrorRegistry.createError('UNINSTALL_RECOVERY_INVALID'); };
/** External OS-private recovery custody is the trust anchor after the installation's HMAC key is purged.
 * This key signs only a terminal tombstone; it grants no product authority and its private bytes never reach disk. */
export async function writeUninstallTombstone(root: string, actor: VerifiedPrincipal, plan: UninstallPlan, result: UninstallResult) {
  if (!plan.purge || !['completed', 'noop'].includes(result.status)) return;
  const directory = uninstallRecoveryDirectory(root), pair = generateEd25519Pair(), signer = ed25519Signer(pair.pkcs8); pair.pkcs8.fill(0);
  const body = { schemaVersion: 1, root, actor: { issuer: actor.issuer, subject: actor.subject }, plan, result };
  const encoded = JSON.stringify({ body, publicKey: signer.spki.toString('base64'), signature: signer.sign(signatureMessage('uninstall-tombstone:1', JSON.stringify(body))).toString('base64') });
  const file = await open(join(directory, `${plan.planDigest}.tombstone.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
  const pointer = join(directory, 'tombstone.json'), previous = await lstat(pointer).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous && (!previous.isFile() || previous.nlink !== 1 || previous.uid !== process.getuid?.() || previous.mode & PRIVATE_PERMISSION_MASK)) fail();
  await writeTextAtomic(pointer, encoded);
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); }
}
export async function readUninstallTombstone(root: string, actor: VerifiedPrincipal, maxBytes: number, identityPath?: string): Promise<{ plan: UninstallPlan; result: UninstallResult } | null> {
  if (await lstat(uninstallHoldPath(root)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return null;
  if (identityPath && await lstat(identityPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return null;
  const directory = uninstallRecoveryDirectory(root), info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || await realpath(directory) !== directory) fail();
  const file = await open(join(directory, 'tombstone.json'), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || info.size > maxBytes) fail();
    const bytes = Buffer.alloc(info.size + 1), read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== info.size) fail();
    const sealed = JSON.parse(bytes.subarray(0, read.bytesRead).toString()) as { body: { schemaVersion: number; root: string; actor: unknown; plan: UninstallPlan; result: UninstallResult }; publicKey: string; signature: string };
    const { body } = sealed, { planDigest, ...original } = body.plan;
    if (!verifyEd25519(Buffer.from(sealed.publicKey, 'base64'), signatureMessage('uninstall-tombstone:1', JSON.stringify(body)), Buffer.from(sealed.signature, 'base64'))
      || body.schemaVersion !== 1 || body.root !== root || JSON.stringify(body.actor) !== JSON.stringify({ issuer: actor.issuer, subject: actor.subject })
      || body.plan.installation.root !== root || sha256(JSON.stringify(original)) !== planDigest || body.result.planDigest !== planDigest
      || !body.plan.purge || !['completed', 'noop'].includes(body.result.status)) fail();
    return { plan: body.plan, result: body.result };
  } finally { await file.close(); }
}
/** A completed purge is a read-only absent inventory, never a second destructive authorization. */
export function completedUninstallPreview(plan: UninstallPlan): UninstallPlan {
  const { planDigest: _digest, ...body } = plan; void _digest;
  const absent = { ...body, items: body.items.map(item => item.action === 'remove' ? { ...item, action: 'keep' as const, reason: 'absent', present: false, version: null } : item), blockers: [], canApply: false as const };
  return { ...absent, planDigest: sha256(JSON.stringify(absent)) };
}
