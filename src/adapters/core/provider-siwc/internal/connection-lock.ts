import { withConfigWriteLock } from '#platform/index.js';
import { OAuthConnectionError, type OAuthConnectionLock } from '#engine/index.js';
import { SIWC_REFRESH_LOCK_WAIT_MS } from './registry.js';

/** Trusted composition supplies the installation custody path; the connection id cannot escape that directory. */
export function createSiwcConnectionLock(custodyPath: string): OAuthConnectionLock {
  return async (id, work, signal) => {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
    try { return await withConfigWriteLock(`${custodyPath}.siwc-${id}`, work, SIWC_REFRESH_LOCK_WAIT_MS, { signal }); }
    catch (error) {
      if (signal.aborted) throw new OAuthConnectionError('OAUTH_CONNECTION_CANCELLED');
      if (error instanceof OAuthConnectionError) throw error;
      throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    }
  };
}
