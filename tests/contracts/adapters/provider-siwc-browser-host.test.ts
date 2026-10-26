import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: mocked.spawn }));
import { SIWC_PROTOCOL, SIWC_LIMITS, siwcBrowserAuthorization } from '#adapters/index.js';

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
  vi.useRealTimers();
  if (stdinFlag) Object.defineProperty(process.stdin, 'isTTY', stdinFlag); else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stdoutFlag) Object.defineProperty(process.stdout, 'isTTY', stdoutFlag); else Reflect.deleteProperty(process.stdout, 'isTTY');
});
const make = (redirectUri: string) => {
  const url = new URL(SIWC_PROTOCOL.authorizationEndpoint);
  url.search = new URLSearchParams({ redirect_uri: redirectUri, state: 'fixture-state' }).toString();
  return url.href;
};
const child = () => Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
const callbackStatus = (url: string) => new Promise<number>((done, fail) => {
  get(url, { agent: false }, response => { response.resume(); response.once('end', () => done(response.statusCode ?? 0)); }).once('error', fail);
});

describe.skipIf(process.platform !== 'linux')('SIWC loopback/browser adapter host fixtures', () => {
  it('starts the exact 127.0.0.1 listener before xdg-open, closes it after callback, and keeps credentials out of argv', async () => {
    let redirect = '', delivered!: Promise<Response>;
    const fake = child();
    mocked.spawn.mockImplementation((command: string, args: string[], options: { shell?: unknown; stdio?: unknown }) => {
      // The options carry the caller's real environment (FIX8a): only the named fields are compared, so a failure prints no env value.
      expect(command).toBe('xdg-open'); expect({ shell: options.shell, stdio: options.stdio }).toEqual({ shell: false, stdio: 'ignore' });
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
  it('rejects another path, host, state or duplicated parameter before accepting the exact callback', async () => {
    let statuses!: Promise<number[]>;
    mocked.spawn.mockImplementation((_command: string, args: string[]) => {
      const redirect = new URL(args[0]!).searchParams.get('redirect_uri')!, base = new URL(redirect);
      statuses = (async () => {
        const wrongPath = await fetch(`${base.origin}/wrong?code=fixture`);
        // fetch drops a caller Host header (forbidden header), so the wrong host goes through node:http.
        const wrongHost = await new Promise<{ status: number }>((done, fail) => {
          get(`${redirect}?code=fixture`, { headers: { host: 'localhost' } }, response => { response.resume(); done({ status: response.statusCode ?? 0 }); }).once('error', fail);
        });
        const noState = await fetch(`${redirect}?code=attacker-code`);
        const wrongState = await fetch(`${redirect}?state=other-state&code=attacker-code`);
        const firstByte = await fetch(`${redirect}?state=Fixture-state&code=attacker-code`);
        const lastByte = await fetch(`${redirect}?state=fixture-statE&code=attacker-code`);
        const shortState = await fetch(`${redirect}?state=fixture-stat&code=attacker-code`);
        const longState = await fetch(`${redirect}?state=fixture-state-extra&code=attacker-code`);
        const multiByteState = await fetch(`${redirect}?state=${encodeURIComponent('fixture-staté')}&code=attacker-code`);
        const twoStates = await fetch(`${redirect}?state=fixture-state&state=other-state&code=attacker-code`);
        const twoCodes = await fetch(`${redirect}?state=fixture-state&code=attacker-code&code=fixture-code`);
        const correct = await fetch(`${redirect}?state=fixture-state&code=fixture-code&client_id=oaiapp_fixture`);
        return [wrongPath.status, wrongHost.status, noState.status, wrongState.status, firstByte.status, lastByte.status, shortState.status, longState.status, multiByteState.status, twoStates.status, twoCodes.status, correct.status];
      })();
      return child();
    });
    const result = await siwcBrowserAuthorization(make, abort.signal);
    expect(await statuses).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 204]);
    expect(new URL(result.callback).searchParams.get('code')).toBe('fixture-code');
  });
  it.each([false, true])('bad callback flood never renews the login window; valid callback before expiry = %s', async accept => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = child();
    let redirect = '', opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    mocked.spawn.mockImplementation((_command: string, args: string[]) => {
      redirect = new URL(args[0]!).searchParams.get('redirect_uri')!; opened(); return fake;
    });
    const result = siwcBrowserAuthorization(make, abort.signal);
    const outcome = result.catch((error: unknown) => error);
    await Promise.race([ready, result]);
    // Real HTTP traffic at several times, including the last millisecond. No caller timeout/signal fires.
    let elapsed = 0;
    for (const at of [0, Math.floor(SIWC_LIMITS.loginWindowMs / 2), SIWC_LIMITS.loginWindowMs - 1]) {
      await vi.advanceTimersByTimeAsync(at - elapsed); elapsed = at;
      for (let request = 0; request < 16; request++) {
        expect(await callbackStatus(`${redirect}?state=attacker-state&code=attacker-code`)).toBe(400);
      }
    }
    expect(fake.kill).not.toHaveBeenCalled();
    if (accept) {
      expect(await callbackStatus(`${redirect}?state=fixture-state&code=fixture-code`)).toBe(204);
      await expect(result).resolves.toMatchObject({ redirectUri: redirect });
    } else {
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ code: 'OAUTH_CONNECTION_TIMEOUT' });
      expect(JSON.stringify(await outcome)).not.toMatch(/fixture-state|attacker-code|127\.0\.0\.1/);
    }
    expect(abort.signal.aborted).toBe(false); expect(fake.kill).toHaveBeenCalled();
    await expect(callbackStatus(`${redirect}?state=fixture-state&code=fixture-code`)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
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
  expect(mocked.spawn.mock.calls.length).toBe(0); // a count, never the calls (their options would carry the environment)
});


it.skipIf(process.platform !== 'linux')('always presents only the safe URL (also when the opener reports success, as on SSH), keeps the listener open, then cancels it', async () => {
  const fake = child(), fallback = vi.fn(); let redirect = '';
  mocked.spawn.mockImplementation((_command: string, args: string[]) => {
    redirect = new URL(args[0]!).searchParams.get('redirect_uri')!;
    queueMicrotask(() => { fake.emit('exit', 0); fake.emit('error', new Error('fixture-launcher-missing')); }); return fake;
  });
  const pending = siwcBrowserAuthorization(make, abort.signal, { fallback });
  while (!fallback.mock.calls.length) await new Promise<void>(done => setImmediate(done));
  expect(fallback).toHaveBeenCalledTimes(1);
  const shown = new URL(fallback.mock.calls[0]![0]);
  expect(shown.origin).toBe(new URL(SIWC_PROTOCOL.authorizationEndpoint).origin);
  expect(shown.searchParams.has('code')).toBe(false); expect(shown.searchParams.has('id_token_hint')).toBe(false);
  expect(await callbackStatus(`${redirect}?state=foreign&code=fixture-code`)).toBe(400);
  abort.abort(); await expect(pending).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CANCELLED' });
  await expect(fetch(redirect)).rejects.toThrow();
});
