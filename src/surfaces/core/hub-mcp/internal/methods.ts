import { executeHubService } from './service-methods.js';
import { ProtocolError, type Server, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { HUB_LIMITS, canonicalHubJson, hubPackageIdSchema, hubVersionSchema, identitySchema, requireBoundedHubJson } from '#domain/index.js';
import { HubClientError, HubModeratedApplication, HubRevocationApplication, decodeHubBundle, encodeHubBundle, type HubServerApplication, type HubServerContext } from '#engine/index.js';
import { t, ErrorRegistry, type Locale } from '#platform/index.js';

export interface HubMcpOptions {
  /** Installation registry value; H9 seeds the owner-selected extension identity. */
  readonly extensionId: string;
  readonly locale?: Locale;
  /** H5 owns feed/yank/revoke transitions, including signatures and authority. */
  readonly lifecycle?: Readonly<Partial<Record<'yank' | 'revoke' | 'feed', (context: HubServerContext, input: unknown, signal: AbortSignal) => Promise<unknown>>>>;
}
const meta = { _meta: z.record(z.unknown()).optional() };
const query = z.object({ packageId: hubPackageIdSchema, version: hubVersionSchema, ...meta }).strict();
const search = z.object({ after: z.string().max(HUB_LIMITS.packageMaxBytes).default(''), limit: z.number().int().min(1).max(HUB_LIMITS.searchPageMax).default(HUB_LIMITS.searchPageMax), ...meta }).strict();
const publish = z.object({ bundle: z.unknown(), ...meta }).strict();
const review = query.extend({ signature: z.unknown() });
const agent = query.extend({ agentId: identitySchema });
const lifecycle = z.object({ input: z.unknown(), ...meta }).strict();
const cache = { resultType: 'complete' as const, ttlMs: 0, cacheScope: 'private' as const };
type Entry = { readonly schema: z.ZodTypeAny; readonly run: (input: unknown, request: ServerContext) => Promise<unknown> };

export function registerHubMethods(server: Server, app: HubServerApplication, context: (request: ServerContext) => HubServerContext, options: HubMcpOptions) {
  if (!/^[a-z0-9.-]+\/[a-z0-9-]+$/.test(options.extensionId) || options.extensionId === 'io.modelcontextprotocol/skills') throw new HubClientError('HUB_SOURCE_INVALID');
  const methods: Record<string, Entry> = {
    'hub/packages/list': { schema: search, run: async (input, request) => {
      const p = search.parse(input), rows = await app.search(context(request), p.after, p.limit), last = rows.at(-1);
      const more = last && (await app.search(context(request), last.key, 1)).length > 0;
      return { hubId: app.ports.hubId, packages: rows, ...(more ? { nextCursor: last.key } : {}) };
    } },
    'hub/packages/get': { schema: query, run: async (input, request) => {
      const p = query.parse(input), ctx = context(request), row = await app.inspect(ctx, p.packageId, p.version);
      const files = await Promise.all(row.files.map(async file => ({ path: file.path, bytes: await app.readFile(ctx, p.packageId, p.version, file.path) })));
      return { hubId: app.ports.hubId, ...(app instanceof HubModeratedApplication ? { evidence: await app.evidence(ctx, p.packageId, p.version) } : {}), revocationState: await app.revocationState(ctx, p.packageId, p.version), bundle: JSON.parse(Buffer.from(encodeHubBundle({ manifest: row.manifest, envelope: row.envelope, files })).toString('utf8')) as unknown };
    } },
    'hub/agents/get': { schema: agent, run: async (input, request) => {
      const p = agent.parse(input), row = await app.inspect(context(request), p.packageId, p.version);
      const item = row.manifest.items.find(item => item.kind === 'agent' && item.agentId === p.agentId);
      if (!item) throw new ProtocolError(-32602, t('error.HUB_RESOURCE_UNKNOWN', {}, options.locale));
      return { hubId: app.ports.hubId, revocationState: await app.revocationState(context(request), p.packageId, p.version), agent: item, manifest: row.manifest, envelope: row.envelope };
    } },
  };
  const tools: Record<string, Entry & { readonly description: string }> = {
    hub_publish: { schema: publish, description: t('hub.tool.publish', {}, options.locale), run: async (input, request) => {
      const p = publish.parse(input); requireBoundedHubJson(p.bundle);
      const bundle = decodeHubBundle(Buffer.from(canonicalHubJson(p.bundle)));
      return app.publish(context(request), bundle.manifest, bundle.envelope, bundle.files, request.mcpReq.signal);
    } },
    hub_review: { schema: review, description: t('hub.tool.review', {}, options.locale), run: async (input, request) => {
      const p = review.parse(input); return app.review(context(request), p.packageId, p.version, p.signature, request.mcpReq.signal);
    } },
  };
  if (app instanceof HubModeratedApplication) {
    methods['hub/moderators/get'] = { schema: z.object(meta).strict(), run: (_input, request) => { void _input; return app.moderatorRoster(context(request)); } };
    methods['hub/moderation-log/get'] = { schema: z.object({ after: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(HUB_LIMITS.searchPageMax).default(HUB_LIMITS.searchPageMax), ...meta }).strict(),
      run: (input, request) => { const p = z.object({ after: z.number(), limit: z.number() }).parse(input); return app.publicLog(context(request), p.after, p.limit); } };
    tools.hub_service = { schema: z.object({ operation: z.string(), input: z.unknown() }).strict(), description: t('hub.service.command', {}, options.locale),
      run: (input, request) => { const p = z.object({ operation: z.string(), input: z.unknown() }).strict().parse(input);
        return executeHubService(app, context(request), p.operation, p.input, request.mcpReq.signal); } };
  }
  const invoke = async (entry: Entry, input: unknown, request: ServerContext) => {
    try { request.mcpReq.signal.throwIfAborted(); return await entry.run(input, request); }
    catch (error) {
      if (error instanceof z.ZodError) throw new ProtocolError(-32602, t('error.HUB_PACKAGE_INVALID', {}, options.locale));
      if (error instanceof ProtocolError) throw error;
      // Do not expose verifier, storage or secret-scanner diagnostics to a remote caller.
      const code = (error as { code?: unknown })?.code;
      throw new ProtocolError(-32603, (typeof code === 'string' && code.startsWith('HUB_') ? ErrorRegistry.get(code, options.locale)?.message : undefined) ?? t('error.HUB_SERVER_DENIED', {}, options.locale));
    }
  };
  const bindLifecycle = (name: 'yank' | 'revoke' | 'feed'): Entry => ({ schema: lifecycle,
    run: (input, request) => options.lifecycle![name]!(context(request), lifecycle.parse(input).input, request.mcpReq.signal) });
  const revocations = app instanceof HubRevocationApplication ? app : new HubRevocationApplication(app.ports);
  options = { ...options, lifecycle: { yank: (ctx, input, signal) => revocations.withdraw(ctx, 'yank', input, signal),
    revoke: (ctx, input, signal) => revocations.withdraw(ctx, 'revoke', input, signal), feed: (ctx, input, signal) => revocations.revocations(ctx, input, signal), ...options.lifecycle } };
  if (options.lifecycle?.yank) tools.hub_yank = { ...bindLifecycle('yank'), description: t('hub.tool.yank', {}, options.locale) };
  if (options.lifecycle?.revoke) tools.hub_revoke = { ...bindLifecycle('revoke'), description: t('hub.tool.revoke', {}, options.locale) };
  if (options.lifecycle?.feed) methods['hub/revocations/get'] = bindLifecycle('feed');
  for (const [method, entry] of Object.entries(methods)) server.setRequestHandler(method, { params: entry.schema }, async (p, request) => {
    if (!server.getClientCapabilities()?.extensions?.[options.extensionId]) throw new ProtocolError(-32601, t('error.HUB_RESOURCE_UNKNOWN', {}, options.locale));
    return { ...cache, value: await invoke(entry, p, request) };
  });
  server.setRequestHandler('tools/list', async () => ({ ...cache, tools: Object.entries(tools).map(([name, entry]) => {
    const schema: Record<string, unknown> = zodToJsonSchema(entry.schema, { $refStrategy: 'none' });
    return { name, description: entry.description, inputSchema: { ...schema, type: 'object' as const }, annotations: { readOnlyHint: false, openWorldHint: true } };
  }) }));
  server.setRequestHandler('tools/call', async (request, extra) => {
    const entry = Object.hasOwn(tools, request.params.name) ? tools[request.params.name] : undefined;
    if (!entry) throw new ProtocolError(-32602, t('error.HUB_RESOURCE_UNKNOWN', {}, options.locale));
    return { ...cache, content: [{ type: 'text', text: canonicalHubJson(await invoke(entry, request.params.arguments ?? {}, extra)) }] };
  });
}
