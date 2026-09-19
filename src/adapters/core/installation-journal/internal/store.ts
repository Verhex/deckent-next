import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { BootstrapStateError, DeckentError, encodeBootstrapJournal, observeBootstrapState, productResourcePath,
  resolveProductLayout, withConfigWriteLock, type BootstrapJournalPayload, type BootstrapObservation } from '#platform/index.js';

export type InstallationJournalErrorCode = 'INSTALLATION_JOURNAL_INVALID' | 'INSTALLATION_JOURNAL_UNSAFE'
  | 'INSTALLATION_JOURNAL_CONFLICT' | 'INSTALLATION_JOURNAL_UNAVAILABLE' | 'INSTALLATION_JOURNAL_BUSY'
  | 'INSTALLATION_JOURNAL_OUTCOME_UNKNOWN' | 'INSTALLATION_JOURNAL_EXPIRED' | 'INSTALLATION_JOURNAL_UNSUPPORTED';
export class InstallationJournalError extends Error {
  constructor(readonly code: InstallationJournalErrorCode) { super(code); this.name = 'InstallationJournalError'; }
}
class InstallationJournalCallbackFailure { constructor(readonly reason: unknown) {} }
export interface InstallationJournalOptions { readonly timeoutMs: number }
export interface InstallationJournalSession {
  observe(): Promise<BootstrapObservation>;
  /** Every started operation participates in the enclosing transaction result. Catching a
   * rejection inside the callback does not make that callback successful. */
  write(expected: BootstrapObservation, payload: BootstrapJournalPayload): Promise<BootstrapObservation>;
}

function unavailable(error: unknown): never {
  if (error instanceof InstallationJournalError) throw error;
  if (error instanceof DeckentError && error.code === 'CONFIG_WRITE_LOCKED') {
    throw new InstallationJournalError('INSTALLATION_JOURNAL_BUSY');
  }
  if (error instanceof BootstrapStateError) {
    const mapped = error.code === 'BOOTSTRAP_STATE_UNSAFE' ? 'INSTALLATION_JOURNAL_UNSAFE'
      : error.code === 'BOOTSTRAP_STATE_CHANGED' ? 'INSTALLATION_JOURNAL_CONFLICT'
      : error.code === 'BOOTSTRAP_STATE_UNSUPPORTED' ? 'INSTALLATION_JOURNAL_UNSUPPORTED'
      : error.code === 'BOOTSTRAP_STATE_INVALID' ? 'INSTALLATION_JOURNAL_INVALID' : 'INSTALLATION_JOURNAL_UNAVAILABLE';
    throw new InstallationJournalError(mapped);
  }
  throw new InstallationJournalError('INSTALLATION_JOURNAL_UNAVAILABLE');
}
function validateDirectory(stat: BigIntStats, uid: bigint) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022n) !== 0n) {
    throw new InstallationJournalError('INSTALLATION_JOURNAL_UNSAFE');
  }
}
async function privateDirectory(path: string, create: boolean, uid: bigint): Promise<void> {
  try { validateDirectory(await lstat(path, { bigint: true }), uid); return; }
  catch (error) {
    if (error instanceof InstallationJournalError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) unavailable(error);
  }
  let created = false;
  try { await mkdir(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') unavailable(error); }
  try { validateDirectory(await lstat(path, { bigint: true }), uid); }
  catch (error) { unavailable(error); }
  if (created) {
    try {
      const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) { unavailable(error); }
  }
}
async function preparePaths(projectRoot: string) {
  if (process.platform === 'win32' || !process.getuid) throw new InstallationJournalError('INSTALLATION_JOURNAL_UNSUPPORTED');
  if (typeof projectRoot !== 'string' || !projectRoot) throw new InstallationJournalError('INSTALLATION_JOURNAL_INVALID');
  const root = resolve(projectRoot), uid = BigInt(process.getuid());
  await privateDirectory(root, false, uid);
  try { if (await realpath(root) !== root) throw new InstallationJournalError('INSTALLATION_JOURNAL_UNSAFE'); }
  catch (error) { unavailable(error); }
  const layout = resolveProductLayout({ projectRoot: root, platform: 'posix' });
  const configPath = productResourcePath(layout, 'config'), journalPath = productResourcePath(layout, 'installationJournal');
  const bootstrap = dirname(configPath), installation = dirname(journalPath);
  await privateDirectory(bootstrap, true, uid);
  return { root, uid, configPath, journalPath, installation };
}
function sameGeneration(expected: string, observed: BootstrapObservation) {
  if (!expected || expected !== observed.generation) {
    throw new InstallationJournalError('INSTALLATION_JOURNAL_CONFLICT');
  }
}
async function removeOwnedTemporary(path: string, identity: BigIntStats | undefined) {
  if (!identity) return;
  try { const named = await lstat(path, { bigint: true });
    if (named.dev === identity.dev && named.ino === identity.ino) await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function withInstallationJournal<T>(projectRoot: string, options: InstallationJournalOptions,
  callback: (session: InstallationJournalSession) => Promise<T>): Promise<T> {
  if (!options || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || typeof callback !== 'function') {
    throw new InstallationJournalError('INSTALLATION_JOURNAL_INVALID');
  }
  const paths = await preparePaths(projectRoot); let active = false;
  try {
    return await withConfigWriteLock(paths.configPath, async () => {
      await privateDirectory(paths.installation, true, paths.uid); active = true;
      const assertActive = () => { if (!active) throw new InstallationJournalError('INSTALLATION_JOURNAL_EXPIRED'); };
      const started: Promise<unknown>[] = []; let writeTail: Promise<void> = Promise.resolve();
      const register = <R>(operation: Promise<R>): Promise<R> => {
        started.push(operation);
        // Observe immediately to prevent an unawaited rejection from reaching the process;
        // Promise.allSettled below still retains and poisons the enclosing transaction.
        void operation.catch(() => undefined);
        return operation;
      };
      const track = <R>(work: () => Promise<R>): Promise<R> => {
        try { assertActive(); } catch (error) { return Promise.reject(error); }
        return register(work());
      };
      const observe = async () => { try { return await observeBootstrapState(paths.root); } catch (error) { return unavailable(error); } };
      const write = async (expectedGeneration: string, encoded: string) => {
          const first = await observe(); sameGeneration(expectedGeneration, first);
          const temporary = `${paths.journalPath}.${randomUUID()}.tmp`; let handle; let identity: BigIntStats | undefined; let renamed = false;
          try {
            handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            identity = await handle.stat({ bigint: true });
            await handle.writeFile(encoded, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
            sameGeneration(expectedGeneration, await observe());
            await rename(temporary, paths.journalPath); renamed = true;
            const directory = await open(dirname(paths.journalPath), constants.O_RDONLY | constants.O_DIRECTORY);
            try { await directory.sync(); } finally { await directory.close(); }
            const result = await observe(); if (result.generation === expectedGeneration) throw new InstallationJournalError('INSTALLATION_JOURNAL_OUTCOME_UNKNOWN');
            return result;
          } catch (error) {
            if (error instanceof InstallationJournalError && error.code === 'INSTALLATION_JOURNAL_CONFLICT') throw error;
            if (renamed) throw new InstallationJournalError('INSTALLATION_JOURNAL_OUTCOME_UNKNOWN');
            return unavailable(error);
          } finally {
            await handle?.close().catch(() => undefined);
            if (!renamed) await removeOwnedTemporary(temporary, identity).catch(() => undefined);
          }
        };
      const session: InstallationJournalSession = Object.freeze({
        observe: () => track(observe),
        write: (expected: BootstrapObservation, payload: BootstrapJournalPayload) => {
          try { assertActive(); } catch (error) { return Promise.reject(error); }
          const expectedGeneration = expected?.generation;
          let encoded: string;
          try { if (typeof expectedGeneration !== 'string') throw new Error('expected'); encoded = encodeBootstrapJournal(payload); }
          catch { return register(Promise.reject(new InstallationJournalError('INSTALLATION_JOURNAL_INVALID'))); }
          const operation = writeTail.then(() => write(expectedGeneration, encoded));
          writeTail = operation.then(() => undefined, () => undefined); return register(operation);
        },
      });
      let value: T | undefined; let callbackFailure: unknown; let callbackFailed = false;
      try { value = await callback(session); } catch (error) { callbackFailed = true; callbackFailure = error; }
      active = false;
      const drained = await Promise.allSettled(started);
      if (callbackFailed) throw new InstallationJournalCallbackFailure(callbackFailure);
      const rejected = drained.find(result => result.status === 'rejected'); if (rejected?.status === 'rejected') throw rejected.reason;
      return value as T;
    }, options.timeoutMs);
  } catch (error) { if (error instanceof InstallationJournalCallbackFailure) throw error.reason; return unavailable(error); }
}
