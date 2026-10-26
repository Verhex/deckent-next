import { personalCustodyEvidenceSchema, PersonalCustodyError, type PersonalCustodyEvidence } from '#engine/core/secret-store/index.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AUDIT_EVENT_SCHEMA_VERSION, delegationOwner, type AuditEvent } from '#domain/index.js';
import { isSecretName, isSecretValue, RENEWABLE_SECRET_PREFIX, assertSecretStorageProtection } from '#engine/core/secret-store/index.js';
import { OAuthConnectionError, oauthConnectionOwnerSchema, oauthConnectionConnectSchema, oauthConnectionRecordSchema, oauthTokenSetSchema,
  type OAuthAccessTokenLease, type OAuthConnectionOwner, type OAuthConnectionPorts, type OAuthConnectionRecord, type OAuthConnectionView } from './contract.js';
/** Node timers use a signed 32-bit duration; this is a platform invariant, not a retry/timeout policy. */
const NODE_SIGNED_INTEGER_CEILING = 2_147_483_647;

/** Generic OAuth registration/session custody. Vendor grants never create Deckent principals, roles or effect authority. */
export class OAuthConnectionApplication {
  private evidence: PersonalCustodyEvidence | null = null;
  private pending = 0;
  private readonly owner: OAuthConnectionOwner;
  constructor(private readonly ports: OAuthConnectionPorts) {
    this.owner = oauthConnectionOwnerSchema.parse(ports.owner);
    const p = ports.protocol;
    if (!Number.isSafeInteger(p.refreshMarginMs) || p.refreshMarginMs <= 0 || typeof ports.connectionLock !== 'function'
      || !Number.isSafeInteger(p.timeoutMs) || p.timeoutMs <= 0 || p.timeoutMs > NODE_SIGNED_INTEGER_CEILING
      || !Number.isSafeInteger(p.maxPending) || p.maxPending <= 0 || !Number.isSafeInteger(p.maxConnections) || p.maxConnections <= 0 || !isSecretName(p.hostSecretName)
      || !p.connectionSecretPrefix.startsWith(RENEWABLE_SECRET_PREFIX)
      || !isSecretName(`${p.connectionSecretPrefix}${randomUUID().replaceAll('-', '').toUpperCase()}`)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
  }

  async inspect(connectionId: string): Promise<OAuthConnectionView> {
    return this.exclusive(async () => this.view(await this.read(connectionId)));
  }
  async list(): Promise<readonly OAuthConnectionView[]> {
    return this.exclusive(async () => {
      const records = await this.records();
      return Object.freeze(records.filter(record => isDeepStrictEqual(record.owner, this.owner)).map(record => this.view(record)));
    });
  }

  /** Revocation remains possible when personal proof is unavailable. Never reports an unverified plan as usable. */
  async listForRevocation(): Promise<readonly Readonly<{ connectionId: string; state: OAuthConnectionRecord['state']; remoteRevocation: OAuthConnectionRecord['remoteRevocation'] }>[]> {
    return this.exclusive(async () => Object.freeze((await this.records()).filter(record => isDeepStrictEqual(record.owner, this.owner))
      .map(record => Object.freeze({ connectionId: record.connectionId, state: record.state, remoteRevocation: record.remoteRevocation }))), false);
  }

  async connect(input: { connectionId?: string; planUse: boolean; enablePlanUse?: boolean }, signal?: AbortSignal): Promise<OAuthConnectionView> {
    const parsed = oauthConnectionConnectSchema.safeParse(input);
    if (!parsed.success) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
    const request = parsed.data;
    if (this.pending >= this.ports.protocol.maxPending) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    this.pending++;
    try { return await this.bounded(signal, async bounded => {
      const id = request.connectionId ?? randomUUID();
      const initial = await this.exclusive(async () => {
        await this.decision(this.name(id), 'set');
        const record = request.connectionId ? await this.read(id, true) : null;
        if (!record && (await this.records()).length >= this.ports.protocol.maxConnections) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
        const host = await this.host();
        return { record, host, evidence: this.evidence! };
      });
      const p = this.ports.protocol, state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
      const client = initial.record?.clientId ?? p.dynamicClientId;
      const returned = await this.ports.browser(redirectUri => {
        this.redirect(redirectUri);
        const url = new URL(p.authorizationEndpoint);
        url.search = new URLSearchParams({ client_id: client, ext_agent_host_id: initial.host, response_type: 'code', redirect_uri: redirectUri,
          scope: [...p.identityScopes, ...(request.planUse ? p.usageScopes : [])].join(' '), resource: p.resource, state, nonce,
          code_challenge_method: 'S256', code_challenge: challenge, ...(initial.record ? {} : { agent_name_hint: p.appName }),
          ...(request.enablePlanUse ? { prompt: 'consent' } : {}) }).toString();
        // No retained id_token_hint: system browser launch may carry this non-secret URL in argv.
        return url.href;
      }, bounded);
      this.redirect(returned.redirectUri);
      const callback = new URL(returned.callback), redirect = new URL(returned.redirectUri);
      if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.hash
        || ['state', 'code', 'client_id', 'error'].some(key => callback.searchParams.getAll(key).length > 1)
        || !this.equal(callback.searchParams.get('state'), state)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      if (callback.searchParams.has('error')) throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
      const issued = callback.searchParams.get('client_id') ?? (initial.record ? client : null), code = callback.searchParams.get('code');
      if (!issued || issued === p.dynamicClientId || issued.length > 256 || !code || (initial.record && issued !== client))
        throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      const registration: OAuthConnectionRecord = initial.record ? { ...initial.record, schemaVersion: 2, custody: this.binding(initial.evidence) } : { schemaVersion: 2, custody: this.binding(initial.evidence), connectionId: id, owner: this.owner,
        clientId: issued, identity: null, generation: 0, planUseEnabled: false, state: 'registration', remoteRevocation: 'not-attempted', tokens: null };
      // Retain the issued registration before the one-use exchange. An interrupted exchange is never retried with the same code.
      if (!initial.record || initial.record.schemaVersion === 1 || !isDeepStrictEqual(initial.record.custody, registration.schemaVersion === 2 ? registration.custody : null)) await this.exclusive(async () => {
        this.checkSignal(bounded);
        const saved = await this.records();
        if ((!initial.record && saved.length >= p.maxConnections) || saved.some(record => record.connectionId !== id && record.clientId === issued)) throw new OAuthConnectionError('OAUTH_CONNECTION_CHANGED');
        await this.write(registration);
      });
      const expectedGeneration = registration.generation;
      const exchanged = await this.ports.exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code,
        code_verifier: verifier, redirect_uri: returned.redirectUri, resource: p.resource }), bounded);
      this.checkSignal(bounded);
      const tokens = this.tokens(exchanged);
      if (!tokens.idToken) throw new OAuthConnectionError('OAUTH_CONNECTION_IDENTITY_INVALID');
      const identity = await this.ports.verifyIdentity(tokens.idToken, issued, nonce, bounded);
      if (identity.issuer !== p.issuer || (initial.record?.identity && !this.sameIdentity(initial.record.identity, identity)))
        throw new OAuthConnectionError('OAUTH_CONNECTION_IDENTITY_INVALID');
      return this.exclusive(async () => {
        this.checkSignal(bounded);
        const current = await this.read(id);
        if (current.generation !== expectedGeneration || current.state === 'disconnecting') throw new OAuthConnectionError('OAUTH_CONNECTION_CHANGED');
        await this.write({ ...current, identity, tokens, planUseEnabled: request.planUse, state: 'connected', generation: current.generation + 1, remoteRevocation: 'not-attempted' });
        return this.view(await this.read(id));
      });
    }); } finally { this.pending--; }
  }

  /** The verified caller acts for the same person in the same installation/company/project. No name/grant path. */
  /** Local readiness without exposing a token or renewing it. An expired but renewable authorized plan is not falsely logged out. */
  async inspectForLease(connectionId: string, caller: OAuthConnectionOwner): Promise<OAuthConnectionView> {
    this.assertCaller(caller);
    return this.exclusive(async () => {
      const record = await this.read(connectionId); this.planRecord(record);
      if (record.tokens!.expiresAtMs! - this.ports.now() <= this.ports.protocol.refreshMarginMs && !record.tokens!.refreshToken)
        throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
      return this.view(record);
    });
  }
  private assertCaller(callerInput: OAuthConnectionOwner): void {
    const parsed = oauthConnectionOwnerSchema.safeParse(callerInput);
    if (!parsed.success) throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
    const caller = parsed.data, person = delegationOwner(caller.principal);
    if (caller.installationId !== this.owner.installationId || caller.companyId !== this.owner.companyId || caller.scopeId !== this.owner.scopeId
      || !this.sameIdentity(person, this.owner.principal)) throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
  }
  async lease(connectionId: string, callerInput: OAuthConnectionOwner, signal?: AbortSignal): Promise<OAuthAccessTokenLease> {
    this.assertCaller(callerInput);
    return this.bounded(signal, bounded => this.connection(connectionId, bounded, async () => {
      let record = await this.exclusive(() => this.read(connectionId));
      this.planRecord(record);
      if (record.tokens!.expiresAtMs! - this.ports.now() <= this.ports.protocol.refreshMarginMs) {
        await this.renew(connectionId, bounded);
        record = await this.exclusive(() => this.read(connectionId));
      }
      this.checkSignal(bounded); this.planRecord(record);
      if (this.ports.now() >= record.tokens!.expiresAtMs!) throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
      return Object.freeze({ accessToken: record.tokens!.accessToken!, expiresAtMs: record.tokens!.expiresAtMs! });
    }));
  }

  async refresh(connectionId: string, signal?: AbortSignal): Promise<OAuthConnectionView> {
    return this.bounded(signal, bounded => this.connection(connectionId, bounded, () => this.renew(connectionId, bounded)));
  }
  private connection<T>(id: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    this.name(id);
    return this.ports.connectionLock(id, async () => { this.checkSignal(signal); return work(); }, signal);
  }
  private planRecord(record: OAuthConnectionRecord): void {
    if (record.state !== 'connected' || !record.identity || !record.planUseEnabled || !record.tokens?.accessToken
      || record.tokens.expiresAtMs === null || !record.tokens.scopes.includes(this.ports.protocol.usagePermission))
      throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
  }
  /** Only short reads/CAS writes hold installation custody; rotating-token network I/O holds the connection lock. */
  private async renew(connectionId: string, bounded: AbortSignal): Promise<OAuthConnectionView> {
    const initial = await this.exclusive(async () => {
      this.checkSignal(bounded);
      const record = await this.read(connectionId), tokens = record.tokens;
      if (record.state !== 'connected' || !tokens?.refreshToken) throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
      if (tokens.earliestRefreshAtMs !== null && this.ports.now() < tokens.earliestRefreshAtMs) return { record, pending: false };
      const pending = { ...record, state: 'refresh-pending' as const, generation: record.generation + 1 };
      await this.write(pending);
      return { record, pending: true };
    });
    const { record } = initial, tokens = record.tokens!;
    if (!initial.pending) return this.view(record);
    const generation = record.generation + 1;
    try {
      this.checkSignal(bounded);
      const replacement = this.tokens(await this.bounded(bounded, remote => this.ports.exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId,
        refresh_token: tokens.refreshToken!, resource: this.ports.protocol.resource }), remote)));
      this.checkSignal(bounded);
      if (!replacement.refreshToken) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      if (replacement.idToken) {
        const identity = await this.bounded(bounded, remote => this.ports.verifyIdentity(replacement.idToken!, record.clientId, null, remote));
        if (!record.identity || !this.sameIdentity(record.identity, identity)) throw new OAuthConnectionError('OAUTH_CONNECTION_IDENTITY_INVALID');
      }
      this.checkSignal(bounded);
      const saved = await this.replace(connectionId, generation, 'refresh-pending', { ...record,
        tokens: { ...replacement, idToken: replacement.idToken ?? tokens.idToken }, state: 'connected', generation: generation + 1 }, bounded);
      return this.view(saved);
    } catch (error) {
      if (error instanceof OAuthConnectionError && error.code === 'OAUTH_CONNECTION_CHANGED') throw error;
      const revoked = this.ports.unusableRefresh(error);
      await this.replace(connectionId, generation, 'refresh-pending', { ...record, tokens: revoked ? null : tokens,
        state: revoked ? 'revoked' : 'refresh-unknown', generation: generation + 1 });
      throw new OAuthConnectionError(revoked ? 'OAUTH_CONNECTION_REAUTHORIZE' : 'OAUTH_CONNECTION_UNAVAILABLE');
    }
  }
  private replace(id: string, generation: number, state: OAuthConnectionRecord['state'], next: OAuthConnectionRecord, signal?: AbortSignal, personal = true) {
    return this.exclusive(async () => {
      if (signal) this.checkSignal(signal);
      const current = await this.read(id);
      if (current.generation !== generation || current.state !== state) throw new OAuthConnectionError('OAUTH_CONNECTION_CHANGED');
      await this.write(next); return next;
    }, personal);
  }

  async disconnect(connectionId: string, signal?: AbortSignal): Promise<OAuthConnectionView> {
    // Serialize with refresh so revocation uses the latest rotating token. A cancelled remote call still clears local credentials.
    return this.bounded(undefined, bounded => this.connection(connectionId, bounded, async () => {
      const record = await this.exclusive(async () => {
        const current = await this.read(connectionId);
        if (current.state !== 'disconnected') await this.write({ ...current, state: 'disconnecting', generation: current.generation + 1 });
        return current;
      }, false);
      if (record.state === 'disconnected') return this.view(record);
      let confirmed = false;
      if (record.tokens?.refreshToken) {
        try { confirmed = await this.bounded(signal ? AbortSignal.any([bounded, signal]) : bounded,
          remote => this.ports.revoke(record.clientId, record.tokens!.refreshToken!, remote)); }
        catch { /* Local stop is unconditional; unconfirmed remote revocation is retained explicitly. */ }
      }
      const saved = await this.replace(connectionId, record.generation + 1, 'disconnecting', { ...record, state: 'disconnected', tokens: null,
        generation: record.generation + 2, remoteRevocation: confirmed ? 'confirmed' : 'unconfirmed' }, undefined, false);
      return this.view(saved);
    }));
  }

  private name(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
    return `${this.ports.protocol.connectionSecretPrefix}${id.replaceAll('-', '').toUpperCase()}`;
  }
  private binding(evidence: PersonalCustodyEvidence) {
    return { bindingId: evidence.store.instanceBindingId, generation: evidence.store.generation };
  }
  private async exclusive<T>(work: () => Promise<T>, personal = true): Promise<T> {
    try { return await this.ports.custody.exclusive(async () => {
      if (this.ports.store.descriptor.id !== this.ports.protocol.encryptedStoreId || !this.ports.store.descriptor.writable
        || this.ports.store.descriptor.encryptedAtRest !== true)
        throw new OAuthConnectionError('OAUTH_CONNECTION_STORE_REQUIRED');
      assertSecretStorageProtection(this.ports.protocol.connectionSecretPrefix, this.ports.store.descriptor);
      if (await this.ports.custody.selected() !== this.ports.store.descriptor.id) throw new OAuthConnectionError('OAUTH_CONNECTION_CHANGED');
      if (personal) {
        if (!this.ports.custody.assertPersonal) throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
        try {
          const evidence = personalCustodyEvidenceSchema.parse(await this.ports.custody.assertPersonal(this.ports.store.descriptor, this.owner));
          if (!isDeepStrictEqual(evidence.owner, this.owner) || evidence.store.backendId !== this.ports.store.descriptor.id
            || !evidence.host.keyIdentityDigest || evidence.observedAtMs > this.ports.now()) throw new PersonalCustodyError('binding-changed');
          this.evidence = evidence;
        } catch (error) { throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL', error instanceof PersonalCustodyError ? error.reason : 'unbound-store'); }
      }
      try { return await work(); } finally { this.evidence = null; }
    }); } catch (error) {
      if (error instanceof OAuthConnectionError) throw error;
      throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    }
  }
  private async read(id: string, reconnect = false): Promise<OAuthConnectionRecord> {
    await this.decision(this.name(id), 'set', false);
    try {
      const text = await this.ports.store.get(this.name(id));
      if (!text) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      const record = oauthConnectionRecordSchema.parse(JSON.parse(text));
      if (record.connectionId !== id || !isDeepStrictEqual(record.owner, this.owner)) throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
      if (this.evidence) {
        if (record.schemaVersion === 1) {
          if (!reconnect || record.tokens !== null || !['registration', 'disconnected'].includes(record.state)) throw new OAuthConnectionError('OAUTH_CONNECTION_REAUTHORIZE');
        } else if (!isDeepStrictEqual(record.custody, this.binding(this.evidence)) && (!reconnect || record.tokens !== null || !['registration', 'disconnected'].includes(record.state))) throw new OAuthConnectionError('SIWC_STORE_NOT_PERSONAL');
      }
      return record;
    } catch (error) {
      if (error instanceof OAuthConnectionError) throw error;
      throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    }
  }
  private async records(): Promise<readonly OAuthConnectionRecord[]> {
    const names = (await this.ports.store.listNames()).filter(name => name.startsWith(this.ports.protocol.connectionSecretPrefix));
    if (names.length > this.ports.protocol.maxConnections) throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    const records: OAuthConnectionRecord[] = [];
    for (const name of names) {
      await this.decision(name, 'set', false);
      try {
        const text = await this.ports.store.get(name), record = oauthConnectionRecordSchema.parse(JSON.parse(text ?? ''));
        if (name !== this.name(record.connectionId)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
        records.push(record);
      } catch (error) {
        if (error instanceof OAuthConnectionError) throw error;
        throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
      }
    }
    return records;
  }
  private async write(record: OAuthConnectionRecord): Promise<void> {
    let value: string;
    try { value = JSON.stringify(oauthConnectionRecordSchema.parse(record)); }
    catch { throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID'); }
    if (!isSecretValue(value)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
    await this.decision(this.name(record.connectionId), 'set');
    await this.ports.store.set(this.name(record.connectionId), value);
  }
  private async host(): Promise<string> {
    const name = this.ports.protocol.hostSecretName, existing = await this.ports.store.get(name);
    if (existing !== undefined) {
      if (!/^urn:uuid:[a-f0-9-]{36}$/u.test(existing)) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
      return existing;
    }
    // A lost host mapping beside registrations is corruption/recovery, never an automatic new host attribution.
    if ((await this.records()).length) throw new OAuthConnectionError('OAUTH_CONNECTION_CHANGED');
    await this.decision(name, 'set');
    const value = `urn:uuid:${randomUUID()}`;
    await this.ports.store.set(name, value);
    return value;
  }
  private async decision(name: string, action: 'set' | 'delete', recordIntent = true): Promise<void> {
    const { principal, scopeId } = this.owner;
    const decision = await this.ports.authorize({ principal, scopeId, name, action });
    if (decision.effect === 'allow' && !recordIntent) return;
    const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId, principal,
      policyRevision: decision.policyRevision, atMs: this.ports.now(), subject: { kind: 'secret-change' as const, action, name,
        backend: this.ports.store.descriptor.id, decision: { effect: decision.effect, ruleId: decision.ruleId } } };
    if (decision.effect === 'allow') { await this.ports.audit(event); return; }
    try { await this.ports.audit(event); } catch { /* Failed audit never grants a refused action. */ }
    if (decision.effect === 'require-approval') throw new OAuthConnectionError('POLICY_APPROVAL_UNSUPPORTED');
    throw new OAuthConnectionError('OAUTH_CONNECTION_DENIED');
  }
  private tokens(value: unknown) {
    try { return oauthTokenSetSchema.parse(value); } catch { throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID'); }
  }
  private view(record: OAuthConnectionRecord): OAuthConnectionView {
    const usable = record.state === 'connected' && record.tokens?.accessToken !== null && record.tokens !== null
      && record.tokens.expiresAtMs !== null && this.ports.now() < record.tokens.expiresAtMs;
    const bound = record.schemaVersion === 2 && (this.evidence === null || isDeepStrictEqual(record.custody, this.binding(this.evidence)));
    const planUse = usable && bound && record.planUseEnabled && record.tokens!.scopes.includes(this.ports.protocol.usagePermission);
    const state = record.state !== 'connected' ? record.state : record.tokens?.accessToken === null ? 'identity-only'
      : !usable ? 'expired' : !planUse ? 'identity-only' : 'connected';
    return Object.freeze({ schemaVersion: 1, connectionId: record.connectionId, generation: record.generation, email: record.identity?.email ?? null,
      state, planUse, remoteRevocation: record.remoteRevocation });
  }
  private redirect(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== this.ports.protocol.callbackPath
      || url.username || url.password || url.search || url.hash) throw new OAuthConnectionError('OAUTH_CONNECTION_INVALID');
  }
  private equal(a: string | null, b: string) { return a !== null && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  private sameIdentity(a: { issuer: string; subject: string }, b: { issuer: string; subject: string }) { return a.issuer === b.issuer && a.subject === b.subject; }
  private checkSignal(signal: AbortSignal) { if (signal.aborted) throw new OAuthConnectionError('OAUTH_CONNECTION_CANCELLED'); }
  private async bounded<T>(signal: AbortSignal | undefined, work: (bounded: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = new AbortController(), bounded = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    this.checkSignal(bounded);
    const timer = setTimeout(() => timeout.abort(), this.ports.protocol.timeoutMs);
    timer.unref();
    try { return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(new OAuthConnectionError(signal?.aborted ? 'OAUTH_CONNECTION_CANCELLED' : 'OAUTH_CONNECTION_TIMEOUT'));
      bounded.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { this.checkSignal(bounded); return work(bounded); }).then(resolve, reject)
        .finally(() => bounded.removeEventListener('abort', abort));
    }); }
    catch (error) {
      if (bounded.aborted) throw new OAuthConnectionError(signal?.aborted ? 'OAUTH_CONNECTION_CANCELLED' : 'OAUTH_CONNECTION_TIMEOUT');
      if (error instanceof OAuthConnectionError) throw error;
      throw new OAuthConnectionError('OAUTH_CONNECTION_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
}
