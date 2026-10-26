import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { OAuthConnectionError } from '#engine/index.js';
import { SIWC_PROTOCOL, SIWC_LIMITS } from './registry.js';
import { callerEnvironment } from '#platform/index.js';
/** Linux/WSL local browser path. No token hints, callback data, browser stdout/stderr or URL in public errors. */
export async function siwcBrowserAuthorization(makeUrl: (redirectUri: string) => string, signal: AbortSignal, presentation: Readonly<{ fallback?: (url: string) => void }> = {}): Promise<{ callback: string; redirectUri: string }> {
  if (process.platform !== 'linux') throw new OAuthConnectionError('OAUTH_CONNECTION_PLATFORM_UNSUPPORTED');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new OAuthConnectionError('OAUTH_CONNECTION_INTERACTIVE_REQUIRED');
  let redirectUri = '', expectedState = '';
  let resolve: (value: { callback: string; redirectUri: string }) => void, reject: (error: OAuthConnectionError) => void;
  const result = new Promise<{ callback: string; redirectUri: string }>((yes, no) => { resolve = yes; reject = no; });
  // Attach rejection before listen/open so abort/error cannot create an unhandled rejection.
  void result.catch(() => {});
  const server = createServer({ maxHeaderSize: SIWC_LIMITS.callbackMaxBytes, requestTimeout: SIWC_PROTOCOL.timeoutMs,
    headersTimeout: SIWC_LIMITS.httpTimeoutMs }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Security-Policy', "default-src 'none'");
    const raw = request.url ?? '';
    if (request.method !== 'GET' || Buffer.byteLength(raw) > SIWC_LIMITS.callbackMaxBytes || !raw.startsWith(`${SIWC_PROTOCOL.callbackPath}?`)
      || request.headers.host !== new URL(redirectUri).host || !matchesState(raw, expectedState)) { response.writeHead(400); response.end(); return; }
    // The application verifies state before any code exchange. HTTP success alone never means sign-in success.
    response.setHeader('Connection', 'close');
    response.once('finish', () => resolve({ callback: `${new URL(redirectUri).origin}${raw}`, redirectUri }));
    response.writeHead(204); response.end();
  });
  server.maxConnections = SIWC_LIMITS.callbackMaxConnections;
  const abort = () => { reject(new OAuthConnectionError('OAUTH_CONNECTION_CANCELLED')); server.close(); server.closeAllConnections(); };
  let loginTimer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new OAuthConnectionError('OAUTH_CONNECTION_CANCELLED');
    await new Promise<void>((yes, no) => { server.once('error', () => no(new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE')));
      server.listen(0, '127.0.0.1', yes); });
    const address = server.address();
    if (!address || typeof address === 'string' || signal.aborted) throw new OAuthConnectionError('OAUTH_CONNECTION_CANCELLED');
    // One deadline for the whole login attempt; rejected callbacks never renew it.
    loginTimer = setTimeout(() => { reject(new OAuthConnectionError('OAUTH_CONNECTION_TIMEOUT')); server.close(); server.closeAllConnections(); }, SIWC_LIMITS.loginWindowMs);
    redirectUri = `http://127.0.0.1:${address.port}${SIWC_PROTOCOL.callbackPath}`;
    const url = makeUrl(redirectUri), parsed = new URL(url);
    expectedState = parsed.searchParams.getAll('state').length === 1 ? parsed.searchParams.get('state')! : '';
    if (parsed.username || parsed.password || parsed.hash || parsed.origin !== new URL(SIWC_PROTOCOL.authorizationEndpoint).origin
      || parsed.pathname !== new URL(SIWC_PROTOCOL.authorizationEndpoint).pathname
      || !expectedState || ['id_token_hint', 'access_token', 'refresh_token', 'code'].some(key => parsed.searchParams.has(key))) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
    const browser = spawn('xdg-open', [url], { stdio: 'ignore', shell: false, env: callerEnvironment(process.env) });
    let shown = false;
    const fallback = () => { if (!shown) { shown = true; presentation.fallback?.(url); } };
    browser.once('error', fallback);
    browser.once('exit', code => { if (code !== 0) fallback(); });
    const stopBrowser = () => { browser.kill(); };
    signal.addEventListener('abort', stopBrowser, { once: true });
    try { return await result; } finally { signal.removeEventListener('abort', stopBrowser); browser.kill(); }
  } finally {
    clearTimeout(loginTimer);
    signal.removeEventListener('abort', abort); server.close(); server.closeAllConnections();
  }
}
/** Only the one callback carrying this attempt's single state may consume the listener; anything else is 400 and listening continues. */
function matchesState(raw: string, expected: string) {
  if (!expected) return false;
  const query = new URLSearchParams(raw.slice(raw.indexOf('?') + 1)), states = query.getAll('state');
  if (states.length !== 1 || query.getAll('code').length + query.getAll('error').length !== 1) return false;
  const received = Buffer.from(states[0]!), wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}
