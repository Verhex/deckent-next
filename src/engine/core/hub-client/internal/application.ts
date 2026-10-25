import { z } from 'zod';
import { AGENT_CATALOG_LIMITS, HUB_LIMITS, HUB_TRUST_POLICIES, HubError, requireBoundedHubJson, canonicalHubJson, identitySchema, isAiPrincipal, signerPublicKeySchema, hubRevocationFeedSchema,
  type VerifiedPrincipal } from '#domain/index.js';
import { ed25519KeyId, sha256 } from '#platform/index.js';
import { canSignCatalogActions } from '#engine/core/agent-catalog/index.js';
import { authenticate } from '#engine/core/authentication/index.js';
import { HubClientError, hubClientCommandSchema, hubInstallCommandSchema, hubSourceSchema, type HubClientAction, type HubClientDependencies,
  type HubClientStore, type HubInstall, type HubReceipt, type HubSource } from './contract.js';
import { decodeHubBundle, encodeHubBundle } from './bundle.js';
import { acceptClientFeed } from './verification.js';
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
    if (ed25519KeyId(Buffer.from(command.publicKey, 'base64')) !== command.hubId) throw new HubError('HUB_IDENTITY_MISMATCH');
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
    // Receipts cover exact bytes without putting base64 payloads or filesystem paths in audit subjects.
    const command = { ...parsed, bundles: parsed.bundles.map(bytes => sha256(bytes as Uint8Array)), feed, feeds };
    return this.write(update ? 'update' : 'install', command, credential, async (store, principal) => {
      const source = await this.source(store, parsed.scopeId, parsed.hubId), verifiedFeed = await acceptClientFeed(store, source, feed, this.deps.catalog.now(), true);
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
