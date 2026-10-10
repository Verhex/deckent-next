import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ErrorRegistry, normalizeGlobalScopePlatform, prepareProductDirectory, productResourcePath, resolveGlobalScopePaths, withConfigWriteLock,
  SystemTrustedClock, type Locale, type ProductLayout } from '#platform/index.js';
import { displayMcpDiagnosis } from './diagnose.js';
import { findMcpStartFailure, mcpStartFailedNotice, mcpStartFailureOf, mcpToolsChangedRecord, mcpWithheldTools, readMcpStartFailures, updateMcpStartFailure, type McpStartFailure, type McpStartNotice,
  type McpStartNoticeRenderer } from './failures.js';
import { MCP_SERVER_HOMES_DIR, McpClientPool, type McpLaunchContext, type McpPoolView, type McpSendRefusal, type McpServerOpen } from './pool.js';
import { MCP_CLIENT_DEFAULTS, type McpClientServerSettings, type McpClientSettings, type McpTrustBinding } from './pin.js';
import { decideMcpTrust, mcpTrustApprovalAsker, mcpTrustAuditWriter, recordMcpTrust, type McpToolGrantPort, type McpTrustAsk, type McpTrustAudit, type McpTrustContext } from './approve.js';
import { openMcpAgentTools, type McpOfferedTool } from './agent.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { expandMcpEntry, isMcpHttpEntry, mcpDefinitionDigest, mcpEntryDisplay, mcpLaunchValues, mcpEndpointRefusal, mcpEntryRedacted, MCP_DEFAULT_REALM, MCP_SCOPE_PRECEDENCE, mcpRegistryPaths, mcpServerEntrySchema, MCP_SERVER_NAME, readMcpRegistryFile,
  resolveMcpRegistry, type ManagedMcpPolicy, type McpRegistryProblem, type McpScope, type McpServerEntry } from './registry.js';
import { findMcpTrust, MCP_TRUST_FILE, readMcpTrust, type McpTrustRecord } from './trust.js';
import { modelTextPrefix } from '#domain/index.js';
import type { AgentToolApprovalFacts } from '#engine/index.js';

/** What the registry needs from its host: the project, its layout (trust lives in the data root), the environment and secret resolver of the
 * launch, and the company policy (none in Core yet). */
export interface McpRegistryContext {
  readonly projectRoot: string;
  readonly layout: ProductLayout;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly secret: (name: string) => Promise<string | undefined>;
  readonly managed?: ManagedMcpPolicy | null;
  /** K1: the host's tool-grant port (bound to the approving person and the request's scope); absent: trust without a policy grant. */
  readonly grants?: McpToolGrantPort;
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
    const shown = mcpEntryDisplay(server.entry);
    const launch = decided === 'trusted' && expanded.ok && record ? Object.freeze({ id: server.name, ...mcpLaunchValues(server.entry, expanded),
      ...(server.entry.timeoutMs ? { timeoutMs: server.entry.timeoutMs } : {}), tools: record.tools, label: [shown.command, ...shown.args].join(' '), generation: record.reconnect,
      binding: Object.freeze({ scope: server.scope, definitionDigest: server.definitionDigest }) }) : null;
    return Object.freeze({ name: server.name, scope: server.scope, file: server.file, shadows: server.shadows, definitionDigest: server.definitionDigest, entry: server.entry,
      status: decided, ...(reason ? { reason } : {}), trust: record, launch });
  }));
  return { projectKey, paths, servers, problems: [...problems, ...registry.problems] };
}
/**
 * The send authority of the turn's MCP calls (MCP-REVOKE, Astra 2174–2176): a one-shot approval of a call is not the server's trust. Right
 * before a call is handed to the SDK — after its approval wait — the current registry files and the scope's trust record are read again
 * (user trust in the global root, project and local trust in the data root) and the call is admitted only while the server is still
 * trusted as exactly the scope and definition the turn offered it under and the tool's pin is still that digest. The check runs under the
 * trust record's config write lock, the lock `reset`/`remove`/`approve` take to change it: a trust change that completed before the check is
 * always seen; a later change can race the actual send (the lock is released before the SDK sends; a revocation never recalls a call
 * already sent). Fails closed.
 */
export function mcpSendAuthority(registry: McpRegistryContext) {
  return async (call: { readonly server: string; readonly tool: string; readonly digest: string; readonly binding: McpTrustBinding | null }): Promise<McpSendRefusal | null> => {
    const { binding } = call;
    if (!binding) return 'trust-revoked';
    const directory = mcpTrustDirectory(binding.scope, registry.layout, registry.environment);
    // No trust directory: nothing is trusted in this scope (and the lock does not create one).
    if (!(await lstat(directory).then(info => info.isDirectory(), () => false))) return 'trust-revoked';
    const check = async (): Promise<McpSendRefusal | null> => {
      const server = (await loadMcpRegistry(registry)).servers.find(entry => entry.name === call.server);
      if (!server) return 'trust-revoked';
      if (server.status === 'trust-store-unavailable') return 'trust-unavailable';
      if (server.scope !== binding.scope || server.definitionDigest !== binding.definitionDigest) return 'definition-changed';
      if (server.status === 'pending-approval' || server.status === 'declined') return 'trust-revoked';
      if (server.status !== 'trusted' || !server.trust) return 'definition-changed';
      return server.trust.tools.some(pin => pin.name === call.tool && pin.digest === call.digest) ? null : 'pin-revoked';
    };
    try { return await withConfigWriteLock(join(directory, MCP_TRUST_FILE), check, 10_000); }
    catch { return 'trust-unavailable'; }
  };
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
  | { readonly verb: 'reset' | 'reconnect' | 'revoke'; readonly name: string };
export interface McpCommandContext extends McpRegistryContext {
  readonly sandboxes: McpLaunchContext['sandboxes'];
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly ask: McpTrustAsk;
  readonly audit: McpTrustAudit;
  readonly limits?: { readonly resultMaxBytes?: number; readonly inputMaxBytes?: number };
  readonly now?: () => number;
  /** Renders a recorded start failure (`lastStart.text`) in the locale of the calling surface. */
  readonly describeNotice: McpStartNoticeRenderer;
  /** The Deckent scope of the command (the `sandbox-net` HOME is its own per scope; Astra 2444 R2). */
  readonly scopeId?: string;
}
/** K4: where the `sandbox-net` servers' own HOMEs live (the data root's `integrations/mcp-home`, never the user's HOME or the project). */
export const mcpServerHomes = (layout: ProductLayout) => join(productResourcePath(layout, 'integrations'), MCP_SERVER_HOMES_DIR);
/** The trust context of a registry context (both trust places prepared for writing on demand). */
export function mcpTrustContext(context: McpRegistryContext & { readonly sandboxes: McpLaunchContext['sandboxes']; readonly principal: McpTrustContext['principal'];
  readonly audit: McpTrustAudit; readonly inputMaxBytes?: number; readonly now?: () => number; readonly scopeId?: string }, cwd: string): McpTrustContext {
  return { environment: context.environment, secret: context.secret, cwd, sandboxes: context.sandboxes, principal: context.principal, audit: context.audit, ...(context.grants ? { grants: context.grants } : {}),
    homeRoot: mcpServerHomes(context.layout), ...(context.scopeId ? { homeScope: context.scopeId } : {}),
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
  // MCP-SANDBOX-PATHS: the last start failure a turn recorded for this exact definition (display-safe; `/mcp` shows its text).
  const failures = await readMcpStartFailures(productResourcePath(context.layout, 'integrations'));
  const lastStartOf = (server: McpServerView) => { const failure = findMcpStartFailure(failures, server);
    return failure ? { lastStart: { phase: failure.phase, atMs: failure.atMs, code: failure.code, ...(failure.detail ? { detail: failure.detail } : {}),
      ...(failure.diagnosis ? { diagnosis: failure.diagnosis } : {}), text: context.describeNotice(failure.phase === 'tools' ? { kind: 'tools-changed', name: server.name, count: Number(failure.detail) || 0 }
      : mcpStartFailedNotice(server.name, failure)) } } : {}; };
  const summary = (server: McpServerView) => ({ name: server.name, scope: server.scope, file: server.file, status: server.status, ...(server.reason ? { reason: server.reason } : {}),
    shadows: server.shadows, realm: isMcpHttpEntry(server.entry) ? null : server.entry.realm ?? MCP_DEFAULT_REALM, ...mcpEntryDisplay(server.entry),
    definitionDigest: server.definitionDigest, pinnedTools: server.trust?.tools.length ?? 0, ...lastStartOf(server) });
  /** `/mcp approve|reconnect|remove` and a successful approval are the owner's explicit retry: the recorded failure goes. */
  const forgetFailure = (scope: McpScope, name: string) => updateMcpStartFailure(productResourcePath(context.layout, 'integrations'), { scope, name }, null).catch(() => undefined);
  const settings = { ...MCP_CLIENT_DEFAULTS, ...(context.limits?.resultMaxBytes ? { resultMaxBytes: context.limits.resultMaxBytes } : {}),
    ...(context.limits?.inputMaxBytes ? { inputMaxBytes: context.limits.inputMaxBytes } : {}) };
  const launchContext = { cwd: view.projectKey, environment: context.environment, sandboxes: context.sandboxes, homeRoot: mcpServerHomes(context.layout),
    ...(context.scopeId ? { homeScope: context.scopeId } : {}) };
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
          : { failure: state.reason, ...(state.detail ? { detail: state.detail } : {}),
            ...(state.reason === 'sandbox-unreachable' ? { diagnosis: displayMcpDiagnosis(state.diagnosis, mcpEntryDisplay(server.entry)) } : {}) }) };
    }));
    return { schemaVersion: 1, servers, problems: view.problems };
  }
  if (request.verb === 'get') {
    const server = find(request.name);
    if (!server) throw fail('MCP_SERVER_UNKNOWN', { name: request.name });
    // T3 (L4 ↔ L1): the person's grant for this server, read only; an unreadable policy shows no grant line rather than failing `get`.
    const grant = context.grants?.inspect ? await context.grants.inspect({ scope: server.scope, name: server.name }).catch(() => null) : null;
    return { schemaVersion: 1, server: { ...summary(server), entry: mcpEntryRedacted(server.entry), trust: server.trust, ...(grant ? { grant } : {}) } };
  }
  const trustContext = mcpTrustContext({ ...context, ...(context.limits?.inputMaxBytes ? { inputMaxBytes: context.limits.inputMaxBytes } : {}) }, view.projectKey);
  if (request.verb === 'add') {
    if (!MCP_SERVER_NAME.test(request.name)) throw fail('MCP_SERVER_NAME_INVALID', { name: request.name });
    const entry = mcpServerEntrySchema.safeParse(request.entry);
    if (!entry.success) throw fail('MCP_SERVER_ENTRY_INVALID', { name: request.name, reason: modelTextPrefix(entry.error.issues[0]?.message ?? 'schema', 200) });
    const refused = isMcpHttpEntry(entry.data) && !entry.data.url.includes('${') ? mcpEndpointRefusal(entry.data.url) : null;
    if (refused) throw fail('MCP_SERVER_ENTRY_INVALID', { name: request.name, reason: refused });
    const path = fileOf(view, request.scope), mode = request.scope === 'project' ? 0o644 : 0o600;
    const target = { name: request.name, scope: request.scope, definitionDigest: mcpDefinitionDigest(request.name, entry.data) };
    const exists = async () => { const servers = serversOf(await rawFile(path), request.scope, view.projectKey, false); return !!servers && Object.hasOwn(servers, request.name); };
    if (await exists()) throw fail('MCP_SERVER_EXISTS', { name: request.name, scope: request.scope });
    // MCP-REGISTRY-AUDIT: the audited trust decision comes first, the registry file after it. An audit refusal or failure leaves the registry and the trust
    // record as they were; a registry write that fails after a recorded decision revokes it again (audited), so no trust outlives an entry that never landed.
    // Owner 2026-09-28: adding a personal (local/user) server is its trust decision, in one step; a project entry is asked on first use. Every other add
    // (project, `--no-approve`, shadowed, unanswered) still audits a `reset`: a decision left by an earlier entry of this name never carries over.
    const outranked = view.servers.some(server => server.name === request.name && MCP_SCOPE_PRECEDENCE.indexOf(server.scope) < MCP_SCOPE_PRECEDENCE.indexOf(request.scope));
    let decided: Awaited<ReturnType<typeof decideMcpTrust>> | null = null;
    if (request.scope !== 'project' && request.approve !== false && !outranked)
      decided = await decideMcpTrust({ ...target, file: path, entry: entry.data, trust: null }, trustContext, context.ask);
    if (!decided || decided.decision === 'unanswered') await recordMcpTrust(target, trustContext, 'reset', () => null);
    try {
      await mutateRegistry(path, mode, raw => {
        const servers = serversOf(raw, request.scope, view.projectKey, true)!;
        if (Object.hasOwn(servers, request.name)) throw fail('MCP_SERVER_EXISTS', { name: request.name, scope: request.scope });
        servers[request.name] = entry.data;
      });
    } catch (error) {
      if (decided && decided.decision !== 'unanswered') await recordMcpTrust(target, trustContext, 'revoke', () => null).catch(() => undefined);
      throw error;
    }
    const added = { name: request.name, scope: request.scope, file: path };
    if (!decided) return { schemaVersion: 1, added, trust: outranked ? 'shadowed' : 'pending' };
    return { schemaVersion: 1, added, trust: decided.decision, pinnedTools: decided.pinned, ...(decided.grant ? { grant: decided.grant } : {}) };
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
    // MCP-REGISTRY-AUDIT: the audited revoke first, the registry file after it; a failed audit changes nothing, a failed registry write leaves the
    // server untrusted (it asks again), never trusted without its audit.
    const grant = await recordMcpTrust({ name: request.name, scope, definitionDigest: held?.definitionDigest ?? '0'.repeat(64) }, trustContext, 'revoke', () => null);
    await mutateRegistry(path, scope === 'project' ? 0o644 : 0o600, raw => { delete serversOf(raw, scope, view.projectKey, false)![request.name]; });
    await forgetFailure(scope, request.name);
    return { schemaVersion: 1, removed: { name: request.name, scope, file: path }, ...(grant && grant.status !== 'none' ? { grant } : {}) };
  }
  const server = find(request.name);
  if (!server) throw fail('MCP_SERVER_UNKNOWN', { name: request.name });
  if (request.verb === 'reset' || request.verb === 'revoke') {
    // `/mcp approve`: forget this server's decision, so its next use asks again with the cards (a decline is not final). `revoke` (K1): the
    // trust and the approver's tool grant go together; the entry stays and is not started again until it is approved again.
    const grant = await recordMcpTrust(server, trustContext, request.verb, () => null);
    await forgetFailure(server.scope, server.name);
    return { schemaVersion: 1, [request.verb === 'reset' ? 'reset' : 'revoked']: { name: server.name, scope: server.scope }, ...(grant && grant.status !== 'none' ? { grant } : {}) };
  }
  if (request.verb === 'reconnect') {
    if (!server.trust || server.status !== 'trusted') throw fail('MCP_SERVER_NOT_TRUSTED', { name: server.name });
    await recordMcpTrust(server, trustContext, 'reconnect', current => current && { ...current, reconnect: current.reconnect + 1 });
    await forgetFailure(server.scope, server.name);
    return { schemaVersion: 1, reconnect: { name: server.name, scope: server.scope } };
  }
  // approve: the launch card, then (only after yes) the server started in its realm and the tools card; the answers land in product state.
  const decided = await decideMcpTrust(server, trustContext, context.ask, { alwaysAsk: request.verb === 'approve' ? request.alwaysAsk : [] });
  if (decided.decision === 'trusted') await forgetFailure(server.scope, server.name);
  return { schemaVersion: 1, approved: decided.decision === 'trusted', name: server.name, scope: server.scope, pinnedTools: decided.pinned, ...(decided.grant ? { grant: decided.grant } : {}) };
}

/**
 * One turn's MCP servers (MCP-CLIENT): servers nobody decided on (pending or changed) get their first-use trust cards on the turn's approval
 * path (owner 2026-09-28), started in the service's pool only after the launch card's yes; then the trusted servers' pinned, matching tools.
 * A card without an answer records nothing. No failure is silent (MCP-SANDBOX-PATHS follow-up): a server that could not be decided or
 * started is named in `notices` (the turn's result note) with its display-safe diagnosis; a start failure is recorded for its exact
 * definition, so its first-use card is not asked again every turn until `/mcp approve` (or a changed entry) retries it.
 */
export async function openTurnMcp(input: { readonly registry: McpRegistryContext; readonly pool: McpPoolView; readonly cwd: string; readonly sandboxes: McpLaunchContext['sandboxes'];
  readonly principal: { readonly id: string; readonly issuer: string; readonly subject: string }; readonly sqlite: Parameters<typeof mcpTrustAuditWriter>[0]['sqlite'];
  readonly keyFile: string; readonly requestTtlMs: number; readonly inputMaxBytes: number; readonly resultMaxBytes: number; readonly scopeId: string; readonly turnId: string;
  readonly locale?: Locale;
  readonly signal: AbortSignal; readonly emit: Parameters<typeof mcpTrustApprovalAsker>[0]['emit']; readonly ledgerPath: () => Promise<string>;
  /** One request-time policy snapshot (B1, Sol 2237 R2b): its revision and the trust cards' facts (Core minimum raised by the snapshot's rules). */
  readonly requestPolicy: () => Promise<{ readonly revision: string; readonly trustFacts: AgentToolApprovalFacts }>; readonly now?: () => number;
  /** K1: the tool-grant port of the turn's person (the card's answerer); absent: trust only. */
  readonly grants?: McpToolGrantPort;
  /** Renders a notice in the service's locale (the adapter never renders owner text itself). */
  readonly describeNotice: McpStartNoticeRenderer }): Promise<{ readonly settings: McpClientSettings | null; readonly offered: ReadonlyMap<string, McpOfferedTool>;
  readonly notices: readonly string[] }> {
  const { registry, pool, principal, scopeId } = input, now = input.now ?? Date.now;
  const notices: McpStartNotice[] = [], failuresDirectory = productResourcePath(registry.layout, 'integrations');
  const failures = await readMcpStartFailures(failuresDirectory);
  /** Records (or clears) one server's start failure; a record that cannot be written is said, never hidden. */
  const remember = async (server: McpServerView, failure: McpStartFailure | null) => {
    try { await updateMcpStartFailure(await prepareProductDirectory(registry.layout, 'integrations'), server, failure); }
    catch { if (failure) notices.push({ kind: 'not-recorded', name: server.name }); }
  };
  let view = await loadMcpRegistry(registry);
  // MCP-REVOKE: a process whose server is no longer trusted (reset, removed, declined, changed) stops; its next use starts it after the cards.
  const trustedIds = (current: McpRegistryView) => new Set(current.servers.flatMap(server => server.launch ? [server.name] : []));
  pool.retain(trustedIds(view));
  const undecided = view.servers.filter(server => server.status === 'pending-approval' || server.status === 'changed');
  if (undecided.length) {
    const { revision: policyRevision, trustFacts } = await input.requestPolicy(), layout = registry.layout;
    const trust = mcpTrustContext({ ...registry, scopeId, sandboxes: input.sandboxes, principal, inputMaxBytes: input.inputMaxBytes, ...(input.grants ? { grants: input.grants } : {}),
      audit: mcpTrustAuditWriter({ layout, sqlite: input.sqlite, keyFile: input.keyFile, scopeId, principal, policyRevision }) }, input.cwd);
    const ask = mcpTrustApprovalAsker({ ledgerPath: input.ledgerPath, sqlite: input.sqlite, integrity: () => openLocalIntegrityAuthority(layout, input.keyFile, true),
      clock: new SystemTrustedClock(), scopeId, turnId: input.turnId, requester: { id: principal.id, issuer: principal.issuer, subject: principal.subject }, policyRevision, facts: trustFacts,
      ttlMs: input.requestTtlMs, signal: input.signal, emit: input.emit, ...(input.locale ? { locale: input.locale } : {}) });
    for (const server of undecided) {
      const known = findMcpStartFailure(failures, server);
      if (known) { notices.push(mcpStartFailedNotice(server.name, known)); continue; }
      try {
        const decided = await decideMcpTrust(server, trust, ask, { pool });
        if (decided.grant?.status === 'refused') notices.push({ kind: 'grant-refused', name: server.name, reason: decided.grant.reason });
        if (decided.decision === 'trusted' && failures.some(failure => failure.scope === server.scope && failure.name === server.name)) await remember(server, null);
      } catch (error) {
        const failure = mcpStartFailureOf(error);
        if (!failure) { notices.push({ kind: 'not-decided', name: server.name, code: String((error as { code?: unknown })?.code ?? 'failed') }); continue; }
        const record: McpStartFailure = { scope: server.scope as McpStartFailure['scope'], name: server.name, definitionDigest: server.definitionDigest, phase: 'launch',
          atMs: now(), ...failure };
        notices.push(mcpStartFailedNotice(server.name, record));
        await remember(server, record);
      }
    }
    view = await loadMcpRegistry(registry);
    pool.retain(trustedIds(view));
  }
  const settings = mcpClientSettings(view, { resultMaxBytes: input.resultMaxBytes, inputMaxBytes: input.inputMaxBytes });
  const byName = new Map(view.servers.map(server => [server.name, server])), outcomes: [McpServerView, McpServerOpen][] = [];
  const offered = settings ? await openMcpAgentTools(pool, settings, { cwd: input.cwd, environment: registry.environment, sandboxes: input.sandboxes, homeRoot: mcpServerHomes(registry.layout), homeScope: scopeId },
    (launch, state) => { const server = byName.get(launch.id); if (server) outcomes.push([server, state]); }) : new Map<string, McpOfferedTool>();
  for (const [server, state] of outcomes) {
    const known = findMcpStartFailure(failures, server);
    if (state.ok) {
      // MCP-VISIBILITY K3: pinned tools that are withheld (drifted, missing, unmappable) are said once per count and stay on `/mcp` until fixed.
      const withheld = mcpWithheldTools(state.tools);
      if (withheld && !(known?.phase === 'tools' && known.detail === String(withheld))) { notices.push({ kind: 'tools-changed', name: server.name, count: withheld });
        await remember(server, mcpToolsChangedRecord(server, withheld, now())); }
      else if (!withheld && known) await remember(server, null);
      continue;
    }
    // A server over its restart bound keeps the diagnosis of its last real start failure.
    if (state.reason === 'restart-limit' && known && known.phase !== 'tools') { notices.push(mcpStartFailedNotice(server.name, { ...known, phase: 'trusted' })); continue; }
    const record: McpStartFailure = { scope: server.scope as McpStartFailure['scope'], name: server.name, definitionDigest: server.definitionDigest, phase: 'trusted', atMs: now(),
      code: state.reason, ...(state.detail ? { detail: modelTextPrefix(state.detail, 200) } : {}),
      ...(state.reason === 'sandbox-unreachable' ? { diagnosis: displayMcpDiagnosis(state.diagnosis, mcpEntryDisplay(server.entry)) } : {}) };
    notices.push(mcpStartFailedNotice(server.name, record));
    await remember(server, record);
  }
  return { settings: offered.size ? settings : null, offered, notices: notices.map(input.describeNotice) };
}
