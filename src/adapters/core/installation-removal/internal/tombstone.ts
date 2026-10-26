import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { generateEd25519Pair, ed25519Signer, signatureMessage, verifyEd25519, sha256, ErrorRegistry, writeTextAtomic, uninstallHoldPath, productResourcePath, type ResolvedConfig } from '#platform/index.js';
import { policyNamedScopes, resolvePolicyBindings, type VerifiedPrincipal } from '#domain/index.js';
import { authorizeUninstall, type UninstallPlan, type UninstallResult } from '#engine/index.js';
import { verifyBackupSet } from '#adapters/core/backup-store/index.js';
import { acquireLedgerLock } from '#adapters/core/local-runtime-socket/index.js';
import { uninstallRecoveryDirectory } from './inventory.js';
import { fileDigest, memberStat, type DataRemovalSnapshot } from './data.js';
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
  // `scopes`: every affected scope decided under custody, so a resumed tail decides the same set even after the ledger is gone.
  await writeTextAtomic(join(directory, 'final-tail.json'), seal(INTENT, { schemaVersion: 1, root, actor: { issuer: actor.issuer, subject: actor.subject }, scopes: actor.scopeIds, plan, snapshot, result }));
}
type Intent = { schemaVersion: number; root: string; actor: unknown; scopes?: readonly string[]; plan: UninstallPlan; snapshot: DataRemovalSnapshot; result: UninstallResult };
type Member = DataRemovalSnapshot['members'][number];
/** Bound means the exact verified file: same inode identity, private single-link regular file and same bytes. A file recreated with the
 * same bytes, moved, linked or changed is not this purge's member. */
async function memberState(member: Member): Promise<'absent' | 'bound' | 'changed'> {
  let info;
  try { info = await memberStat(member.path); } catch { return 'changed'; }
  if (!info) return 'absent';
  return info.dev === member.dev && info.ino === member.ino && info.size === member.size && info.mtimeMs === member.mtimeMs && info.ctimeMs === member.ctimeMs
    && await fileDigest(member.path) === member.digest ? 'bound' : 'changed';
}
async function heldIntent(root: string, actor: VerifiedPrincipal, maxBytes: number): Promise<Intent | null | undefined> {
  const hold = uninstallHoldPath(root), holdBytes = await readFile(hold, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (holdBytes === null) return undefined;
  let held: unknown; try { held = (JSON.parse(holdBytes) as { body?: { planDigest?: unknown } }).body?.planDigest; } catch { return null; }
  const intent = await unseal<Intent>(root, actor, 'final-tail.json', INTENT, maxBytes);
  return intent && held === intent.plan.planDigest && intent.result.planDigest === intent.plan.planDigest ? intent : null;
}
const tailUnknown = (root: string, intent: Intent) => ErrorRegistry.createError('UNINSTALL_FINAL_TAIL_UNKNOWN', { params: { path: uninstallRecoveryDirectory(root), backup: intent.snapshot.set } });
/**
 * A held purge whose final tail began is reconciled from the durable intent and a fresh observation, never by deleting here:
 * every bound member unchanged → null (the tail never started; the normal resumable path owns it); every member absent → the
 * evidenced terminal outcome (`settle` writes the tombstone and releases the hold); only absent and still-bound members → the
 * still-bound `remaining` members a second card may resume; anything changed stays held as unknown.
 */
async function reconcileFinalTail(root: string, actor: VerifiedPrincipal, maxBytes: number, settle: boolean) {
  const intent = await heldIntent(root, actor, maxBytes);
  if (!intent) return intent;
  const states = await Promise.all(intent.snapshot.members.map(memberState));
  if (states.every(state => state === 'bound')) return null;
  if (states.includes('changed')) throw tailUnknown(root, intent);
  const remaining = intent.snapshot.members.filter((_, index) => states[index] === 'bound');
  if (settle && !remaining.length) {
    const directory = uninstallRecoveryDirectory(root), saved = join(directory, `${intent.plan.planDigest}.tombstone.json`);
    if (await exists(saved)) await publishPointer(directory, await readFile(saved, 'utf8')); else await writeUninstallTombstone(root, actor, intent.plan, intent.result);
    await unlink(uninstallHoldPath(root)); await syncDirectory(root);
  }
  return { plan: intent.plan, result: intent.result, ...(remaining.length ? { remaining } : {}), intent };
}
/**
 * The second card's continuation of an interrupted final tail: only the still-bound members of the exact old operation, and only after
 * the delete authority is decided again from authenticated sources (the bound file or the verified final set's copy of policy/bindings,
 * whose bytes match the snapshot) for every affected scope, the final set verifies with the person's passphrase and its manifest is the
 * snapshot's. Any doubt throws before the first unlink and the hold stays. Runs under the installation's ledger custody.
 */
export async function resumeUninstallFinalTail(config: ResolvedConfig, actor: VerifiedPrincipal, passphrase: string): Promise<UninstallResult> {
  const layout = config.productLayout, root = layout.root, maxBytes = config.installation.profileMaxBytes;
  if (!passphrase) throw ErrorRegistry.createError('BACKUP_PASSPHRASE_REQUIRED');
  const lock = (() => { try { return acquireLedgerLock(`${productResourcePath(layout, 'ledger')}-lock`); }
    catch (error) { if ((error as { code?: string }).code === 'LOCAL_RUNTIME_ALREADY_RUNNING') throw ErrorRegistry.createError('UNINSTALL_WORK_ACTIVE'); throw error; } })();
  try {
    const held = await reconcileFinalTail(root, actor, maxBytes, false);
    if (!held?.remaining) throw ErrorRegistry.createError('UNINSTALL_PLAN_CHANGED');
    const { intent, remaining } = held;
    if (!intent.scopes) throw tailUnknown(root, intent); // a pre-scope intent cannot have its delete authority decided again
    const verified = await verifyBackupSet(intent.snapshot.set, passphrase, config.installation.packageMeasurement);
    try {
      if (verified.state.installationId !== intent.plan.installation.id
        || createHash('sha256').update(await readFile(join(verified.set, 'MANIFEST.sha256'))).digest('hex') !== intent.snapshot.manifestDigest) throw tailUnknown(root, intent);
      const authority = async (resource: 'policy' | 'bindings') => {
        const path = productResourcePath(layout, resource), member = intent.snapshot.members.find(item => item.path === path);
        if (!member) return null;
        const bytes = remaining.includes(member) ? await readFile(path) : Buffer.from(verified.state.entries.find(entry => entry.resource === resource && entry.path === '')?.content ?? '', 'base64');
        if (createHash('sha256').update(bytes).digest('hex') !== member.digest) throw tailUnknown(root, intent);
        return JSON.parse(bytes.toString('utf8')) as unknown;
      };
      const policy = await authority('policy');
      if (!policy) throw tailUnknown(root, intent);
      const document = resolvePolicyBindings(policy, await authority('bindings'));
      const scopes = [...new Set([...intent.scopes, ...intent.plan.scopeSummary, ...policyNamedScopes(document)])];
      for (const action of ['uninstall', 'purge'] as const) authorizeUninstall(document, { ...actor, scopeIds: scopes }, intent.plan.installation.id, scopes, action);
    } finally { verified.close(); }
    for (const member of remaining) if (await memberState(member) !== 'bound') throw tailUnknown(root, intent);
    for (const member of remaining) await unlink(member.path);
    for (const directory of new Set(intent.snapshot.members.flatMap(member => member.directory ? [member.directory] : [])))
      await rmdir(directory).catch(error => { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; });
    const settled = await reconcileFinalTail(root, actor, maxBytes, true);
    if (!settled || settled.remaining) throw tailUnknown(root, intent);
    return settled.result;
  } finally { lock.release(); }
}
/** A managed restore of exactly the final set a held purge's intent names ends that purge once the restore succeeded: the intent is kept
 * as sealed evidence under another name (never an admission again) and the hold is released. Any other set or actor leaves the hold. */
export async function uninstallRestoreRelease(root: string, actor: VerifiedPrincipal, maxBytes: number, set: string) {
  const intent = await heldIntent(root, actor, maxBytes).catch(() => null);
  if (!intent || resolve(intent.snapshot.set) !== resolve(set)) return null;
  return async () => {
    const directory = uninstallRecoveryDirectory(root);
    await rename(join(directory, 'final-tail.json'), join(directory, `${intent.plan.planDigest}.restored.json`)); await syncDirectory(directory);
    await unlink(uninstallHoldPath(root)); await syncDirectory(root);
  };
}
export async function readUninstallTombstone(root: string, actor: VerifiedPrincipal, maxBytes: number, identityPath?: string, settle = false): Promise<{ plan: UninstallPlan; result: UninstallResult; remaining?: readonly string[] } | null> {
  const reconciled = await reconcileFinalTail(root, actor, maxBytes, settle);
  if (reconciled !== undefined) return reconciled && { plan: reconciled.plan, result: reconciled.result, ...(reconciled.remaining ? { remaining: reconciled.remaining.map(member => member.path) } : {}) };
  // A reinstall's new identity record (not its directory, which may hold an unlisted kept file) supersedes an old tombstone.
  if (identityPath && await exists(join(identityPath, 'identity.json'))) return null;
  const body = await unseal<{ schemaVersion: number; root: string; actor: unknown; plan: UninstallPlan; result: UninstallResult }>(root, actor, 'tombstone.json', TOMBSTONE, maxBytes);
  if (!body) return null;
  if (body.result.planDigest !== body.plan.planDigest || !['completed', 'noop'].includes(body.result.status)) fail();
  return { plan: body.plan, result: body.result };
}
/** A completed purge is a read-only absent inventory, never a second destructive authorization. An interrupted one's `remaining`
 * still-bound members are the second card: exactly those paths, nothing the first card did not list. */
export function completedUninstallPreview(plan: UninstallPlan, remaining?: readonly string[]): UninstallPlan {
  const { planDigest: _digest, ...body } = plan; void _digest;
  const items = body.items.map(item => remaining && item.action === 'remove' && item.members?.some(path => remaining.includes(path))
    ? { ...item, members: item.members.filter(path => remaining.includes(path)), reason: 'resume' }
    : item.action === 'remove' ? { ...item, action: 'keep' as const, reason: 'absent', present: false, version: null } : item);
  const absent = { ...body, items, blockers: [], canApply: false as const };
  return { ...absent, planDigest: sha256(JSON.stringify(absent)) };
}
