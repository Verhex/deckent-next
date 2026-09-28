import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ErrorRegistry, normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath, resolveGlobalScopePaths, type ProductLayout } from '#platform/index.js';
import { McpClientPool, type McpLaunchContext } from './pool.js';
import { MCP_CLIENT_DEFAULTS, type McpClientServerSettings, type McpClientSettings } from './pin.js';
import { expandMcpEntry, mcpRegistryPaths, mcpServerEntrySchema, MCP_SERVER_NAME, readMcpRegistryFile, resolveMcpRegistry, type ManagedMcpPolicy,
  type McpRegistryProblem, type McpScope, type McpServerEntry } from './registry.js';
import { findMcpTrust, readMcpTrust, updateMcpTrust, type McpTrustRecord } from './trust.js';

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

/** `trusted`: approved definition, launchable; `pending-approval`: never approved; `changed`: the entry changed since it was approved;
 * `invalid-launch`: its values cannot be expanded; `trust-store-unavailable`: the trust record cannot be read (nothing is trusted). */
export type McpServerStatus = 'trusted' | 'pending-approval' | 'changed' | 'invalid-launch' | 'trust-store-unavailable';
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
  const trust = await readMcpTrust(productResourcePath(context.layout, 'integrations'));
  const servers = await Promise.all(registry.servers.map(async (server): Promise<McpServerView> => {
    const record = trust.ok ? findMcpTrust(trust.state, server.scope, server.name) : null;
    const expanded = await expandMcpEntry(server.entry, server.scope, context.environment, context.secret);
    const decided: McpServerStatus = !trust.ok ? 'trust-store-unavailable' : !record ? 'pending-approval' : record.definitionDigest !== server.definitionDigest ? 'changed'
      : expanded.ok ? 'trusted' : 'invalid-launch';
    const reason = !trust.ok ? trust.reason : !expanded.ok ? expanded.reason : undefined;
    const launch = decided === 'trusted' && expanded.ok && record ? Object.freeze({ id: server.name, command: expanded.command, args: expanded.args, env: expanded.env,
      realm: server.entry.realm ?? 'prefer-sandbox', ...(server.entry.timeoutMs ? { timeoutMs: server.entry.timeoutMs } : {}), tools: record.tools }) : null;
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

/** One registry command (`deckent mcp …`). Approval shows its card through `confirm` and writes only product state. */
export type McpCommandRequest = { readonly verb: 'list' } | { readonly verb: 'get'; readonly name: string }
  | { readonly verb: 'add'; readonly scope: Exclude<McpScope, 'managed'>; readonly name: string; readonly entry: unknown }
  | { readonly verb: 'remove'; readonly name: string; readonly scope?: Exclude<McpScope, 'managed'> }
  | { readonly verb: 'approve'; readonly name: string; readonly alwaysAsk: readonly string[] };
export interface McpApprovalCard { readonly name: string; readonly scope: McpScope; readonly file: string; readonly definitionDigest: string; readonly entry: McpServerEntry;
  readonly command: string; readonly args: readonly string[]; readonly envNames: readonly string[]; readonly realm: string; readonly posture: string;
  readonly era: string; readonly protocolVersion: string | null; readonly note: string | null;
  readonly tools: readonly { readonly name: string; readonly digest: string; readonly description: string | null; readonly annotations: unknown; readonly alwaysAsk: boolean }[] }
export interface McpCommandContext extends McpRegistryContext {
  readonly sandboxes: McpLaunchContext['sandboxes'];
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly confirm: (card: McpApprovalCard) => Promise<boolean>;
  readonly limits?: { readonly resultMaxBytes?: number; readonly inputMaxBytes?: number };
  readonly now?: () => number;
}
const fail = (code: string, params: Record<string, string> = {}) => ErrorRegistry.createError(code, { params });

async function writeJson(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.mcp.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
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
      if (!server.launch) return { ...summary(server), health: server.status === 'trusted' ? 'failed' : 'not-started' };
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
  if (request.verb === 'add') {
    if (!MCP_SERVER_NAME.test(request.name)) throw fail('MCP_SERVER_NAME_INVALID', { name: request.name });
    const entry = mcpServerEntrySchema.safeParse(request.entry);
    if (!entry.success) throw fail('MCP_SERVER_ENTRY_INVALID', { name: request.name });
    const path = fileOf(view, request.scope), raw = await rawFile(path), servers = serversOf(raw, request.scope, view.projectKey, true)!;
    if (Object.hasOwn(servers, request.name)) throw fail('MCP_SERVER_EXISTS', { name: request.name, scope: request.scope });
    servers[request.name] = entry.data;
    await writeJson(path, raw, request.scope === 'project' ? 0o644 : 0o600);
    return { schemaVersion: 1, added: { name: request.name, scope: request.scope, file: path }, approval: 'pending' };
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
    const scope = holders[0]!, path = fileOf(view, scope), raw = await rawFile(path);
    delete serversOf(raw, scope, view.projectKey, false)![request.name];
    await writeJson(path, raw, scope === 'project' ? 0o644 : 0o600);
    const directory = await prepareProductDirectory(context.layout, 'integrations');
    await updateMcpTrust(directory, state => state.servers.filter(record => !(record.scope === scope && record.name === request.name)));
    return { schemaVersion: 1, removed: { name: request.name, scope, file: path } };
  }
  // approve: the server's current definition, started under its realm, listed; the owner sees the card and the pins land in product state.
  const server = find(request.name);
  if (!server) throw fail('MCP_SERVER_UNKNOWN', { name: request.name });
  const expanded = await expandMcpEntry(server.entry, server.scope, context.environment, context.secret);
  if (!expanded.ok) throw fail('MCP_SERVER_ENTRY_INVALID', { name: request.name, reason: expanded.reason });
  const launch: McpClientServerSettings = { id: server.name, command: expanded.command, args: expanded.args, env: expanded.env, realm: server.entry.realm ?? 'prefer-sandbox', tools: [] };
  const state = await probe(pool => pool.open(launch, { ...settings, servers: [launch] }, launchContext));
  if (!state.ok) throw fail(state.reason === 'sandbox-unavailable' ? 'MCP_SANDBOX_UNAVAILABLE' : 'MCP_SERVER_START_FAILED', { name: request.name, reason: state.detail ?? state.reason });
  const live = state.tools.filter(tool => tool.digest !== null);
  for (const name of request.alwaysAsk) if (!live.some(tool => tool.name === name)) throw fail('MCP_TOOL_UNKNOWN', { name });
  const card: McpApprovalCard = { name: server.name, scope: server.scope, file: server.file, definitionDigest: server.definitionDigest, entry: server.entry,
    command: expanded.command, args: expanded.args, envNames: Object.keys(expanded.env), realm: launch.realm, posture: state.posture, era: state.era,
    protocolVersion: state.protocolVersion, note: server.scope === 'project' ? 'project file: credential-shaped variables read as empty; secret references are refused' : null,
    tools: live.map(tool => ({ name: tool.name, digest: tool.digest!, description: tool.description ?? null, annotations: tool.annotations ?? null,
      alwaysAsk: request.alwaysAsk.includes(tool.name) })) };
  if (!await context.confirm(card)) return { schemaVersion: 1, approved: false, name: server.name };
  const record: McpTrustRecord = { scope: server.scope, name: server.name, definitionDigest: server.definitionDigest,
    tools: card.tools.map(tool => ({ name: tool.name, digest: tool.digest, alwaysAsk: tool.alwaysAsk })), approvedAtMs: (context.now ?? Date.now)(),
    principal: { issuer: context.principal.issuer, subject: context.principal.subject } };
  const directory = await prepareProductDirectory(context.layout, 'integrations');
  await updateMcpTrust(directory, current => [...current.servers.filter(entry => !(entry.scope === record.scope && entry.name === record.name)), record]);
  return { schemaVersion: 1, approved: true, name: server.name, scope: server.scope, pinnedTools: record.tools.length };
}
