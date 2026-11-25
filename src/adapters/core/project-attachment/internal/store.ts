import { constants } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath, open } from 'node:fs/promises';
import { dirname, resolve, parse, join, relative, sep } from 'node:path';
import { ATTACHMENT_REGISTRATION_VERSION, installationRegistrationSchema, readableInstallationRegistrationSchema, readableProjectAttachmentSchema, attachmentRegistrationAllowance,
  normalizeAttachmentRegistration, isNewAttachmentRegistration, isNewAttachment, isNewerAttachmentVersion, attachmentRevocationRecord, isAttachmentRevocationDiff,
  type ReadableInstallationRegistration as InstallationRegistration, type ReadableProjectAttachment as ProjectAttachment, type AttachmentLocation, type AttachmentRevocation } from '#domain/index.js';
import { attachmentFailure } from '#engine/index.js';
import { readInstallationFile, readInstallationFileBytes, InstallationFileError, inspectFilesystemIdentity } from '#adapters/core/installation-files/index.js';
import { ErrorRegistry, inspectProductFile, prepareProductFile, prepareProductCompanionPath, productResourcePath, resolveGlobalConfigPaths, resolveProductLayout,
  serializeJsonDocument, withConfigWriteLock, writeJsonAtomic, writeTextAtomic, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
const heldRegistries = new AsyncLocalStorage<ReadonlySet<string>>();
/** No-follow ancestry, local owner and location evidence; reads create neither locks nor directories. */
async function inspectAttachmentDirectory(root: string) {
  if (process.platform === 'win32' || !process.getuid) return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== resolve(root)) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_DENIED', { params: { reason: 'location', path: resolve(root) } });
  if (canonicalRoot === parse(canonicalRoot).root) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  let cursor = parse(canonicalRoot).root;
  for (const segment of relative(cursor, canonicalRoot).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment); const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_DENIED', { params: { reason: 'location', path: canonicalRoot } });
  }
  return { canonicalRoot, info: await lstat(canonicalRoot, { bigint: true }) };
}
export async function captureAttachmentLocation(root: string): Promise<AttachmentLocation> {
  const { canonicalRoot, info } = await inspectAttachmentDirectory(root);
  if (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o022n) !== 0n || info.ino === 0n) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_DENIED', { params: {
    reason: info.uid === BigInt(process.getuid!()) && info.ino !== 0n && (info.mode & 0o022n) !== 0n ? 'location-write' : 'location', path: canonicalRoot } });
  const current = await lstat(canonicalRoot, { bigint: true });
  if (current.dev !== info.dev || current.ino !== info.ino || current.uid !== info.uid || current.gid !== info.gid || current.mode !== info.mode) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  return { canonicalRoot, device: String(info.dev), inode: String(info.ino) };
}
/** Read-only filesystem evidence for L2 assessment and target recovery. */
export async function observeAttachmentFilesystemIdentity(location: AttachmentLocation) {
  const observed = await inspectFilesystemIdentity(location.canonicalRoot, { device: location.device, inode: location.inode });
  return observed.status === 'available' ? observed.identity : null;
}
/** A person's explicit answer changes only the pinned directory; a replaced path or lost witness refuses before chmod. */
export async function prepareAttachmentDirectory(root: string, authorize: () => Promise<void>, confirm?: (path: string) => Promise<boolean>): Promise<AttachmentLocation> {
  try { return await captureAttachmentLocation(root); }
  catch (error) {
    if (!confirm || !(error instanceof Error) || !('params' in error) || (error.params as { reason?: string }).reason !== 'location-write') throw error;
    try { await authorize(); } catch { throw error; }
    const { canonicalRoot, info } = await inspectAttachmentDirectory(root);
    if (info.uid !== BigInt(process.getuid!()) || info.ino === 0n || (info.mode & 0o022n) === 0n) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    const same = (next: typeof info) => next.dev === info.dev && next.ino === info.ino && next.uid === info.uid && next.gid === info.gid && next.mode === info.mode;
    const handle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!same(await handle.stat({ bigint: true }))) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      if (!await confirm(canonicalRoot)) throw error;
      await authorize();
      const current = await inspectAttachmentDirectory(root);
      if (current.canonicalRoot !== canonicalRoot || !same(current.info) || !same(await handle.stat({ bigint: true }))) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      const mode = Number(info.mode & 0o7777n) & ~0o022;
      await handle.chmod(mode);
      if ((await handle.stat({ bigint: true })).mode !== (info.mode & ~0o022n)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      await authorize();
      const location = await captureAttachmentLocation(root);
      if (location.device !== String(info.dev) || location.inode !== String(info.ino)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
      return location;
    } finally { await handle.close(); }
  }
}
export class FileProjectAttachmentStore {
  private readonly registrationBytes = new WeakMap<InstallationRegistration, Buffer>();
  private readonly attachmentBytes = new WeakMap<ProjectAttachment, Buffer>();
  constructor(readonly layout: ProductLayout, readonly options: ConfigLoadOptions, readonly maxBytes: number, readonly timeoutMs: number) {}
  get global(): ProductLayout {
    const options = this.options, config = resolveGlobalConfigPaths(options.env, options.platform).platformPath;
    return resolveProductLayout({ projectRoot: dirname(config), root: dirname(config), bootstrapConfigPath: config });
  }
  private async readBytes(layout: ProductLayout, resource: 'installationRegistration' | 'projectAttachment') {
    const path = productResourcePath(layout, resource);
    return readInstallationFileBytes({ root: resource === 'projectAttachment' ? dirname(path) : layout.root, path,
      maxBytes: resource === 'installationRegistration' ? this.readCap : this.maxBytes });
  }
  private async read(layout: ProductLayout, resource: 'installationRegistration' | 'projectAttachment') {
    return (await this.readBytes(layout, resource))?.toString('utf8') ?? null;
  }
  private get readCap() { return Math.min(Number.MAX_SAFE_INTEGER, this.maxBytes + attachmentRegistrationAllowance(this.maxBytes)); }
  private sizeFailure(layout: ProductLayout, resource: 'installationRegistration') : never {
    throw new InstallationFileError('INSTALLATION_FILE_UNSAFE', { path: productResourcePath(layout, resource), reason: 'size' });
  }
  async registration(): Promise<InstallationRegistration | null> {
    if (process.platform === 'win32' || this.layout.platform === 'win32') return attachmentFailure('PROJECT_ATTACHMENT_UNAVAILABLE');
    const bytes = await this.readBytes(this.global, 'installationRegistration');
    if (bytes === null) return null;
    let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { return attachmentFailure('PROJECT_ATTACHMENT_INVALID'); }
    if (isNewerAttachmentVersion(value, ATTACHMENT_REGISTRATION_VERSION)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
    const parsed = readableInstallationRegistrationSchema.safeParse(value);
    if (parsed.success && parsed.data.schemaVersion !== ATTACHMENT_REGISTRATION_VERSION && bytes.length > this.maxBytes) {
      await readInstallationFile({ root: this.global.root, path: productResourcePath(this.global, 'installationRegistration'), maxBytes: this.maxBytes });
      return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    }
    if (parsed.success && parsed.data.schemaVersion === ATTACHMENT_REGISTRATION_VERSION
      && Buffer.byteLength(serializeJsonDocument(normalizeAttachmentRegistration(parsed.data))) > this.maxBytes) return this.sizeFailure(this.global, 'installationRegistration');
    if (parsed.success) this.registrationBytes.set(parsed.data, bytes);
    return parsed.success ? parsed.data : attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  }
  async attachment(): Promise<ProjectAttachment | null> {
    if (process.platform === 'win32' || this.layout.platform === 'win32') return null;
    const present = await lstat(productResourcePath(this.layout, 'projectAttachment')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!present) return null;
    const bytes = await this.readBytes(this.layout, 'projectAttachment');
    if (bytes === null) return null;
    let value: unknown; try { value = JSON.parse(bytes.toString('utf8')); } catch { return attachmentFailure('PROJECT_ATTACHMENT_INVALID'); }
    if (isNewerAttachmentVersion(value, 2)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
    const parsed = readableProjectAttachmentSchema.safeParse(value);
    if (parsed.success) this.attachmentBytes.set(parsed.data, bytes);
    return parsed.success ? parsed.data : attachmentFailure('PROJECT_ATTACHMENT_INVALID');
  }
  /** Caller holds this one lock across inventory reservation, the local installer journal and settlement. */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    const key = productResourcePath(this.global, 'installationRegistration'), held = heldRegistries.getStore();
    if (held?.has(key)) return work();
    await prepareProductCompanionPath(this.global, 'installationRegistration', '-lock');
    return withConfigWriteLock(key, () => heldRegistries.run(new Set([...(held ?? []), key]), work), this.timeoutMs);
  }
  async write(expected: InstallationRegistration | null, next: InstallationRegistration): Promise<void> {
    const current = await this.registration();
    if (isNewerAttachmentVersion(next, ATTACHMENT_REGISTRATION_VERSION) || isNewerAttachmentVersion(expected, ATTACHMENT_REGISTRATION_VERSION) || isNewAttachmentRegistration(current) || isNewAttachmentRegistration(expected) || isNewAttachmentRegistration(next) || isNewAttachment(await this.attachment())) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
    if (JSON.stringify(current) !== JSON.stringify(expected)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    const value = installationRegistrationSchema.parse(next);
    if (Buffer.byteLength(serializeJsonDocument(value)) > this.maxBytes) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    const path = await prepareProductFile(this.global, 'installationRegistration');
    await writeJsonAtomic(path, value);
    await inspectProductFile(this.global, 'installationRegistration');
  }
  fitsJoined(value: InstallationRegistration): boolean {
    return Buffer.byteLength(serializeJsonDocument(value)) <= this.readCap
      && Buffer.byteLength(serializeJsonDocument(normalizeAttachmentRegistration(value))) <= this.maxBytes;
  }
  private async checkRegistration(expected: InstallationRegistration) {
    const path = productResourcePath(this.global, 'installationRegistration');
    if (!heldRegistries.getStore()?.has(path)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    const before = this.registrationBytes.get(expected);
    if (before === undefined || !(await this.readBytes(this.global, 'installationRegistration'))?.equals(before))
      return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  }
  async checkTarget(registration: InstallationRegistration, attachment: ProjectAttachment) {
    await this.checkRegistration(registration);
    await this.checkLocalBytes(this.attachmentBytes.get(attachment));
  }
  private async checkLocalBytes(expected: Buffer | undefined) {
    if (!expected || !(await this.readBytes(this.layout, 'projectAttachment'))?.equals(expected))
      return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
  }
  fitsTarget(reference: ProjectAttachment, registration: InstallationRegistration) {
    return Buffer.byteLength(serializeJsonDocument(reference)) <= this.maxBytes && this.fitsJoined(registration);
  }
  async writeTarget(expected: InstallationRegistration, local: ProjectAttachment, reference: ProjectAttachment, next: InstallationRegistration | null) {
    const bytes = Buffer.from(serializeJsonDocument(reference));
    if (!this.fitsTarget(reference, next ?? expected)) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    const check = () => this.checkTarget(expected, local);
    await check();
    if (!bytes.equals(this.attachmentBytes.get(local)!)) {
      const path = await prepareProductFile(this.layout, 'projectAttachment');
      await writeTextAtomic(path, bytes, check);
    }
    const checkWritten = () => this.checkLocalBytes(bytes);
    await checkWritten();
    if (next) await this.writeJoined(expected, next, checkWritten);
    await checkWritten();
  }
  /** Used by custody holders that publish a canonical registration v3 record. */
  async writeJoined(expected: InstallationRegistration, next: InstallationRegistration, checkPublishedLocal?: () => Promise<void>): Promise<void> {
    const check = async () => {
      await checkPublishedLocal?.();
      await this.checkRegistration(expected);
    };
    await check();
    const value = readableInstallationRegistrationSchema.parse(next);
    if (value.schemaVersion !== ATTACHMENT_REGISTRATION_VERSION) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    const bytes = Buffer.from(serializeJsonDocument(value));
    if (!this.fitsJoined(value)) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    await writeTextAtomic(await prepareProductFile(this.global, 'installationRegistration'), bytes, check);
    if (!(await this.readBytes(this.global, 'installationRegistration'))?.equals(bytes)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    this.registrationBytes.set(next, bytes);
  }
  async writeRevocation(expected: InstallationRegistration, change: AttachmentRevocation): Promise<void> {
    const path = productResourcePath(this.global, 'installationRegistration');
    if (!heldRegistries.getStore()?.has(path)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    const current = await this.registration();
    if (JSON.stringify(current) !== JSON.stringify(expected)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    if (!current || current.schemaVersion !== ATTACHMENT_REGISTRATION_VERSION) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    const text = await this.read(this.global, 'installationRegistration');
    const raw = JSON.parse(text!) as InstallationRegistration;
    if (isNewerAttachmentVersion(raw, ATTACHMENT_REGISTRATION_VERSION)) return attachmentFailure('PROJECT_ATTACHMENT_NEWER_RECORD');
    const parsed = readableInstallationRegistrationSchema.safeParse(raw);
    if (!parsed.success) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    if (JSON.stringify(parsed.data) !== JSON.stringify(expected)) return attachmentFailure('PROJECT_ATTACHMENT_CHANGED');
    const next = attachmentRevocationRecord(raw, change);
    if (!readableInstallationRegistrationSchema.safeParse(next).success || !isAttachmentRevocationDiff(raw, next, change)) return attachmentFailure('PROJECT_ATTACHMENT_DENIED');
    const content = serializeJsonDocument(next);
    if (Buffer.byteLength(content) > this.readCap) return attachmentFailure('PROJECT_ATTACHMENT_INVALID');
    await writeTextAtomic(await prepareProductFile(this.global, 'installationRegistration'), content);
    await inspectProductFile(this.global, 'installationRegistration');
  }
}
