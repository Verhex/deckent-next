import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { generateEd25519Pair, ed25519Signer, signatureMessage, verifyEd25519, sha256, ErrorRegistry, writeTextAtomic, uninstallHoldPath } from '#platform/index.js';
import type { VerifiedPrincipal } from '#domain/index.js';
import type { UninstallPlan, UninstallResult } from '#engine/index.js';
import { uninstallRecoveryDirectory } from './inventory.js';
import { fileDigest, type DataRemovalSnapshot } from './data.js';
const PRIVATE_PERMISSION_MASK = 0o077;
const TOMBSTONE = 'uninstall-tombstone:1', INTENT = 'uninstall-final-tail:1';
const fail = (): never => { throw ErrorRegistry.createError('UNINSTALL_RECOVERY_INVALID'); };
const exists = (path: string) => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
/** External OS-private recovery custody is the trust anchor after the installation's HMAC key is purged.
 * An ephemeral key signs one record; it grants no product authority and its private bytes never reach disk. */
function seal(context: string, body: unknown) {
  const pair = generateEd25519Pair(), signer = ed25519Signer(pair.pkcs8); pair.pkcs8.fill(0);
  return JSON.stringify({ body, publicKey: signer.spki.toString('base64'), signature: signer.sign(signatureMessage(context, JSON.stringify(body))).toString('base64') });
}
async function syncDirectory(path: string) { const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); } }
/** A private recovery directory and one private sealed record in it; null when either is absent. */
async function unseal<T extends { schemaVersion: number; root: string; actor: unknown; plan: UninstallPlan }>(root: string, actor: VerifiedPrincipal, name: string, context: string, maxBytes: number): Promise<T | null> {
  const directory = uninstallRecoveryDirectory(root), info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return null;
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || await realpath(directory) !== directory) fail();
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & PRIVATE_PERMISSION_MASK || stat.size > maxBytes) fail();
    const bytes = Buffer.alloc(stat.size + 1), read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== stat.size) fail();
    const sealed = JSON.parse(bytes.subarray(0, read.bytesRead).toString()) as { body: T; publicKey: string; signature: string };
    const { body } = sealed, { planDigest, ...original } = body.plan;
    if (!verifyEd25519(Buffer.from(sealed.publicKey, 'base64'), signatureMessage(context, JSON.stringify(body)), Buffer.from(sealed.signature, 'base64'))
      || body.schemaVersion !== 1 || body.root !== root || JSON.stringify(body.actor) !== JSON.stringify({ issuer: actor.issuer, subject: actor.subject })
      || body.plan.installation.root !== root || sha256(JSON.stringify(original)) !== planDigest || !body.plan.purge) fail();
    return body;
  } finally { await file.close(); }
}
export async function writeUninstallTombstone(root: string, actor: VerifiedPrincipal, plan: UninstallPlan, result: UninstallResult) {
  if (!plan.purge || !['completed', 'noop'].includes(result.status)) return;
  const directory = uninstallRecoveryDirectory(root);
  const encoded = seal(TOMBSTONE, { schemaVersion: 1, root, actor: { issuer: actor.issuer, subject: actor.subject }, plan, result });
  const file = await open(join(directory, `${plan.planDigest}.tombstone.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
  await publishPointer(directory, encoded);
}
async function publishPointer(directory: string, encoded: string) {
  const pointer = join(directory, 'tombstone.json'), previous = await lstat(pointer).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (previous && (!previous.isFile() || previous.nlink !== 1 || previous.uid !== process.getuid?.() || previous.mode & PRIVATE_PERMISSION_MASK)) fail();
  await writeTextAtomic(pointer, encoded); await syncDirectory(directory);
}
/** Durable final-tail intent, written after the final backup is verified and bound and before the first member is deleted. It is the
 * only admission a later process needs once policy, identity and the HMAC key are gone; it authorizes reconciliation, never a deletion. */
export async function writeUninstallIntent(root: string, actor: VerifiedPrincipal, plan: UninstallPlan, snapshot: DataRemovalSnapshot) {
  const directory = uninstallRecoveryDirectory(root);
  const result: UninstallResult = { schemaVersion: 1, planDigest: plan.planDigest, status: 'completed',
    items: plan.items.map(item => ({ resourceId: item.resourceId, state: item.action === 'remove' ? 'settled' as const : null })),
    recoveryLocation: join(directory, plan.planDigest), backup: { ...plan.backup, destination: snapshot.set }, packageRemoval: plan.packageRemoval };
  await writeTextAtomic(join(directory, 'final-tail.json'), seal(INTENT, { schemaVersion: 1, root, actor: { issuer: actor.issuer, subject: actor.subject }, plan, snapshot, result }));
}
/**
 * A held purge whose final tail began is reconciled from the durable intent and a fresh observation, never by deleting again:
 * every bound member still unchanged → null (the tail never started; the normal resumable path owns it); every member absent →
 * the evidenced terminal outcome (`settle` writes the tombstone and releases the hold); anything else stays held as unknown.
 */
async function reconcileFinalTail(root: string, actor: VerifiedPrincipal, maxBytes: number, settle: boolean) {
  const hold = uninstallHoldPath(root), holdBytes = await readFile(hold, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (holdBytes === null) return undefined;
  let held: unknown; try { held = (JSON.parse(holdBytes) as { body?: { planDigest?: unknown } }).body?.planDigest; } catch { return null; }
  const intent = await unseal<{ schemaVersion: number; root: string; actor: unknown; plan: UninstallPlan; snapshot: DataRemovalSnapshot; result: UninstallResult }>(root, actor, 'final-tail.json', INTENT, maxBytes);
  if (!intent || held !== intent.plan.planDigest || intent.result.planDigest !== intent.plan.planDigest) return null;
  const states = await Promise.all(intent.snapshot.members.map(async member => !await exists(member.path) ? 'absent' : await fileDigest(member.path) === member.digest ? 'bound' : 'changed'));
  if (states.every(state => state === 'bound')) return null;
  const directory = uninstallRecoveryDirectory(root);
  if (!states.every(state => state === 'absent')) throw ErrorRegistry.createError('UNINSTALL_FINAL_TAIL_UNKNOWN', { params: { path: directory, backup: intent.snapshot.set } });
  if (settle) {
    const saved = join(directory, `${intent.plan.planDigest}.tombstone.json`);
    if (await exists(saved)) await publishPointer(directory, await readFile(saved, 'utf8')); else await writeUninstallTombstone(root, actor, intent.plan, intent.result);
    await unlink(hold); await syncDirectory(root);
  }
  return { plan: intent.plan, result: intent.result };
}
export async function readUninstallTombstone(root: string, actor: VerifiedPrincipal, maxBytes: number, identityPath?: string, settle = false): Promise<{ plan: UninstallPlan; result: UninstallResult } | null> {
  const reconciled = await reconcileFinalTail(root, actor, maxBytes, settle);
  if (reconciled !== undefined) return reconciled;
  // A reinstall's new identity record (not its directory, which may hold an unlisted kept file) supersedes an old tombstone.
  if (identityPath && await exists(join(identityPath, 'identity.json'))) return null;
  const body = await unseal<{ schemaVersion: number; root: string; actor: unknown; plan: UninstallPlan; result: UninstallResult }>(root, actor, 'tombstone.json', TOMBSTONE, maxBytes);
  if (!body) return null;
  if (body.result.planDigest !== body.plan.planDigest || !['completed', 'noop'].includes(body.result.status)) fail();
  return { plan: body.plan, result: body.result };
}
/** A completed purge is a read-only absent inventory, never a second destructive authorization. */
export function completedUninstallPreview(plan: UninstallPlan): UninstallPlan {
  const { planDigest: _digest, ...body } = plan; void _digest;
  const absent = { ...body, items: body.items.map(item => item.action === 'remove' ? { ...item, action: 'keep' as const, reason: 'absent', present: false, version: null } : item), blockers: [], canApply: false as const };
  return { ...absent, planDigest: sha256(JSON.stringify(absent)) };
}
