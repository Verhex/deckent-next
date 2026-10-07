import { createHash, randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, modelTextPrefix } from '#domain/index.js';
import { AuditApplication, awaitAgentToolApproval, boundApprovalPreview, requestAgentToolApproval, type AgentToolApprovalFacts, type AgentToolApprovalOutcome } from '#engine/index.js';
import { ErrorRegistry, prepareProductFile, type ProductLayout, type TrustedClock } from '#platform/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { openLocalIntegrityAuthority } from '#adapters/core/local-keyring/index.js';
import { openSqliteApprovalStore } from '#adapters/core/approval-store/index.js';
import { displayMcpDiagnosis } from './diagnose.js';
import { MCP_HTTP_POSTURE, McpClientPool, mcpRealmPosture, type McpLaunchContext } from './pool.js';
import { MCP_CLIENT_DEFAULTS, mcpToolWireName, type McpClientServerSettings } from './pin.js';
import { expandMcpEntry, isMcpHttpEntry, MCP_DEFAULT_REALM, mcpEntryDisplay, mcpLaunchValues, type McpScope, type McpServerEntry } from './registry.js';
import { readMcpTrust, updateMcpTrust, type McpTrustRecord } from './trust.js';

/** One trust change as the audit port records it (subject `mcp-trust`): never the command's values, only the definition and tool digests. */
export interface McpTrustChange { readonly action: 'trust' | 'decline' | 'reset' | 'revoke' | 'reconnect'; readonly scope: McpScope; readonly name: string;
  readonly definitionDigest: string; readonly toolsDigest: string | null }
export type McpTrustAudit = (change: McpTrustChange) => Promise<void>;
/** What became of the approver's policy grant for a server's tools (K1): written, removed, nothing to do, or refused with its reason. */
export type McpToolGrantResult = { readonly status: 'granted' | 'revoked' | 'none' } | { readonly status: 'refused'; readonly reason: string };
/** The host's grant port (K1): the approver's own `policy.administer` grant for exactly the pinned tools' wire names, and its removal. */
export interface McpToolGrantPort {
  grant(server: { readonly scope: McpScope; readonly name: string }, tools: readonly string[]): Promise<McpToolGrantResult>;
  revoke(server: { readonly scope: McpScope; readonly name: string }): Promise<McpToolGrantResult>;
}

/**
 * The card of a trust decision, in two phases so a command is never run before the owner saw it (owner 2026-09-28): `launch` names the server,
 * its scope and file, the command and arguments as written with the variables they reference (never an expanded value), env names and realm;
 * after `yes` the server starts in its realm and `tools` adds the live tool list with each definition's digest, which the next `yes` pins.
 */
export interface McpTrustCard {
  readonly phase: 'launch' | 'tools'; readonly name: string; readonly scope: McpScope; readonly file: string; readonly definitionDigest: string;
  /** `command` is the endpoint URL template of an HTTP server (it has no arguments, env or realm: `realm` is `none`). */
  readonly transport: 'stdio' | 'http'; readonly command: string; readonly args: readonly string[]; readonly variables: readonly { readonly name: string; readonly set: boolean }[];
  readonly envNames: readonly string[]; readonly headerNames: readonly string[]; readonly realm: string; readonly note: string | null;
  /** Where it runs and what it may write (C5: a sandboxed server sees the project read-only): the realm's meaning on the launch card, the view
   * it started in on the tools card. */
  readonly posture?: string; readonly era?: string; readonly protocolVersion?: string | null;
  readonly tools?: readonly { readonly name: string; readonly digest: string; readonly description: string | null; readonly annotations: unknown; readonly alwaysAsk: boolean }[];
}
/** The owner's answer to one card: yes, no, or null when no answer came (a card that expired or a turn that ended): nothing is recorded then. */
export type McpTrustAsk = (card: McpTrustCard) => Promise<boolean | null>;
export interface McpTrustServer { readonly name: string; readonly scope: McpScope; readonly file: string; readonly definitionDigest: string; readonly entry: McpServerEntry;
  readonly trust: McpTrustRecord | null }
export interface McpTrustContext {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly secret: (name: string) => Promise<string | undefined>;
  readonly cwd: string;
  readonly sandboxes: McpLaunchContext['sandboxes'];
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly audit: McpTrustAudit;
  /** K1: the approver's grant for the trusted tools (absent: trust only, as before — a host without policy administration). */
  readonly grants?: McpToolGrantPort;
  /** Where the record of this scope lives (user: the global root; project and local: the data root's `integrations`), prepared for writing. */
  readonly directory: (scope: McpScope) => Promise<string>;
  readonly inputMaxBytes?: number;
  readonly now?: () => number;
  /** K4: where a `sandbox-net` server's own HOME is made (absent: such a server is refused). */
  readonly homeRoot?: string;
}
const toolsDigest = (tools: readonly { readonly name: string; readonly digest: string }[]) =>
  createHash('sha256').update(`mcp-tools:1\0${JSON.stringify(tools.map(tool => [tool.name, tool.digest]))}`).digest('hex');
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)/gu;

/** Writes one decision: the audit event first (no event, no change), then the record under the file's write lock (recomputed on what is there).
 * A decline, reset or revoke then removes the approver's tool grant of the server (K1: no grant outlives its trust); its outcome is returned. */
export async function recordMcpTrust(server: Pick<McpTrustServer, 'name' | 'scope' | 'definitionDigest'>, context: McpTrustContext, action: McpTrustChange['action'],
  change: (current: McpTrustRecord | null) => McpTrustRecord | null): Promise<McpToolGrantResult | null> {
  const directory = await context.directory(server.scope), mine = (record: McpTrustRecord) => record.scope === server.scope && record.name === server.name;
  const before = await readMcpTrust(directory);
  if (!before.ok) throw ErrorRegistry.createError('MCP_TRUST_STORE_UNAVAILABLE', { params: { reason: before.reason } });
  const preview = change(before.state.servers.find(mine) ?? null);
  await context.audit({ action, scope: server.scope, name: server.name, definitionDigest: server.definitionDigest, toolsDigest: preview ? toolsDigest(preview.tools) : null });
  await updateMcpTrust(directory, state => {
    const current = state.servers.find(mine) ?? null, next = change(current);
    return [...state.servers.filter(record => record !== current), ...(next ? [next] : [])];
  });
  if (action === 'trust' || action === 'reconnect' || !context.grants) return null;
  return context.grants.revoke(server).catch(error => ({ status: 'refused' as const, reason: String((error as { code?: unknown })?.code ?? 'failed') }));
}

/**
 * The owner's trust decision for one server (CLI `approve`/`add`, the turn's first-use card): the launch card, then — only after yes — the
 * server started in its realm (`pool`: the service's, so the process is kept; else a probe pool closed at once) and the tools card; yes pins
 * the live tools, no records `declined` for this definition. Either answer is audited before it is written. Refusals are typed; nothing runs
 * for a refused realm or an entry that cannot be expanded.
 */
export async function decideMcpTrust(server: McpTrustServer, context: McpTrustContext, ask: McpTrustAsk,
  options: { readonly pool?: McpClientPool; readonly alwaysAsk?: readonly string[] } = {}): Promise<{ readonly decision: 'trusted' | 'declined' | 'unanswered'; readonly pinned: number;
    readonly grant?: McpToolGrantResult }> {
  const fail = (code: string, reason: string) => ErrorRegistry.createError(code, { params: { name: server.name, reason } });
  const expanded = await expandMcpEntry(server.entry, server.scope, context.environment, context.secret);
  if (!expanded.ok) throw fail('MCP_SERVER_ENTRY_INVALID', expanded.reason);
  const shown = mcpEntryDisplay(server.entry), realm = isMcpHttpEntry(server.entry) ? null : server.entry.realm ?? MCP_DEFAULT_REALM;
  const template = isMcpHttpEntry(server.entry) ? [server.entry.url, ...Object.values(server.entry.headers ?? {})]
    : [server.entry.command, ...(server.entry.args ?? []), ...Object.values(server.entry.env ?? {})];
  const launchCard: McpTrustCard = { phase: 'launch', name: server.name, scope: server.scope, file: server.file, definitionDigest: server.definitionDigest,
    transport: shown.transport, command: shown.command, args: shown.args, envNames: shown.envNames, headerNames: shown.headerNames, realm: realm ?? 'none',
    // C5: the launch card already says what the realm means for the server's writes (the tools card then names the actual view).
    posture: realm ? mcpRealmPosture(realm) : MCP_HTTP_POSTURE,
    variables: [...new Set(template.flatMap(text => [...text.matchAll(VARIABLE)].map(match => match[1]!)))].map(name => ({ name,
      set: context.environment[name] !== undefined && context.environment[name] !== '' })),
    note: server.scope === 'project' ? 'project file: credential-shaped variables read as empty; secret references are refused' : null };
  const keep = (current: McpTrustRecord | null) => current?.reconnect ?? 0;
  const record = (decision: 'trusted' | 'declined', tools: McpTrustRecord['tools']) => (current: McpTrustRecord | null): McpTrustRecord => ({ scope: server.scope,
    name: server.name, definitionDigest: server.definitionDigest, tools, decision, reconnect: keep(current), approvedAtMs: (context.now ?? Date.now)(),
    principal: { issuer: context.principal.issuer, subject: context.principal.subject } });
  const decline = async () => { await recordMcpTrust(server, context, 'decline', record('declined', [])); return { decision: 'declined' as const, pinned: 0 }; };
  const started = await ask(launchCard);
  if (started === null) return { decision: 'unanswered', pinned: 0 };
  if (!started) return decline();
  const launch: McpClientServerSettings = { id: server.name, ...mcpLaunchValues(server.entry, expanded), tools: [] };
  const controller = new AbortController(), pool = options.pool ?? new McpClientPool(controller.signal);
  try {
    const state = await pool.open(launch, { ...MCP_CLIENT_DEFAULTS, ...(context.inputMaxBytes ? { inputMaxBytes: context.inputMaxBytes } : {}), servers: [launch] },
      { cwd: context.cwd, environment: context.environment, sandboxes: context.sandboxes, ...(context.homeRoot ? { homeRoot: context.homeRoot } : {}) });
    if (!state.ok && state.reason === 'sandbox-unreachable') {
      // MCP-SANDBOX-PATHS: what the sandbox view hides (or needs from outside it), in the registry's own words for a `${VAR}` path.
      const shown = displayMcpDiagnosis(state.diagnosis, mcpEntryDisplay(server.entry));
      throw ErrorRegistry.createError('MCP_SANDBOX_COMMAND_UNREACHABLE', { cause: shown, params: { name: server.name, kind: shown.kind,
        ...(shown.kind === 'path-hidden' ? { role: shown.role, path: shown.path, target: shown.target ?? '' } : { runner: shown.runner }) } });
    }
    if (!state.ok) throw fail(state.reason === 'sandbox-unavailable' ? 'MCP_SANDBOX_UNAVAILABLE' : 'MCP_SERVER_START_FAILED', state.detail ?? state.reason);
    const live = state.tools.filter(tool => tool.digest !== null);
    for (const name of options.alwaysAsk ?? []) if (!live.some(tool => tool.name === name)) throw fail('MCP_TOOL_UNKNOWN', name);
    const tools = live.map(tool => ({ name: tool.name, digest: tool.digest!, description: tool.description ?? null, annotations: tool.annotations ?? null,
      alwaysAsk: (options.alwaysAsk ?? []).includes(tool.name) }));
    const pinned = await ask({ ...launchCard, phase: 'tools', posture: state.posture, era: state.era, protocolVersion: state.protocolVersion, tools });
    if (pinned === null) return { decision: 'unanswered', pinned: 0 };
    if (!pinned) return decline();
    const pins = tools.map(tool => ({ name: tool.name, digest: tool.digest, alwaysAsk: tool.alwaysAsk }));
    await recordMcpTrust(server, context, 'trust', record('trusted', pins));
    // K1: the trust approval also writes the approver's grant for exactly these tools (within their own authority; a refusal keeps the trust).
    const wires = pins.flatMap(pin => { const wire = mcpToolWireName(server.name, pin.name); return wire ? [wire] : []; });
    const grant = context.grants ? await context.grants.grant(server, wires).catch(error => ({ status: 'refused' as const, reason: String((error as { code?: unknown })?.code ?? 'failed') })) : undefined;
    return { decision: 'trusted', pinned: pins.length, ...(grant ? { grant } : {}) };
  } finally { if (!options.pool) { controller.abort(); await pool.close(); } }
}

/** The audit port of trust changes over the project's ledger (the same sealed audit application as permission-mode events). */
export function mcpTrustAuditWriter(input: { readonly layout: ProductLayout; readonly sqlite: Parameters<typeof openSqliteAuditStore>[1]; readonly keyFile: string;
  readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string }; readonly policyRevision: string; readonly now?: () => number }): McpTrustAudit {
  return async change => {
    const store = await openSqliteAuditStore(await prepareProductFile(input.layout, 'ledger', ['-wal', '-shm', '-journal']), input.sqlite, 'allow');
    try {
      await new AuditApplication(store, await openLocalIntegrityAuthority(input.layout, input.keyFile, true)).record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
        eventId: createHash('sha256').update(`mcp-trust:1\0${randomUUID()}`).digest('hex'), scopeId: input.scopeId,
        principal: { issuer: input.principal.issuer, subject: input.principal.subject }, policyRevision: input.policyRevision, atMs: (input.now ?? Date.now)(),
        subject: { kind: 'mcp-trust', action: change.action, scope: change.scope, server: change.name, definitionDigest: change.definitionDigest, toolsDigest: change.toolsDigest } });
    } finally { store.close(); }
  };
}

/** The card as text (approval preview and CLI): what runs, where, with which variables (set or not) and, in the tools phase, what gets pinned. */
export function describeMcpTrustCard(card: McpTrustCard): string {
  const lines = [`MCP server ${card.name} (${card.scope} scope, ${card.file}) — ${card.phase === 'launch' ? 'start it?' : 'trust it and pin these tools?'}`,
    card.transport === 'http' ? `url: ${card.command}` : `command: ${[card.command, ...card.args].join(' ')}`,
    `variables: ${card.variables.map(variable => `${variable.name}${variable.set ? '' : ' (unset)'}`).join(', ') || 'none'}`,
    card.transport === 'http' ? `headers: ${card.headerNames.join(', ') || 'none'}` : `env: ${card.envNames.join(', ') || 'none'}`, `realm: ${card.realm}${card.posture ? ` — ${card.posture}` : ''}`, `definition: ${card.definitionDigest}`,
    ...(card.note ? [`note: ${card.note}`] : []),
    ...(card.tools ? [`tools (${card.tools.length}; ${card.era ?? ''} ${card.protocolVersion ?? ''}):`, ...card.tools.map(tool => `  ${tool.name} ${tool.digest.slice(0, 12)}${
      tool.alwaysAsk ? ' always-ask' : ''}${tool.description ? ` — ${modelTextPrefix(tool.description, 160)}` : ''}`)] : [])];
  return lines.join('\n');
}

/** The input of a turn's MCP card asker (trust cards, model proposals): the turn's approval journal, integrity, clock and stream. */
export interface McpCardAskerInput { readonly ledgerPath: () => Promise<string>; readonly sqlite: Parameters<typeof openSqliteApprovalStore>[1];
  readonly integrity: () => ReturnType<typeof openLocalIntegrityAuthority>; readonly clock: TrustedClock; readonly scopeId: string; readonly turnId: string;
  readonly requester: { readonly id: string; readonly issuer: string; readonly subject: string }; readonly policyRevision: string; readonly ttlMs: number;
  /** B1 (Sol 2237 R2b): the card facts from the same request-time policy snapshot as `policyRevision`; sealed in the record, the event repeats them. */
  readonly facts: AgentToolApprovalFacts;
  readonly signal: AbortSignal; readonly emit: (event: { readonly kind: 'approval.requested'; readonly callId: string; readonly approvalId: string; readonly revision: number;
    readonly summary: string; readonly preview: string; readonly expiresAt: number; readonly risk?: string | null; readonly requiredAssurance?: string }
    | { readonly kind: 'approval.settled'; readonly callId: string; readonly approvalId: string;
    readonly outcome: AgentToolApprovalOutcome | 'unsettled' }) => void }
/**
 * One MCP card of a turn as a single-use approval (C12 `agent-tool-call` subject with a reserved tool name, resource `mcp:<server>`, digest over the
 * card's text), shown on the terminal's approval card and answered there. No answer in time (or a turn that ended) is null: nothing is recorded.
 * Nothing here consults a permission mode: the card is always asked (a trust decision or a model's proposal is never lowered).
 */
export function mcpCardApprovalAsker(input: McpCardAskerInput, indexBase: number) {
  let asked = 0;
  return async (card: { readonly tool: string; readonly name: string; readonly phase: string; readonly text: string }): Promise<boolean | null> => {
    const journal = openSqliteApprovalStore(await input.ledgerPath(), input.sqlite);
    // `mcp_trust` keeps its digest and call id scheme (`mcp-trust-card:1`, `mcp-trust-<server>-<phase>`); another card tool gets its own.
    const kind = card.tool.replace(/_/gu, '-'), argsDigest = createHash('sha256').update(`${kind}-card:1\0${card.text}`).digest('hex'), callId = `${kind}-${card.name}-${card.phase}`;
    let requested: string | null = null, outcome: AgentToolApprovalOutcome | 'unsettled' = 'unsettled';
    try {
      const integrity = await input.integrity(), started = input.clock.sample();
      const record = requestAgentToolApproval(journal.store, integrity, { scopeId: input.scopeId, requester: input.requester, policyRevision: input.policyRevision,
        subject: { kind: 'agent-tool-call', turnId: input.turnId, round: 1, index: indexBase + asked++, tool: card.tool, toolVersion: 1, resource: `mcp:${card.name}`, argsDigest },
        summary: `${card.tool} · mcp:${card.name} · ${card.phase}`, createdAt: started.wallMs, expiresAt: started.wallMs + input.ttlMs, facts: input.facts });
      requested = record.request.approvalId;
      // The event's facts come from the sealed record itself (an existing record keeps its own), so the card and the record never disagree.
      const sealed = record.request.schemaVersion === 3 ? record.request.facts : null;
      input.emit({ kind: 'approval.requested', callId, approvalId: requested, revision: record.revision, summary: record.request.summary,
        preview: boundApprovalPreview(card.text), expiresAt: record.request.expiresAt, ...(sealed ? { risk: sealed.risk?.source === 'cell' ? sealed.risk.cell : null,
          requiredAssurance: sealed.requiredAssurance } : {}) });
      outcome = await awaitAgentToolApproval(journal.store, integrity, record, input.clock, input.signal, 250, started);
      return outcome === 'allow' ? true : outcome === 'deny' ? false : null;
    } finally {
      journal.close();
      if (requested) input.emit({ kind: 'approval.settled', callId, approvalId: requested, outcome });
    }
  };
}
/** The pseudo tool of a first-use trust card on the turn's approval path (no approval schema change: an agent-tool-call subject named `mcp_trust`). */
export const MCP_TRUST_CARD_TOOL = 'mcp_trust';
/** The turn's first-use trust question (owner 2026-09-28): each card one single-use approval of the turn (`mcpCardApprovalAsker`, tool `mcp_trust`). */
export function mcpTrustApprovalAsker(input: McpCardAskerInput): McpTrustAsk {
  const ask = mcpCardApprovalAsker(input, 1_000_000);
  return card => ask({ tool: MCP_TRUST_CARD_TOOL, name: card.name, phase: card.phase, text: describeMcpTrustCard(card) });
}
