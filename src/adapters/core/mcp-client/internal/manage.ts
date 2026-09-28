import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ErrorRegistry, normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath, resolveGlobalScopePaths, withConfigWriteLock,
  SystemTrustedClock, type ProductLayout } from '#platform/index.js';
import { McpClientPool, type McpLaunchContext } from './pool.js';
import { MCP_CLIENT_DEFAULTS, type McpClientServerSettings, type McpClientSettings } from './pin.js';
import { decideMcpTrust, mcpTrustApprovalAsker, mcpTrustAuditWriter, recordMcpTrust, type McpTrustAsk, type McpTrustAudit, type McpTrustContext } from './approve.js';
import { openMcpAgentTools, type McpOfferedTool } from './agent.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { expandMcpEntry, mcpRegistryPaths, mcpServerEntrySchema, MCP_SERVER_NAME, readMcpRegistryFile, resolveMcpRegistry, type ManagedMcpPolicy,
  type McpRegistryProblem, type McpScope, type McpServerEntry } from './registry.js';
import { findMcpTrust, readMcpTrust, type McpTrustRecord } from './trust.js';

/** What the registry needs from its host: the project, its layout (trust lives in the data root), the environment and secret resolver of the
 * launch, and the company policy (none in Core yet). */
export interface McpRegistryContext {
  readonly projectRoot: string;
  readonly layout: ProductLayout;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly secret: (name: string) => Promise<string | undefined>;
  readonly managed?: ManagedMcpPolicy | null;
}
/** The Deckent global root that holds the personal registry (`DECKENT_GLOBAL_HOME`, else the platform convention). */
export const mcpGlobalRoot = (environment: Readonly<Record<string, string | undefined>>) =>
  resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, environment), environment).configDir;

/** `trusted`: approved definition, launchable; `pending-approval`: never decided; `changed`: the entry changed since it was decided; `declined`:
 * the owner said no to this definition; `invalid-launch`: its values cannot be expanded; `trust-store-unavailable`: a trust record cannot be read. */
export type McpServerStatus = 'trusted' | 'pending-approval' | 'changed' | 'declined' | 'invalid-launch' | 'trust-store-unavailable';
/** Where the trust record of a scope lives: user trust beside the personal registry (every project), project and local in the data root. */
export const mcpTrustDirectory = (scope: McpScope, layout: ProductLayout, environment: Readonly<Record<string, string | undefined>>) =>
  scope === 'user' ? mcpGlobalRoot(environment) : productResourcePath(layout, 'integrations');
export interface McpServerView {
  readonly name: string; readonly scope: McpScope; readonly file: string; readonly shadows: readonly McpScope[]; readonly definitionDigest: string;
  readonly entry: McpServerEntry; readonly status: McpServerStatus; readonly reason?: string; readonly trust: McpTrustRecord | null;
  /** The launch values, for a server that may start (trusted, expandable); never for a pending one. */
  readonly launch: McpClientServerSettings | null;
}
export interface McpRegistryView { readonly projectKey: string; readonly paths: { readonly project: string; readonly personal: string };
  readonly servers: readonly McpServerView[]; readonly problems: readonly McpRegistryProblem[] }

/** Reads both registry files and the trust record and decides each effective server's status. Starts nothing. */
export async function loadMcpRegistry(context: McpRegistryContext): Promise<McpRegistryView> {
  const projectKey = await realpath(context.projectRoot).catch(() => context.projectRoot);
  const paths = mcpRegistryPaths(projectKey, mcpGlobalRoot(context.environment));
  const [project, personal] = await Promise.all([readMcpRegistryFile(paths.project, 'project'), readMcpRegistryFile(paths.personal, 'personal', projectKey)]);
  const problems: McpRegistryProblem[] = [];
  if (!project.ok) problems.push({ name: null, scope: 'project', file: paths.project, reason: project.reason });
  if (!personal.ok) problems.push({ name: null, scope: 'user', file: paths.personal, reason: personal.reason });
  const registry = resolveMcpRegistry([{ scope: 'local', file: paths.personal, servers: personal.ok ? personal.local : {} },
    { scope: 'project', file: paths.project, servers: project.ok ? project.user : {} }, { scope: 'user', file: paths.personal, servers: personal.ok ? personal.user : {} }],
  context.managed ?? null);
  const [projectTrust, userTrust] = await Promise.all([readMcpTrust(mcpTrustDirectory('project', context.layout, context.environment)),
    readMcpTrust(mcpTrustDirectory('user', context.layout, context.environment))]);
  const servers = await Promise.all(registry.servers.map(async (server): Promise<McpServerView> => {
    const trust = server.scope === 'user' ? userTrust : projectTrust;
    const record = trust.ok ? findMcpTrust(trust.state, server.scope, server.name) : null;
    const expanded = await expandMcpEntry(server.entry, server.scope, context.environment, context.secret);
    const decided: McpServerStatus = !trust.ok ? 'trust-store-unavailable' : !record ? 'pending-approval' : record.definitionDigest !== server.definitionDigest ? 'changed'
      : record.decision === 'declined' ? 'declined' : expanded.ok ? 'trusted' : 'invalid-launch';
    const reason = !trust.ok ? trust.reason : !expanded.ok ? expanded.reason : undefined;
    const launch = decided === 'trusted' && expanded.ok && record ? Object.freeze({ id: server.name, command: expanded.command, args: expanded.args, env: expanded.env,
      realm: server.entry.realm ?? 'prefer-sandbox', ...(server.entry.timeoutMs ? { timeoutMs: server.entry.timeoutMs } : {}), tools: record.tools,
      label: [server.entry.command, ...(server.entry.args ?? [])].join(' '), generation: record.reconnect }) : null;
    return Object.freeze({ name: server.name, scope: server.scope, file: server.file, shadows: server.shadows, definitionDigest: server.definitionDigest, entry: server.entry,
      status: decided, ...(reason ? { reason } : {}), trust: record, launch });
  }));
  return { projectKey, paths, servers, problems: [...problems, ...registry.problems] };
}
/** The client settings of the trusted servers (null when there is none): code defaults, the agent's result bound and the MCP message bound. */
export function mcpClientSettings(view: McpRegistryView, limits: { readonly resultMaxBytes?: number; readonly inputMaxBytes?: number }): McpClientSettings | null {
  const servers = view.servers.flatMap(server => server.launch ? [server.launch] : []);
  return servers.length ? Object.freeze({ ...MCP_CLIENT_DEFAULTS, ...(limits.resultMaxBytes ? { resultMaxBytes: limits.resultMaxBytes } : {}),
    ...(limits.inputMaxBytes ? { inputMaxBytes: limits.inputMaxBytes } : {}), servers: Object.freeze(servers) }) : null;
}

/** One registry command (`deckent mcp …`, `/mcp`). Trust decisions show their cards through `ask` and write only product state, audited. */
export type McpCommandRequest = { readonly verb: 'list'; readonly health?: boolean } | { readonly verb: 'get'; readonly name: string }
  | { readonly verb: 'add'; readonly scope: Exclude<McpScope, 'managed'>; readonly name: string; readonly entry: unknown; readonly approve?: boolean }
  | { readonly verb: 'remove'; readonly name: string; readonly scope?: Exclude<McpScope, 'managed'> }
  | { readonly verb: 'approve'; readonly name: string; readonly alwaysAsk: readonly string[] }
  | { readonly verb: 'reset' | 'reconnect'; readonly name: string };
export interface McpCommandContext extends McpRegistryContext {
  readonly sandboxes: McpLaunchContext['sandboxes'];
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly ask: McpTrustAsk;
  readonly audit: McpTrustAudit;
  readonly limits?: { readonly resultMaxBytes?: number; readonly inputMaxBytes?: number };
  readonly now?: () => number;
}
/** The trust context of a registry context (both trust places prepared for writing on demand). */
export function mcpTrustContext(context: McpRegistryContext & { readonly sandboxes: McpLaunchContext['sandboxes']; readonly principal: McpTrustContext['principal'];
  readonly audit: McpTrustAudit; readonly inputMaxBytes?: number; readonly now?: () => number }, cwd: string): McpTrustContext {
  return { environment: context.environment, secret: context.secret, cwd, sandboxes: context.sandboxes, principal: context.principal, audit: context.audit,
    ...(context.inputMaxBytes ? { inputMaxBytes: context.inputMaxBytes } : {}), ...(context.now ? { now: context.now } : {}),
    directory: async scope => { if (scope !== 'user') return prepareProductDirectory(context.layout, 'integrations');
      const root = mcpGlobalRoot(context.environment); await mkdir(root, { recursive: true, mode: 0o700 }); return root; } };
}
const fail = (code: string, params: Record<string, string> = {}) => ErrorRegistry.createError(code, { params });

/** Changes one registry file under its config write lock: read, change, write a temporary with the scope's mode, rename. */
async function mutateRegistry<T>(path: string, mode: number, change: (raw: Record<string, unknown>) => T): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withConfigWriteLock(path, async () => {
    const raw = await rawFile(path), result = change(raw);
    const temporary = join(dirname(path), `.mcp.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', mode);
    try { await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
    return result;
  }, 10_000);
}
async function rawFile(path: string): Promise<Record<string, unknown>> {
  try { const value = JSON.parse(await readFile(path, 'utf8')) as unknown; if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; }
  catch (error) { if ((error as { code?: unknown })?.code === 'ENOENT') return {}; }
  throw fail('MCP_REGISTRY_FILE_INVALID', { path });
}
/** The `mcpServers` object of one scope inside a raw file; created on the way when `create`, else null when absent. */
function serversOf(raw: Record<string, unknown>, scope: Exclude<McpScope, 'managed'>, projectKey: string, create: boolean): Record<string, unknown> | null {
  const child = (holder: Record<string, unknown>, key: string): Record<string, unknown> | null => {
    const value = holder[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (value !== undefined || !create) return null;
    const made: Record<string, unknown> = {}; holder[key] = made; return made;
  };
  const holder = scope === 'local' ? (() => { const projects = child(raw, 'projects'); return projects ? child(projects, projectKey) : null; })() : raw;
  return holder ? child(holder, 'mcpServers') : null;
}
const fileOf = (view: McpRegistryView, scope: Exclude<McpScope, 'managed'>) => scope === 'project' ? view.paths.project : view.paths.personal;

/** Runs one registry command. Nothing here starts a server except `list` (trusted ones, for health) and `approve` (to read the tools it pins). */
export async function runMcpCommand(request: McpCommandRequest, context: McpCommandContext): Promise<unknown> {
  const view = await loadMcpRegistry(context), find = (name: string) => view.servers.find(server => server.name === name) ?? null;
  const summary = (server: McpServerView) => ({ name: server.name, scope: server.scope, file: server.file, status: server.status, ...(server.reason ? { reason: server.reason } : {}),
    shadows: server.shadows, realm: server.entry.realm ?? 'prefer-sandbox', command: server.entry.command, args: server.entry.args ?? [], envNames: Object.keys(server.entry.env ?? {}),
    definitionDigest: server.definitionDigest, pinnedTools: server.trust?.tools.length ?? 0 });
  const settings = { ...MCP_CLIENT_DEFAULTS, ...(context.limits?.resultMaxBytes ? { resultMaxBytes: context.limits.resultMaxBytes } : {}),
    ...(context.limits?.inputMaxBytes ? { inputMaxBytes: context.limits.inputMaxBytes } : {}) };
  const launchContext = { cwd: view.projectKey, environment: context.environment, sandboxes: context.sandboxes };
  const probe = async <T>(work: (pool: McpClientPool) => Promise<T>): Promise<T> => {
    const controller = new AbortController(), pool = new McpClientPool(controller.signal);
    try { return await work(pool); } finally { controller.abort(); await pool.close(); }
  };
  if (request.verb === 'list') {
    const servers = await Promise.all(view.servers.map(async server => {
      if (!server.launch || request.health === false) return { ...summary(server), health: !server.launch && server.status === 'trusted' ? 'failed' : 'not-started' };
      const launch = server.launch;
      const state = await probe(pool => pool.open(launch, { ...settings, servers: [launch] }, launchContext));
      return { ...summary(server), health: state.ok ? (state.tools.every(tool => tool.status !== 'drifted' && tool.status !== 'missing') ? 'connected' : 'tools-changed') : 'failed',
        ...(state.ok ? { era: state.era, tools: state.tools.map(verdict => Object.fromEntries(Object.entries(verdict).filter(([key]) => key !== 'spec'))) }
          : { failure: state.reason }) };
    }));
    return { schemaVersion: 1, servers, problems: view.problems };
  }
  if (request.verb === 'get') {
    const server = find(request.name);
    if (!server) throw fail('MCP_SERVER_UNKNOWN', { name: request.name });
    return { schemaVersion: 1, server: { ...summary(server), entry: server.entry, trust: server.trust } };
  }
  const trustContext = mcpTrustContext({ ...context, ...(context.limits?.inputMaxBytes ? { inputMaxBytes: context.limits.inputMaxBytes } : {}) }, view.projectKey);
  if (request.verb === 'add') {
    if (!MCP_SERVER_NAME.test(request.name)) throw fail('MCP_SERVER_NAME_INVALID', { name: request.name });
    const entry = mcpServerEntrySchema.safeParse(request.entry);
    if (!entry.success) throw fail('MCP_SERVER_ENTRY_INVALID', { name: request.name, reason: (entry.error.issues[0]?.message ?? 'schema').slice(0, 200) });
    const path = fileOf(view, request.scope);
    await mutateRegistry(path, request.scope === 'project' ? 0o644 : 0o600, raw => {
      const servers = serversOf(raw, request.scope, view.projectKey, true)!;
      if (Object.hasOwn(servers, request.name)) throw fail('MCP_SERVER_EXISTS', { name: request.name, scope: request.scope });
      servers[request.name] = entry.data;
    });
    // Owner 2026-09-28: adding a personal (local/user) server is its trust decision, in one step; a project entry is asked on first use.
    if (request.scope === 'project' || request.approve === false) return { schemaVersion: 1, added: { name: request.name, scope: request.scope, file: path }, trust: 'pending' };
    const added = (await loadMcpRegistry(context)).servers.find(server => server.name === request.name && server.scope === request.scope);
    if (!added) return { schemaVersion: 1, added: { name: request.name, scope: request.scope, file: path }, trust: 'shadowed' };
    const decided = await decideMcpTrust(added, trustContext, context.ask);
    return { schemaVersion: 1, added: { name: request.name, scope: request.scope, file: path }, trust: decided.decision, pinnedTools: decided.pinned };
  }
  if (request.verb === 'remove') {
    const holders: Exclude<McpScope, 'managed'>[] = [];
    for (const scope of ['local', 'project', 'user'] as const) {
      if (request.scope && request.scope !== scope) continue;
      const servers = serversOf(await rawFile(fileOf(view, scope)), scope, view.projectKey, false);
      if (servers && Object.hasOwn(servers, request.name)) holders.push(scope);
    }
    if (!holders.length) throw fail('MCP_SERVER_UNKNOWN', { name: request.name });
    if (holders.length > 1) throw fail('MCP_SERVER_SCOPE_AMBIGUOUS', { name: request.name, scopes: holders.join(',') });
    const scope = holders[0]!, path = fileOf(view, scope), held = view.servers.find(server => server.name === request.name && server.scope === scope);
    await mutateRegistry(path, scope === 'project' ? 0o644 : 0o600, raw => { delete serversOf(raw, scope, view.projectKey, false)![request.name]; });
    await recordMcpTrust({ name: request.name, scope, definitionDigest: held?.definitionDigest ?? '0'.repeat(64) }, trustContext, 'revoke', () => null);
    return { schemaVersion: 1, removed: { name: request.name, scope, file: path } };
  }
  const server = find(request.name);
  if (!server) throw fail('MCP_SERVER_UNKNOWN', { name: request.name });
  if (request.verb === 'reset') {
    // `/mcp approve`: forget this server's decision, so its next use asks again with the cards (a decline is not final).
    await recordMcpTrust(server, trustContext, 'reset', () => null);
    return { schemaVersion: 1, reset: { name: server.name, scope: server.scope } };
  }
  if (request.verb === 'reconnect') {
    if (!server.trust || server.status !== 'trusted') throw fail('MCP_SERVER_NOT_TRUSTED', { name: server.name });
    await recordMcpTrust(server, trustContext, 'reconnect', current => current && { ...current, reconnect: current.reconnect + 1 });
    return { schemaVersion: 1, reconnect: { name: server.name, scope: server.scope } };
  }
  // approve: the launch card, then (only after yes) the server started in its realm and the tools card; the answers land in product state.
  const decided = await decideMcpTrust(server, trustContext, context.ask, { alwaysAsk: request.verb === 'approve' ? request.alwaysAsk : [] });
  return { schemaVersion: 1, approved: decided.decision === 'trusted', name: server.name, scope: server.scope, pinnedTools: decided.pinned };
}

/**
 * One turn's MCP servers (MCP-CLIENT): servers nobody decided on (pending or changed) get their first-use trust cards on the turn's approval
 * path (owner 2026-09-28), started in the service's pool only after the launch card's yes; then the trusted servers' pinned, matching tools.
 * A card without an answer records nothing; a server that fails to start is simply not offered.
 */
export async function openTurnMcp(input: { readonly registry: McpRegistryContext; readonly pool: McpClientPool; readonly cwd: string; readonly sandboxes: McpLaunchContext['sandboxes'];
  readonly principal: { readonly id: string; readonly issuer: string; readonly subject: string }; readonly sqlite: Parameters<typeof mcpTrustAuditWriter>[0]['sqlite'];
  readonly keyFile: string; readonly requestTtlMs: number; readonly inputMaxBytes: number; readonly resultMaxBytes: number; readonly scopeId: string; readonly turnId: string;
  readonly signal: AbortSignal; readonly emit: Parameters<typeof mcpTrustApprovalAsker>[0]['emit']; readonly ledgerPath: () => Promise<string>;
  readonly policyRevision: () => Promise<string> }): Promise<{ readonly settings: McpClientSettings; readonly offered: ReadonlyMap<string, McpOfferedTool> } | null> {
  const { registry, pool, principal, scopeId } = input;
  let view = await loadMcpRegistry(registry);
  const undecided = view.servers.filter(server => server.status === 'pending-approval' || server.status === 'changed');
  if (undecided.length) {
    const policyRevision = await input.policyRevision(), layout = registry.layout;
    const trust = mcpTrustContext({ ...registry, sandboxes: input.sandboxes, principal, inputMaxBytes: input.inputMaxBytes,
      audit: mcpTrustAuditWriter({ layout, sqlite: input.sqlite, keyFile: input.keyFile, scopeId, principal, policyRevision }) }, input.cwd);
    const ask = mcpTrustApprovalAsker({ ledgerPath: input.ledgerPath, sqlite: input.sqlite, integrity: () => openLocalIntegrityAuthority(layout, input.keyFile, true),
      clock: new SystemTrustedClock(), scopeId, turnId: input.turnId, requester: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, policyRevision,
      ttlMs: input.requestTtlMs, signal: input.signal, emit: input.emit });
    for (const server of undecided) await decideMcpTrust(server, trust, ask, { pool }).catch(() => undefined);
    view = await loadMcpRegistry(registry);
  }
  const settings = mcpClientSettings(view, { resultMaxBytes: input.resultMaxBytes, inputMaxBytes: input.inputMaxBytes });
  const offered = settings ? await openMcpAgentTools(pool, settings, { cwd: input.cwd, environment: registry.environment, sandboxes: input.sandboxes }) : null;
  return settings && offered?.size ? { settings, offered } : null;
}
