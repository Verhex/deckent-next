import { z } from 'zod';
import { AGENT_CATALOG_LIMITS, HUB_LIMITS, HUB_REVOCATION_REFRESH_MS, HUB_TRUST_POLICIES, HubError, requireBoundedHubJson, canonicalHubJson, identitySchema, isAiPrincipal, signerPublicKeySchema, hubRevocationFeedSchema, type HubRevocationFeed,
  type VerifiedPrincipal } from '#domain/index.js';
import { ed25519KeyId, sha256, t, type Locale } from '#platform/index.js';
import { verifyHubRevocationFeed, hubRevocationWatermark, requireHubRevocationContinuation } from '#engine/core/hub/index.js';
import { canSignCatalogActions } from '#engine/core/agent-catalog/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { HubClientError, hubClientCommandSchema, hubInstallCommandSchema, hubSourceSchema, type HubClientAction, type HubClientDependencies,
  type HubRefreshResult, type HubClientStore, type HubInstall, type HubReceipt, type HubSource } from './contract.js';
import { decodeHubBundle, encodeHubBundle } from './bundle.js';
import { acceptClientFeed, clientFeedKey, localRevokedKeyIds, verifyClientBundle } from './verification.js';
import { installClientBundles, retireClientInstall, verifyInstalledClientBundle } from './install.js';
const sourceCommand = hubClientCommandSchema.extend({ expectedRevision: z.number().int().positive().nullable(), publicKey: signerPublicKeySchema,
  endpoint: z.string().min(1).max(2048), local: z.boolean().default(false), label: z.string().min(1).max(256),
  trustPolicy: z.string().default(HUB_TRUST_POLICIES.addedSourceDefault) }).strict();
const packageQuery = hubClientCommandSchema.omit({ commandId: true }).extend({ packageId: z.string().min(1).max(256), version: z.string().optional() }).strict();
const ref = (principal: VerifiedPrincipal) => ({ issuer: principal.issuer, subject: principal.subject });
/** Offline client transition owner. Network fetch/serve and CLI/MCP commands are deliberately separate slices. */
export class HubClientApplication {
  constructor(private readonly deps: HubClientDependencies) {}
  private async admit(action: HubClientAction, scopeId: string, credential?: unknown) {
    const principal = await authenticate(this.deps.catalog.verifier, credential, scopeId);
    if (action.startsWith('sources.') && isAiPrincipal(principal)) throw new HubClientError('HUB_AUTHORITY_REFUSED');
    return { principal, authorization: await this.deps.authorize(action, scopeId, principal) };
  }
  private async read<T>(scopeId: string, credential: unknown, work: (store: HubClientStore, principal: VerifiedPrincipal) => Promise<T>): Promise<T> {
    const { principal } = await this.admit('inspect', scopeId, credential), store = await this.deps.openStore('read');
    try { return await work(store, principal); } finally { store.close(); }
  }
  async revocationCards(input: unknown, credential?: unknown, locale?: Locale) {
    const query = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema, after: z.number().int().safe().nonnegative().default(0),
      limit: z.number().int().min(1).max(HUB_LIMITS.searchPageMax).default(HUB_LIMITS.searchPageMax) }).strict().parse(input);
    const messages = { withdrawn: t('hub.revocation.withdrawn', {}, locale), restored: t('hub.revocation.restored', {}, locale),
      revoked: t('hub.revocation.revoked', {}, locale), yanked: t('hub.revocation.yanked', {}, locale) };
    return this.read(query.scopeId, credential, async (store, principal) => {
      if (isAiPrincipal(principal)) throw new HubClientError('HUB_AUTHORITY_REFUSED');
      return (await store.revocationCards(query.scopeId, query.after, query.limit)).map(row => ({ after: row.after,
        items: row.result.items, cards: row.result.cards.map(card => ({ ...card, message: messages[card.event] })) }));
    });
  }
  async applyRevocations(input: unknown, credential?: unknown) {
    const command = hubClientCommandSchema.extend({ feed: hubRevocationFeedSchema }).strict().parse(input);
    return this.applyFeed(command, credential, true);
  }
  private async applyFeed(command: { schemaVersion: 1; scopeId: string; commandId: string; hubId: string; feed: HubRevocationFeed }, credential: unknown, strict: boolean) {
    return this.write('refresh', command, credential, async (store, principal) => {
      const source = await this.source(store, command.scopeId, command.hubId);
      const previous = await store.feed(source.scopeId, source.hubId);
      const feed = strict ? verifyHubRevocationFeed(command.feed, { hubId: source.hubId, key: await clientFeedKey(this.deps, store, source, command.feed), nowMs: this.deps.catalog.now(), previous })
        : await acceptClientFeed(this.deps, store, source, command.feed, true);
      if (strict) { requireHubRevocationContinuation(feed, previous); await store.saveFeed(source.scopeId, feed); }
      return this.refreshState(store, source, feed, principal);
    });
  }
  /** Scheduled/offline tick: record withdrawal even when transport fails. No network path is created here. */
  async refreshRevocations(input: unknown, credential?: unknown, signal: AbortSignal = new AbortController().signal) {
    const command = hubClientCommandSchema.extend({ force: z.boolean().default(false) }).strict().parse(input);
    await this.admit('refresh', command.scopeId, credential);
    const state = await this.read(command.scopeId, credential, async store => ({ source: await this.source(store, command.scopeId, command.hubId), feed: await store.feed(command.scopeId, command.hubId) }));
    const due = command.force || !state.feed || state.feed.catchup?.complete === false || this.deps.catalog.now() >= state.feed.issuedAtMs + HUB_REVOCATION_REFRESH_MS
      || this.deps.catalog.now() >= state.feed.nextRefreshBy || this.deps.catalog.now() - state.feed.issuedAtMs >= HUB_LIMITS.feedMaxAgeMs;
    let failure: unknown;
    if (due && this.deps.fetchRevocations) {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(HUB_LIMITS.fetchTimeoutMs)]);
      try {
        let current = state.feed;
        while (true) {
          bounded.throwIfAborted();
          const pending = current?.catchup?.complete === false ? current.catchup : null;
          const next = pending?.next, now = this.deps.catalog.now();
          const cursor = next && next.nextRefreshBy > now && now - next.issuedAtMs < HUB_LIMITS.feedMaxAgeMs ? next : undefined;
          const received = await this.deps.fetchRevocations(state.source, pending?.afterSequence ?? hubRevocationWatermark(current), bounded, cursor);
          bounded.throwIfAborted();
          const feed = hubRevocationFeedSchema.parse(received);
          const result = await this.applyRevocations({ schemaVersion: command.schemaVersion, scopeId: command.scopeId, hubId: command.hubId,
            commandId: sha256(canonicalHubJson({ commandId: command.commandId, feed })), feed }, credential);
          if (!feed.catchup || feed.catchup.complete) return result;
          current = feed;
        }
      }
      catch (error) { failure = error; }
      signal.throwIfAborted();
    }
    const result = await this.write('refresh', command, credential, async (store, principal) => {
      const source = await this.source(store, command.scopeId, command.hubId), feed = await store.feed(command.scopeId, command.hubId);
      return this.refreshState(store, source, feed, principal);
    });
    if (failure) throw failure;
    return result;
  }
  private async refreshState(store: HubClientStore, source: HubSource, feed: HubRevocationFeed | null, principal: VerifiedPrincipal): Promise<HubRefreshResult> {
    const previous = await store.refreshResult(source.scopeId, source.hubId), items: HubRefreshResult['items'] = [], packages: HubRefreshResult['packages'] = [];
    const revoked = await localRevokedKeyIds(this.deps, source.scopeId);
    let verified = true;
    for (const installed of await store.installations(source.scopeId, source.hubId)) {
      let keyIds = installed.signerKeyIds;
      try { if (!keyIds) {
        const bundle = decodeHubBundle(await this.deps.artifacts.read(source.scopeId, installed.bundle));
        if (bundle.manifest.packageId !== installed.packageId || bundle.manifest.version !== installed.version || bundle.envelope.payloadDigest !== installed.manifestDigest) throw new HubClientError('HUB_STORE_CORRUPT');
        await verifyClientBundle(this.deps, store, source, bundle, principal, true);
        keyIds = bundle.envelope.signatures.map(row => row.keyId);
      } } catch { verified = false; }
      if (keyIds) packages.push({ packageId: installed.packageId, version: installed.version, signerKeyIds: [...keyIds] });
      for (const item of installed.items) items.push({ kind: item.kind, id: item.id, revision: item.revision,
        upstream: await store.upstream(source.scopeId, item.kind, item.id, item.revision, this.deps.catalog.now(), keyIds, revoked) });
      if (installed.state === 'installed' && items.slice(-installed.items.length).every(item => item.upstream === 'clear' || item.upstream === 'yanked')) {
        try { await verifyInstalledClientBundle(this.deps, store, source, installed, principal); }
        catch { verified = false; }
      }
    }
    // A bad cache cannot roll back signed security knowledge or silently restore selection.
    if (!verified) for (const item of items) if (item.upstream !== 'revoked') item.upstream = 'withdrawn';
    const cards: HubRefreshResult['cards'] = [], now = this.deps.catalog.now(), sequence = feed?.sequence ?? 0;
    for (const event of ['withdrawn', 'revoked', 'yanked'] as const) {
      const affected = items.some(item => item.upstream === event && !previous?.items.some(old => old.kind === item.kind && old.id === item.id && old.revision === item.revision && old.upstream === event));
      if (affected) cards.push({ event, hubId: source.hubId, sequence, atMs: now });
    }
    if (previous?.items.some(old => old.upstream === 'withdrawn' && items.some(item => item.kind === old.kind && item.id === old.id && item.revision === old.revision && item.upstream === 'clear')))
      cards.push({ event: 'restored', hubId: source.hubId, sequence, atMs: now });
    return { schemaVersion: 1, kind: 'revocations', hubId: source.hubId, verified, sequence, packages, items, cards };
  }
  /** Remote writes need the same active host signer and explicit grant before the governed network effect is admitted. */
  async authorizeRemote(action: 'search' | 'publish' | 'yank' | 'revoke', scopeId: string, credential?: unknown): Promise<VerifiedPrincipal> {
    const { principal } = await this.admit(action, scopeId, credential);
    if (!isAiPrincipal(principal) || action === 'search') return principal;
    const store = await this.deps.openStore('read');
    try { if (!await canSignCatalogActions(this.deps.catalog, store, principal, scopeId)) throw new HubClientError('HUB_AUTHORITY_REFUSED'); }
    finally { store.close(); }
    return principal;
  }
  async listSources(input: unknown, credential?: unknown): Promise<readonly HubSource[]> {
    const query = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema }).strict().parse(input);
    return this.read(query.scopeId, credential, store => store.sources(query.scopeId));
  }
  private async source(store: HubClientStore, scopeId: string, hubId: string) {
    const source = await store.source(scopeId, hubId);
    if (!source || source.scopeId !== scopeId || source.state !== 'active') throw new HubClientError('HUB_SOURCE_NOT_FOUND');
    return source;
  }
  private async write(action: HubClientAction, command: { scopeId: string; commandId: string; hubId: string }, credential: unknown,
    work: (store: HubClientStore, principal: VerifiedPrincipal) => Promise<HubReceipt['result']>) {
    const { principal, authorization } = await this.admit(action, command.scopeId, credential), store = await this.deps.openStore('write');
    const digest = sha256(canonicalHubJson({ action, command, principal: ref(principal) }));
    try {
      return await store.atomic(async () => {
        const replay = await store.hubReceipt(command.scopeId, command.commandId);
        // Replaying an AI command must still possess its own active action key and grant; catalog reads do not grant writes.
        if (isAiPrincipal(principal)) {
          if (!await canSignCatalogActions(this.deps.catalog, store, principal, command.scopeId)) throw new HubClientError('HUB_AUTHORITY_REFUSED');
        }
        if (replay) {
          if (replay.digest !== digest) throw new HubClientError('HUB_INSTALL_CONFLICT');
          return { replayed: true, result: replay.result };
        }
        const result = await work(store, principal), receipt = { scopeId: command.scopeId, commandId: command.commandId, digest, result };
        await store.finish(receipt, { schemaVersion: 1, scopeId: command.scopeId, eventId: this.deps.catalog.eventId(), principal: ref(principal),
          policyRevision: authorization.revision, atMs: this.deps.catalog.now(), subject: { kind: 'hub-client', action, hubId: command.hubId, commandId: command.commandId, inputDigest: digest } });
        return { replayed: false, result };
      });
    } finally { store.close(); }
  }
  async addSource(input: unknown, credential?: unknown) {
    const command = sourceCommand.parse(input);
    // BeUser E-05: a public key that is not an Ed25519 SPKI is an invalid source (typed), never an unexpected failure.
    let keyId: string; try { keyId = ed25519KeyId(Buffer.from(command.publicKey, 'base64')); } catch { throw new HubClientError('HUB_SOURCE_INVALID'); }
    if (keyId !== command.hubId) throw new HubError('HUB_IDENTITY_MISMATCH');
    try {
      if (!command.endpoint.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(command.endpoint)) {
        const url = new URL(command.endpoint);
        if (url.username || url.password || url.hash || url.protocol !== 'https:' && !(command.local && url.protocol === 'http:')) throw new Error();
      }
    } catch { throw new HubClientError('HUB_SOURCE_INVALID'); }
    return this.write('sources.add', command, credential, async (store, principal) => {
      const previous = await store.source(command.scopeId, command.hubId);
      if ((previous?.revision ?? null) !== command.expectedRevision || previous?.state === 'active') throw new HubClientError('HUB_INSTALL_CONFLICT');
      const next = hubSourceSchema.parse({ schemaVersion: 1, scopeId: command.scopeId, hubId: command.hubId, publicKey: command.publicKey, endpoint: command.endpoint,
        local: command.local, label: command.label, trustPolicy: command.trustPolicy, revision: (previous?.revision ?? 0) + 1, state: 'active', addedBy: ref(principal) });
      await store.saveSource(previous, next); return next;
    });
  }
  async removeSource(input: unknown, credential?: unknown) {
    const command = hubClientCommandSchema.extend({ expectedRevision: z.number().int().positive() }).strict().parse(input);
    return this.write('sources.remove', command, credential, async store => {
      const previous = await this.source(store, command.scopeId, command.hubId);
      if (previous.revision !== command.expectedRevision) throw new HubClientError('HUB_INSTALL_CONFLICT');
      const next = { ...previous, state: 'removed' as const, revision: previous.revision + 1 };
      await store.saveSource(previous, next); return next;
    });
  }
  private async install(input: unknown, credential: unknown, update: boolean) {
    const parsed = hubInstallCommandSchema.parse(input);
    if (Object.keys(parsed.feeds).length > HUB_LIMITS.sourcesPerScopeMax || Object.keys(parsed.workClassMapping).length > HUB_LIMITS.itemsMax * AGENT_CATALOG_LIMITS.workClassesPerAgentMax) throw new HubError('HUB_LIMIT_EXCEEDED');
    requireBoundedHubJson(parsed.feed); requireBoundedHubJson(parsed.feeds);
    const bundles = parsed.bundles.map(bytes => {
      if (!(bytes instanceof Uint8Array)) throw new HubError('HUB_PACKAGE_INVALID');
      return decodeHubBundle(bytes);
    });
    const feed = hubRevocationFeedSchema.parse(parsed.feed), feeds = Object.fromEntries(Object.entries(parsed.feeds).map(([id, value]) => [id, hubRevocationFeedSchema.parse(value)]));
    // Revocation knowledge survives a later refused/failed install; catalog writes remain all-or-nothing.
    const providedFeeds = new Map<string, HubRevocationFeed>([[parsed.hubId, feed], ...Object.entries(feeds).filter(([id]) => id !== parsed.hubId)]);
    for (const [hubId, value] of providedFeeds) {
      try { await this.applyFeed({ schemaVersion: 1, scopeId: parsed.scopeId, hubId, feed: value,
        commandId: sha256(canonicalHubJson({ commandId: parsed.commandId, hubId, phase: 'revocations' })) }, credential, false); }
      catch (error) {
        if (hubId !== parsed.hubId && error instanceof HubClientError && error.code === 'HUB_SOURCE_NOT_FOUND') throw new HubClientError('HUB_DEPENDENCY_REFUSED');
        throw error;
      }
    }
    // Receipts cover exact bytes without putting base64 payloads or filesystem paths in audit subjects.
    const command = { ...parsed, bundles: parsed.bundles.map(bytes => sha256(bytes as Uint8Array)), feed, feeds };
    return this.write(update ? 'update' : 'install', command, credential, async (store, principal) => {
      const source = await this.source(store, parsed.scopeId, parsed.hubId), verifiedFeed = await acceptClientFeed(this.deps, store, source, feed, true);
      return installClientBundles(this.deps, store, source, bundles, verifiedFeed, { ...parsed, feeds }, principal, update);
    });
  }
  installFile(input: unknown, credential?: unknown) { return this.install(input, credential, false); }
  updateFile(input: unknown, credential?: unknown) { return this.install(input, credential, true); }
  async uninstall(input: unknown, credential?: unknown) {
    const command = hubClientCommandSchema.extend({ packageId: z.string().min(1).max(256), expectedRevision: z.number().int().positive() }).strict().parse(input);
    return this.write('uninstall', command, credential, async (store, principal) => {
      const installed = await store.install(command.scopeId, command.hubId, command.packageId);
      if (!installed || installed.state !== 'installed' || installed.revision !== command.expectedRevision) throw new HubClientError('HUB_INSTALL_CONFLICT');
      await retireClientInstall(this.deps, store, installed, principal, command.commandId);
      const next = { ...installed, state: 'retired' as const, revision: installed.revision + 1 };
      await store.saveInstall(installed, next); return [next];
    });
  }
  async inspect(input: unknown, credential?: unknown): Promise<HubInstall | null> {
    const query = packageQuery.parse(input);
    return this.read(query.scopeId, credential, store => store.install(query.scopeId, query.hubId, query.packageId, query.version));
  }
  async verify(input: unknown, credential?: unknown) {
    const query = packageQuery.parse(input);
    return this.read(query.scopeId, credential, async (store, principal) => {
      const source = await this.source(store, query.scopeId, query.hubId), installed = await store.install(query.scopeId, query.hubId, query.packageId, query.version);
      if (!installed) throw new HubClientError('HUB_INSTALL_CONFLICT');
      await verifyInstalledClientBundle(this.deps, store, source, installed, principal); return installed;
    });
  }
  async exportFile(input: unknown, credential?: unknown): Promise<Uint8Array> {
    const query = packageQuery.parse(input);
    const { principal } = await this.admit('export', query.scopeId, credential), store = await this.deps.openStore('read');
    try {
      const source = await this.source(store, query.scopeId, query.hubId), installed = await store.install(query.scopeId, query.hubId, query.packageId, query.version);
      if (!installed) throw new HubClientError('HUB_INSTALL_CONFLICT');
      return encodeHubBundle(await verifyInstalledClientBundle(this.deps, store, source, installed, principal));
    } finally { store.close(); }
  }
}
