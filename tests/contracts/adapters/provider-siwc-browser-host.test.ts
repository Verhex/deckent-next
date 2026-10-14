import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocked.spawn }));
import { SIWC_PROTOCOL, siwcBrowserAuthorization } from '#adapters/index.js';

// OWNER-VERIFY only: this file binds real loopback sockets. No browser or OpenAI connection is made.
// Fixture TTY flags test the browser interaction guard only; they never establish human approval or principal authority.
const stdinFlag = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'), stdoutFlag = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
let abort: AbortController;
beforeEach(() => {
  abort = new AbortController(); mocked.spawn.mockReset();
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
});
afterEach(() => {
  abort.abort();
  if (stdinFlag) Object.defineProperty(process.stdin, 'isTTY', stdinFlag); else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stdoutFlag) Object.defineProperty(process.stdout, 'isTTY', stdoutFlag); else Reflect.deleteProperty(process.stdout, 'isTTY');
});
const make = (redirectUri: string) => {
  const url = new URL(SIWC_PROTOCOL.authorizationEndpoint);
  url.search = new URLSearchParams({ redirect_uri: redirectUri, state: 'fixture-state' }).toString();
  return url.href;
};
const child = () => Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });

describe.skipIf(process.platform !== 'linux')('SIWC loopback/browser adapter host fixtures', () => {
  it('starts the exact 127.0.0.1 listener before xdg-open, closes it after callback, and keeps credentials out of argv', async () => {
    let redirect = '', delivered!: Promise<Response>;
    const fake = child();
    mocked.spawn.mockImplementation((command: string, args: string[], options: unknown) => {
      expect(command).toBe('xdg-open'); expect(options).toMatchObject({ shell: false, stdio: 'ignore' });
      const url = new URL(args[0]!); redirect = url.searchParams.get('redirect_uri')!;
      expect(new URL(redirect).hostname).toBe('127.0.0.1'); expect(new URL(redirect).pathname).toBe(SIWC_PROTOCOL.callbackPath);
      expect(url.searchParams.has('id_token_hint')).toBe(false); expect(url.searchParams.has('access_token')).toBe(false);
      delivered = fetch(`${redirect}?state=fixture-state&code=fixture-code&client_id=oaiapp_fixture`);
      return fake;
    });
    const result = await siwcBrowserAuthorization(make, abort.signal);
    expect((await delivered).status).toBe(204); expect(result.redirectUri).toBe(redirect);
    expect(new URL(result.callback).searchParams.get('code')).toBe('fixture-code');
    expect(mocked.spawn).toHaveBeenCalledTimes(1); expect(fake.kill).toHaveBeenCalled();
    await expect(fetch(redirect)).rejects.toThrow();
  });
  it('rejects another path and host before accepting the exact callback', async () => {
    let statuses!: Promise<number[]>;
    mocked.spawn.mockImplementation((_command: string, args: string[]) => {
      const redirect = new URL(args[0]!).searchParams.get('redirect_uri')!, base = new URL(redirect);
      statuses = (async () => {
        const wrongPath = await fetch(`${base.origin}/wrong?code=fixture`);
        // fetch drops a caller Host header (forbidden header), so the wrong host goes through node:http.
        const wrongHost = await new Promise<{ status: number }>((done, fail) => {
          get(`${redirect}?code=fixture`, { headers: { host: 'localhost' } }, response => { response.resume(); done({ status: response.statusCode ?? 0 }); }).once('error', fail);
        });
        const correct = await fetch(`${redirect}?state=fixture-state&code=fixture-code&client_id=oaiapp_fixture`);
        return [wrongPath.status, wrongHost.status, correct.status];
      })();
      return child();
    });
    await siwcBrowserAuthorization(make, abort.signal);
    expect(await statuses).toEqual([400, 400, 204]);
  });
  it('cancellation closes the pending listener and never exposes the authorization URL in an error', async () => {
    let redirect = '';
    mocked.spawn.mockImplementation((_command: string, args: string[]) => {
      redirect = new URL(args[0]!).searchParams.get('redirect_uri')!; queueMicrotask(() => abort.abort()); return child();
    });
    const error = await siwcBrowserAuthorization(make, abort.signal).catch(error => error);
    expect(error).toMatchObject({ code: 'OAUTH_CONNECTION_CANCELLED' });
    expect(JSON.stringify(error)).not.toContain('fixture-state');
    await expect(fetch(redirect)).rejects.toThrow();
  });
});
it('unsupported native platforms reject before listener or opener construction', async () => {
  if (process.platform === 'linux') return;
  await expect(siwcBrowserAuthorization(make, abort.signal)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_PLATFORM_UNSUPPORTED' });
  expect(mocked.spawn).not.toHaveBeenCalled();
});
