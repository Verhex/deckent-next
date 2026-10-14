import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OAuthConnectionApplication, OAuthConnectionError, oauthConnectionRecordSchema, type OAuthConnectionPorts } from '#engine/index.js';
import { SIWC_PROTOCOL, createEncryptedFileSecretStore } from '#adapters/index.js';
import { auditEventSchema } from '#domain/index.js';

const OWNER = { installationId: 'installation-fixture', companyId: 'company-fixture', scopeId: 'scope-fixture',
  principal: { issuer: 'os-fixture', subject: 'person-fixture' } };
const SECRET = 'fixture-secret-canary-not-a-live-token';
const TIME = 1_800_000_000_000;
function fixture(overrides: Partial<OAuthConnectionPorts> = {}) {
  const values = new Map<string, string>(), audits: unknown[] = [], forms: URLSearchParams[] = [], urls: string[] = [];
  let tail = Promise.resolve();
  const tokenSet = () => ({ accessToken: SECRET, refreshToken: `${SECRET}-refresh`, idToken: `${SECRET}-id`,
    scopes: [...SIWC_PROTOCOL.identityScopes, ...SIWC_PROTOCOL.usageScopes], expiresAtMs: TIME + 60_000, earliestRefreshAtMs: null });
  const ports: OAuthConnectionPorts = {
    protocol: { ...SIWC_PROTOCOL, timeoutMs: 500 }, owner: OWNER, now: () => TIME,
    store: { descriptor: { id: SIWC_PROTOCOL.encryptedStoreId, writable: true, enumerable: true, encryptedAtRest: true },
      get: async name => values.get(name), set: async (name, value) => { values.set(name, value); }, delete: async name => values.delete(name),
      listNames: async () => [...values.keys()], inspect: async () => ({ status: 'ready', code: null }) },
    custody: { selected: async () => SIWC_PROTOCOL.encryptedStoreId, exclusive: async work => {
      const before = tail; let release!: () => void; tail = new Promise<void>(yes => { release = yes; });
      await before; try { return await work(); } finally { release(); }
    } },
    authorize: async () => ({ effect: 'allow', policyRevision: 'policy-fixture', ruleId: 'rule-fixture' }),
    audit: async event => { auditEventSchema.parse(event); audits.push(event); },
    browser: async makeUrl => {
      const redirectUri = 'http://127.0.0.1:43210/auth/callback', url = new URL(makeUrl(redirectUri)); urls.push(url.href);
      const callback = new URL(redirectUri); callback.search = new URLSearchParams({ code: 'fixture-code', state: url.searchParams.get('state')!,
        client_id: url.searchParams.get('client_id') === SIWC_PROTOCOL.dynamicClientId ? 'oaiapp_fixture' : url.searchParams.get('client_id')! }).toString();
      return { callback: callback.href, redirectUri };
    },
    exchange: async form => { forms.push(form); return tokenSet(); },
    verifyIdentity: async () => ({ issuer: SIWC_PROTOCOL.issuer, subject: 'subject-fixture', email: 'person@example.test' }),
    revoke: async () => true, unusableRefresh: () => false, ...overrides,
  };
  return { ports, values, audits, forms, urls, tokenSet, app: new OAuthConnectionApplication(ports) };
}
function record(f: ReturnType<typeof fixture>, id: string) {
  const name = `${SIWC_PROTOCOL.connectionSecretPrefix}${id.replaceAll('-', '').toUpperCase()}`;
  return { name, value: oauthConnectionRecordSchema.parse(JSON.parse(f.values.get(name)!)) };
}

describe('OAuth connection lifecycle under existing secret custody', () => {
  it('rejects malformed local plan consent before browser, host registration or credentials', async () => {
    const f = fixture();
    await expect(f.app.connect({ planUse: 'true' } as never)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_INVALID' });
    await expect(f.app.connect({ planUse: false, enablePlanUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_INVALID' });
    expect(f.values.size).toBe(0); expect(f.urls).toHaveLength(0);
  });
  it('uses issued client, fresh state/nonce/S256 and exact redirect; public view and audit contain no credentials', async () => {
    const f = fixture(), view = await f.app.connect({ planUse: true });
    expect(view).toMatchObject({ state: 'connected', planUse: true });
    const url = new URL(f.urls[0]!);
    expect(url.searchParams.get('client_id')).toBe(SIWC_PROTOCOL.dynamicClientId);
    expect(url.searchParams.get('agent_name_hint')).toBe(SIWC_PROTOCOL.appName);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(f.forms[0]!.get('client_id')).toBe('oaiapp_fixture');
    expect(f.forms[0]!.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    expect(url.searchParams.has('id_token_hint')).toBe(false);
    expect(JSON.stringify([view, f.audits])).not.toContain(SECRET);
  });
  it('keeps identity-only sign-in separate from plan permission using token response scopes', async () => {
    const f = fixture(); f.ports.exchange = async () => ({ ...f.tokenSet(), scopes: [...SIWC_PROTOCOL.identityScopes] });
    expect(await f.app.connect({ planUse: true })).toMatchObject({ state: 'identity-only', planUse: false });
  });
  it('retains verified identity when identity-only OAuth issues no inference credentials', async () => {
    const f = fixture(); f.ports.exchange = async () => ({ ...f.tokenSet(), accessToken: null, refreshToken: null,
      expiresAtMs: null, scopes: [...SIWC_PROTOCOL.identityScopes] });
    expect(await f.app.connect({ planUse: false })).toMatchObject({ state: 'identity-only', planUse: false, email: 'person@example.test' });
  });
  it('does not enable local plan use merely because the provider retained an earlier direct grant', async () => {
    const f = fixture(); expect(await f.app.connect({ planUse: false })).toMatchObject({ state: 'identity-only', planUse: false });
  });
  it('reuses host and issued client across returning login, with no ordinary forced consent', async () => {
    const f = fixture(), first = await f.app.connect({ planUse: true });
    await f.app.connect({ connectionId: first.connectionId, planUse: true });
    const [a, b] = f.urls.map(text => new URL(text));
    expect(a!.searchParams.get('state')).not.toBe(b!.searchParams.get('state'));
    expect(a!.searchParams.get('nonce')).not.toBe(b!.searchParams.get('nonce'));
    expect(a!.searchParams.get('ext_agent_host_id')).toBe(b!.searchParams.get('ext_agent_host_id'));
    expect(b!.searchParams.get('client_id')).toBe('oaiapp_fixture');
    expect(b!.searchParams.has('agent_name_hint')).toBe(false);
    expect(b!.searchParams.has('prompt')).toBe(false);
  });
  it('requests full scopes and consent only after explicit enable-plan choice', async () => {
    const f = fixture(); await f.app.connect({ planUse: true, enablePlanUse: true });
    expect(new URL(f.urls[0]!).searchParams.get('prompt')).toBe('consent');
    expect(new URL(f.urls[0]!).searchParams.get('scope')!.split(' ')).toContain(SIWC_PROTOCOL.usagePermission);
  });
  it('lists scoped registrations including an exchange failure so the issued client is recoverable', async () => {
    const f = fixture({ exchange: async () => { throw new Error(); } });
    await expect(f.app.connect({ planUse: true })).rejects.toBeInstanceOf(OAuthConnectionError);
    const listed = await f.app.list(); expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ state: 'registration', planUse: false });
    f.ports.exchange = async () => f.tokenSet();
    expect(await f.app.connect({ connectionId: listed[0]!.connectionId, planUse: true })).toMatchObject({ state: 'connected' });
    expect(new URL(f.urls[1]!).searchParams.get('client_id')).toBe('oaiapp_fixture');
  });
  it('never creates two rotating token records for the same issued registration', async () => {
    const f = fixture(); await f.app.connect({ planUse: true }); const before = new Map(f.values);
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CHANGED' });
    expect(f.values).toEqual(before); expect(await f.app.list()).toHaveLength(1);
  });
  it('a lost host id beside saved registrations never rotates host identity or opens another OAuth loop', async () => {
    const f = fixture(), view = await f.app.connect({ planUse: true });
    f.values.delete(SIWC_PROTOCOL.hostSecretName); const before = record(f, view.connectionId).value;
    await expect(f.app.connect({ connectionId: view.connectionId, planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CHANGED' });
    expect(f.values.has(SIWC_PROTOCOL.hostSecretName)).toBe(false); expect(f.urls).toHaveLength(1);
    expect(record(f, view.connectionId).value).toEqual(before);
  });
  it.each(['missing-state', 'wrong-state', 'duplicate-state', 'missing-client', 'dynamic-client', 'wrong-path', 'wrong-origin', 'access-denied'])(
    'rejects callback %s before exchange or credential publication', async mutation => {
      const f = fixture(), browser = f.ports.browser, exchange = vi.fn(f.ports.exchange); f.ports.exchange = exchange;
      f.ports.browser = async (make, signal) => {
        const result = await browser(make, signal), url = new URL(result.callback);
        if (mutation === 'missing-state') url.searchParams.delete('state');
        if (mutation === 'wrong-state') url.searchParams.set('state', 'wrong');
        if (mutation === 'duplicate-state') url.searchParams.append('state', url.searchParams.get('state')!);
        if (mutation === 'missing-client') url.searchParams.delete('client_id');
        if (mutation === 'dynamic-client') url.searchParams.set('client_id', SIWC_PROTOCOL.dynamicClientId);
        if (mutation === 'wrong-path') url.pathname = '/callback';
        if (mutation === 'wrong-origin') url.hostname = 'localhost';
        if (mutation === 'access-denied') url.searchParams.set('error', 'access_denied');
        return { ...result, callback: url.href };
      };
      await expect(f.app.connect({ planUse: true })).rejects.toBeInstanceOf(OAuthConnectionError);
      expect(exchange).not.toHaveBeenCalled();
      expect([...f.values.values()].join('')).not.toContain(SECRET);
    });
  it('rejects a changed issued client during returning OAuth, preserving the old account', async () => {
    const f = fixture(), first = await f.app.connect({ planUse: true }), before = record(f, first.connectionId).value;
    const browser = f.ports.browser; f.ports.browser = async (make, signal) => {
      const result = await browser(make, signal), url = new URL(result.callback); url.searchParams.set('client_id', 'oaiapp_other');
      return { ...result, callback: url.href };
    };
    await expect(f.app.connect({ connectionId: first.connectionId, planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_INVALID' });
    expect(record(f, first.connectionId).value).toEqual(before);
  });
  it('rejects returning same-email/different-subject identity before replacing credentials', async () => {
    const f = fixture(), first = await f.app.connect({ planUse: true }), before = record(f, first.connectionId).value;
    f.ports.verifyIdentity = async () => ({ issuer: SIWC_PROTOCOL.issuer, subject: 'other-subject', email: 'person@example.test' });
    await expect(f.app.connect({ connectionId: first.connectionId, planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_IDENTITY_INVALID' });
    expect(record(f, first.connectionId).value).toEqual(before);
  });
  it('validates identity before publishing a token bundle', async () => {
    const f = fixture({ verifyIdentity: async () => { throw new Error(SECRET); } });
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_UNAVAILABLE' });
    expect([...f.values.values()].join('')).not.toContain(SECRET);
  });
  it('does not loop or reuse the code on exchange failure; keeps the issued registration', async () => {
    const exchange = vi.fn(async () => { throw new Error('invalid_grant'); }), f = fixture({ exchange });
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_UNAVAILABLE' });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect([...f.values.values()].some(value => value.includes('oaiapp_fixture'))).toBe(true);
    expect([...f.values.values()].join('')).not.toContain(SECRET);
  });
  it.each(['core.secret-store.env@1', 'core.secret-store.file@1'])('refuses %s without browser, secret reads or fallback', async id => {
    const f = fixture(); f.ports.store.descriptor = { ...f.ports.store.descriptor, id };
    const browser = vi.fn(f.ports.browser); f.ports.browser = browser;
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_STORE_REQUIRED' });
    expect(browser).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('a secret-store switch wins before any connection mutation', async () => {
    const f = fixture(); f.ports.custody.selected = async () => 'core.secret-store.env@1';
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CHANGED' }); expect(f.values.size).toBe(0);
  });
  it('denied authority cannot launch browser or create host/token state even if audit fails', async () => {
    const f = fixture({ authorize: async () => ({ effect: 'deny', policyRevision: 'fixture', ruleId: null }), audit: async () => { throw new Error(SECRET); } });
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_DENIED' });
    expect(f.urls).toHaveLength(0); expect(f.values.size).toBe(0);
  });
  it('require-approval never becomes browser or plan-use authority', async () => {
    const f = fixture({ authorize: async () => ({ effect: 'require-approval', policyRevision: 'fixture', ruleId: null }) });
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
    expect(f.urls).toHaveLength(0); expect(f.values.size).toBe(0);
  });
  it('failed allowed audit blocks writes and external effects', async () => {
    const f = fixture({ audit: async () => { throw new Error(SECRET); } });
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_UNAVAILABLE' });
    expect(f.values.size).toBe(0); expect(f.urls).toHaveLength(0);
  });
});
describe('OAuth connection renewal and recovery', () => {
  it('persists complete OAuth credentials through the real encrypted backend, with restart continuity and local token removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'siwc-store-fixture-')), f = fixture();
    f.ports.store = createEncryptedFileSecretStore({ root, platform: process.platform });
    try {
      if (process.platform === 'win32') {
        await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_UNAVAILABLE' });
        expect(f.urls).toHaveLength(0); return;
      }
      const view = await f.app.connect({ planUse: true });
      const sealed = await readFile(join(root, 'secrets.sealed.json'), 'utf8');
      expect(sealed).not.toContain(SECRET); expect(sealed).not.toContain('person@example.test');
      const restarted = new OAuthConnectionApplication(f.ports);
      expect(await restarted.inspect(view.connectionId)).toEqual(view);
      expect(await restarted.disconnect(view.connectionId)).toMatchObject({ state: 'disconnected', remoteRevocation: 'confirmed', planUse: false });
      const name = `${SIWC_PROTOCOL.connectionSecretPrefix}${view.connectionId.replaceAll('-', '').toUpperCase()}`;
      expect(JSON.parse((await f.ports.store.get(name))!).tokens).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(['principal', 'scopeId', 'companyId', 'installationId'])('refuses foreign %s binding', async field => {
    const f = fixture(), view = await f.app.connect({ planUse: true });
    const foreign = { ...f.ports, owner: { ...OWNER, [field]: field === 'principal' ? { ...OWNER.principal, subject: 'other' } : 'other' } };
    await expect(new OAuthConnectionApplication(foreign).inspect(view.connectionId)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_DENIED' });
  });
  it('serializes rotating refreshes and atomically replaces the complete bundle', async () => {
    const f = fixture(), view = await f.app.connect({ planUse: true }); let count = 0;
    f.ports.exchange = async form => {
      const current = record(f, view.connectionId).value;
      expect(current.state).toBe('refresh-pending');
      expect(form.get('refresh_token')).toBe(current.tokens!.refreshToken);
      expect(form.has('scope')).toBe(false); count++;
      return { ...f.tokenSet(), accessToken: `access-${count}`, refreshToken: `refresh-${count}`, scopes: [...SIWC_PROTOCOL.identityScopes] };
    };
    await Promise.all([f.app.refresh(view.connectionId), new OAuthConnectionApplication(f.ports).refresh(view.connectionId)]);
    expect(count).toBe(2); expect(record(f, view.connectionId).value.tokens).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(await f.app.inspect(view.connectionId)).toMatchObject({ planUse: false, state: 'identity-only' });
  });
  it('marks uncertain refresh without erasing tokens or retrying; restart cannot reuse that rotating token', async () => {
    const f = fixture(), view = await f.app.connect({ planUse: true }), exchange = vi.fn(async () => { throw new Error(SECRET); });
    f.ports.exchange = exchange;
    await expect(f.app.refresh(view.connectionId)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_UNAVAILABLE' });
    expect(record(f, view.connectionId).value.tokens!.refreshToken).toBe(`${SECRET}-refresh`);
    expect(await f.app.inspect(view.connectionId)).toMatchObject({ state: 'refresh-unknown', planUse: false });
    await expect(new OAuthConnectionApplication(f.ports).refresh(view.connectionId)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_REAUTHORIZE' });
    expect(exchange).toHaveBeenCalledTimes(1);
  });
  it('clears only confirmed unusable tokens, preserving issued mapping and identity', async () => {
    const f = fixture({ unusableRefresh: () => true }), view = await f.app.connect({ planUse: true });
    f.ports.exchange = async () => { throw new Error(); };
    await expect(f.app.refresh(view.connectionId)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_REAUTHORIZE' });
    expect(record(f, view.connectionId).value).toMatchObject({ state: 'revoked', tokens: null, clientId: 'oaiapp_fixture', identity: { subject: 'subject-fixture' } });
  });
  it('rejects an identity change during refresh; retains unknown instead of declaring completion', async () => {
    const f = fixture(), view = await f.app.connect({ planUse: true });
    f.ports.verifyIdentity = async () => ({ issuer: SIWC_PROTOCOL.issuer, subject: 'other-subject', email: null });
    await expect(f.app.refresh(view.connectionId)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_UNAVAILABLE' });
    expect(await f.app.inspect(view.connectionId)).toMatchObject({ state: 'refresh-unknown', planUse: false });
  });
  it('blocks refresh-pending after a crash and rejects tokens published by a stale OAuth completion', async () => {
    const f = fixture(), view = await f.app.connect({ planUse: true }), saved = record(f, view.connectionId);
    f.values.set(saved.name, JSON.stringify({ ...saved.value, state: 'refresh-pending', generation: saved.value.generation + 1 }));
    await expect(f.app.refresh(view.connectionId)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_REAUTHORIZE' });
    const browser = f.ports.browser; f.ports.browser = async (make, signal) => {
      const result = await browser(make, signal); await f.app.disconnect(view.connectionId); return result;
    };
    await expect(f.app.connect({ connectionId: view.connectionId, planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CHANGED' });
    expect(await f.app.inspect(view.connectionId)).toMatchObject({ state: 'disconnected', planUse: false });
  });
  it('remote revoke failure still stops local use and preserves registration/host/history', async () => {
    const f = fixture({ revoke: async () => { throw new Error(SECRET); } }), view = await f.app.connect({ planUse: true });
    expect(await f.app.disconnect(view.connectionId)).toMatchObject({ state: 'disconnected', remoteRevocation: 'unconfirmed', planUse: false });
    expect(record(f, view.connectionId).value.tokens).toBeNull(); expect(f.values.get(SIWC_PROTOCOL.hostSecretName)).toMatch(/^urn:uuid:/u);
    expect(record(f, view.connectionId).value.clientId).toBe('oaiapp_fixture');
    expect(f.audits.length).toBeGreaterThan(0); expect(JSON.stringify(f.audits)).not.toContain(SECRET);
  });
  it('preserves confirmed remote revoke distinctly', async () => {
    const f = fixture(), view = await f.app.connect({ planUse: true });
    expect(await f.app.disconnect(view.connectionId)).toMatchObject({ remoteRevocation: 'confirmed' });
  });
  it('pre-aborted login has no effects', async () => {
    const f = fixture(); await expect(f.app.connect({ planUse: true }, AbortSignal.abort())).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CANCELLED' });
    expect(f.values.size).toBe(0); expect(f.urls).toHaveLength(0);
  });
  it('a hung browser has a visible bounded timeout and cannot publish credentials later', async () => {
    const f = fixture({ browser: async (_make, signal) => new Promise((_yes, no) => signal.addEventListener('abort', () => no(new Error(SECRET)), { once: true })) });
    f.ports.protocol = { ...f.ports.protocol, timeoutMs: 10 };
    await expect(f.app.connect({ planUse: true })).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_TIMEOUT' });
    expect([...f.values.values()].join('')).not.toContain(SECRET);
  });
});
