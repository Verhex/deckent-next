import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import type { McpChoice, McpPanelList, McpPanelPort, McpServerDraft, McpTrustAsk, PanelLine } from '#surfaces/core/terminal-panels/index.js';

type Scope = 'local' | 'project' | 'user';
/** The registry commands the terminal's `/mcp` window runs (the same `deckent mcp` handler; this unit never imports the CLI or the adapter). */
export type McpPanelRequest = { readonly verb: 'list'; readonly health?: boolean } | { readonly verb: 'get'; readonly name: string }
  | { readonly verb: 'add'; readonly scope: Scope; readonly name: string; readonly entry: unknown; readonly approve?: boolean }
  | { readonly verb: 'remove'; readonly name: string; readonly scope?: Scope }
  | { readonly verb: 'approve'; readonly name: string; readonly alwaysAsk: readonly string[] }
  | { readonly verb: 'reset' | 'reconnect' | 'revoke'; readonly name: string };
/** The host's MCP registry command (`McpCommandHandler`): `ask` answers one trust card (yes, no, or null: no answer, nothing recorded). */
export type McpPanelRun = (root: string, request: McpPanelRequest, options: ConfigLoadOptions, ask: (card: unknown) => Promise<boolean | null>, locale?: Locale) => Promise<unknown>;

type ServerSummary = { name: string; scope: string; file?: string; status: string; realm?: string | null; transport?: string; command?: string; args?: string[]; envNames?: string[];
  headerNames?: string[]; pinnedTools?: number; definitionDigest?: string; lastStart?: { text?: string; phase?: string };
  grant?: { status: 'granted'; scopes: 'all' | string[] } | { status: 'none' } };
type TrustCard = { phase?: string; name?: string; scope?: string; file?: string; definitionDigest?: string; transport?: string; command?: string; args?: string[];
  variables?: { name: string; set: boolean }[]; envNames?: string[]; headerNames?: string[]; realm?: string;
  tools?: { name: string; digest: string; description: string | null; alwaysAsk: boolean }[] };
const array = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const digest12 = (value: unknown) => typeof value === 'string' ? value.slice(0, 12) : '-';
function statusWord(status: string, locale: Locale) {
  switch (status) {
    case 'trusted': return t('terminal.mcp.status.trusted', {}, locale);
    case 'pending-approval': return t('terminal.mcp.status.pending', {}, locale);
    case 'changed': return t('terminal.mcp.status.changed', {}, locale);
    case 'declined': return t('terminal.mcp.status.declined', {}, locale);
    case 'invalid-launch': return t('terminal.mcp.status.invalidLaunch', {}, locale);
    case 'trust-store-unavailable': return t('terminal.mcp.status.trustUnreadable', {}, locale);
    default: return status;
  }
}
function scopeWord(scope: string, locale: Locale) {
  return scope === 'local' ? t('terminal.mcp.scope.local', {}, locale) : scope === 'project' ? t('terminal.mcp.scope.project', {}, locale)
    : scope === 'user' ? t('terminal.mcp.scope.user', {}, locale) : scope;
}
/** Where a server runs, in words: K4 (Jev 68a10d1a) — a stdio entry that names no realm runs in `sandbox-net`; an HTTP server runs nowhere here. */
function realmWord(realm: string | null | undefined, locale: Locale) {
  return realm === null || realm === 'none' ? t('tui.panel.mcp.realm.remote', {}, locale) : realm === 'host' ? t('tui.panel.mcp.realm.host', {}, locale)
    : realm === 'require-sandbox' ? t('tui.panel.mcp.realm.require', {}, locale) : realm === 'prefer-sandbox' ? t('tui.panel.mcp.realm.prefer', {}, locale)
    : t('tui.panel.mcp.realm.net', {}, locale);
}
/** The person's `mcp-server` grant of a server (owner 2026-10-07), or what trusting it would do. */
function grantWord(grant: ServerSummary['grant'], locale: Locale) {
  if (!grant || grant.status !== 'granted') return t('tui.panel.mcp.grant.none', {}, locale);
  return grant.scopes === 'all' ? t('tui.panel.mcp.grant.user', {}, locale) : t('tui.panel.mcp.grant.project', { scopes: grant.scopes.join(', ') }, locale);
}
function toolsWord(count: number, locale: Locale) { return count === 1 ? t('terminal.mcp.toolOne', {}, locale) : t('terminal.mcp.tools', { count }, locale); }

/** One trust card (launch, then tools) as the window's question, field by field in the person's language; producer values are projected by the window. */
export function mcpTrustQuestion(raw: unknown, locale: Locale) {
  const card = (raw ?? {}) as TrustCard, tools = card.tools ? array<NonNullable<TrustCard['tools']>[number]>(card.tools) : null;
  const variables = array<{ name: string; set: boolean }>(card.variables).map(item => item.set ? item.name : t('tui.panel.mcp.trust.unset', { name: item.name }, locale)).join(', ');
  const http = card.transport === 'http';
  const lines: PanelLine[] = [
    { label: t('tui.panel.mcp.field.scope', {}, locale), text: `${scopeWord(card.scope ?? '-', locale)} · ${card.file ?? '-'}` },
    { label: http ? t('tui.panel.mcp.field.url', {}, locale) : t('tui.panel.mcp.field.command', {}, locale), text: [card.command ?? '', ...array<string>(card.args)].join(' ') },
    ...(variables ? [{ label: t('tui.panel.mcp.field.variables', {}, locale), text: variables }] : []),
    http ? { label: t('tui.panel.mcp.field.headers', {}, locale), text: array<string>(card.headerNames).join(', ') || t('tui.panel.mcp.none', {}, locale) }
      : { label: t('tui.panel.mcp.field.env', {}, locale), text: array<string>(card.envNames).join(', ') || t('tui.panel.mcp.none', {}, locale) },
    { label: t('tui.panel.mcp.field.realm', {}, locale), text: realmWord(http ? null : card.realm, locale), ...(card.realm === 'host' ? { tone: 'warning' as const } : {}) },
    { label: t('tui.panel.mcp.field.definition', {}, locale), text: digest12(card.definitionDigest), tone: 'muted' },
    ...(tools ? [{ label: t('tui.panel.mcp.field.tools', {}, locale), text: toolsWord(tools.length, locale) },
      ...tools.map(tool => ({ label: '', text: `${tool.name} ${digest12(tool.digest)}${tool.alwaysAsk ? ` · ${t('tui.panel.mcp.trust.alwaysAsk', {}, locale)}` : ''}${tool.description ? ` — ${tool.description}` : ''}` }))] : [])];
  const title = card.phase === 'tools' ? t('tui.panel.mcp.trust.toolsTitle', { name: card.name ?? '-' }, locale) : t('tui.panel.mcp.trust.launchTitle', { name: card.name ?? '-' }, locale);
  return { title, lines, prompt: t('tui.panel.mcp.trust.keys', {}, locale) };
}

/**
 * The terminal `/mcp` window's port (T3 L4, wired to L1 MCP-CORE in the integration) over the host's registry command — the same engine as
 * `deckent mcp`: list and detail read the registry, trust and the person's grant (nothing starts), revoke takes trust and the grant together,
 * approve and add show their trust cards in the window (`ask`). An HTTP server (Streamable HTTP) takes a URL and headers; the registry refuses
 * plain http to another machine (https only; http only on this machine) and a `$DECK:` header in a project file.
 */
export function mcpPanelPort(root: string, run: McpPanelRun, options: ConfigLoadOptions, locale: Locale): McpPanelPort {
  const call = (request: McpPanelRequest, ask: (card: unknown) => Promise<boolean | null> = async () => null) => run(root, request, options, ask, locale);
  const asking = (ask: McpTrustAsk) => (card: unknown) => ask(mcpTrustQuestion(card, locale));
  const choice = (id: string, label: string, detail: string, blocked?: string): McpChoice => ({ id, label, detail, ...(blocked ? { blocked } : {}) });
  return {
    async list(): Promise<McpPanelList> {
      const listed = (await call({ verb: 'list', health: false })) as { servers?: unknown; problems?: unknown };
      const servers = array<ServerSummary>(listed.servers).map(server => ({ name: server.name, scope: scopeWord(server.scope, locale), status: statusWord(server.status, locale),
        attention: server.status !== 'trusted' || Boolean(server.lastStart), tools: server.pinnedTools ? toolsWord(server.pinnedTools, locale) : '',
        realm: realmWord(server.realm, locale).split(':')[0]!, launch: [server.command ?? '', ...array<string>(server.args)].join(' '), trusted: server.status === 'trusted' }));
      const problems = array<{ name: string | null; scope: string; reason: string }>(listed.problems).map(problem => problem.name === null
        ? t('terminal.mcp.problemFile', { scope: scopeWord(problem.scope, locale), reason: problem.reason }, locale)
        : t('terminal.mcp.problemServer', { name: problem.name, scope: scopeWord(problem.scope, locale), reason: problem.reason }, locale));
      return { servers, problems };
    },
    async detail(name) {
      const got = (await call({ verb: 'get', name })) as { server?: ServerSummary & { trust?: { tools?: { name: string; digest: string; alwaysAsk?: boolean }[] } | null } };
      const server = got.server ?? { name, scope: '-', status: '-' }, pins = array<{ name: string; digest: string; alwaysAsk?: boolean }>(server.trust?.tools);
      const http = server.transport === 'http';
      return [
        { label: t('tui.panel.mcp.field.status', {}, locale), text: statusWord(server.status, locale), ...(server.status === 'trusted' ? {} : { tone: 'warning' as const }) },
        { label: t('tui.panel.mcp.field.scope', {}, locale), text: `${scopeWord(server.scope, locale)} · ${server.file ?? '-'}` },
        { label: http ? t('tui.panel.mcp.field.url', {}, locale) : t('tui.panel.mcp.field.command', {}, locale), text: [server.command ?? '', ...array<string>(server.args)].join(' ') },
        http ? { label: t('tui.panel.mcp.field.headers', {}, locale), text: array<string>(server.headerNames).join(', ') || t('tui.panel.mcp.none', {}, locale) }
          : { label: t('tui.panel.mcp.field.env', {}, locale), text: array<string>(server.envNames).join(', ') || t('tui.panel.mcp.none', {}, locale) },
        { label: t('tui.panel.mcp.field.realm', {}, locale), text: realmWord(server.realm, locale), ...(server.realm === 'host' ? { tone: 'warning' as const } : {}) },
        { label: t('tui.panel.mcp.field.tools', {}, locale), text: pins.length ? toolsWord(pins.length, locale) : t('tui.panel.mcp.noPins', {}, locale) },
        ...pins.map(pin => ({ label: '', text: `${pin.name} ${digest12(pin.digest)}${pin.alwaysAsk ? ` · ${t('tui.panel.mcp.trust.alwaysAsk', {}, locale)}` : ''}` })),
        { label: t('tui.panel.mcp.field.lastStart', {}, locale), text: server.lastStart?.text ?? t('tui.panel.mcp.none', {}, locale), ...(server.lastStart ? { tone: 'warning' as const } : {}) },
        { label: t('tui.panel.mcp.field.grant', {}, locale), text: grantWord(server.grant, locale), ...(server.grant?.status === 'granted' ? {} : { tone: 'muted' as const }) },
        { label: t('tui.panel.mcp.field.definition', {}, locale), text: digest12(server.definitionDigest), tone: 'muted' as const }];
    },
    async revoke(name) { await call({ verb: 'revoke', name }); return [t('terminal.mcp.revoked', { name }, locale)]; },
    async approve(name, ask) {
      const result = (await call({ verb: 'approve', name, alwaysAsk: [] }, asking(ask))) as { approved?: boolean; pinnedTools?: number };
      return [result.approved ? t('tui.panel.mcp.approved', { name, tools: toolsWord(result.pinnedTools ?? 0, locale) }, locale) : t('tui.panel.mcp.notApproved', { name }, locale)];
    },
    async reconnect(name) { await call({ verb: 'reconnect', name }); return [t('terminal.mcp.reconnect', { name }, locale)]; },
    async remove(name) {
      const removed = (await call({ verb: 'remove', name })) as { removed?: { scope?: string } };
      return [t('terminal.mcp.removed', { name, scope: scopeWord(removed.removed?.scope ?? '-', locale) }, locale)];
    },
    async add(draft: McpServerDraft, ask) {
      // The registry command validates the entry (https only; plain http only on this machine; no `$DECK:` header in a project file).
      const entry = draft.transport === 'http' ? { type: 'http', url: draft.target, ...(Object.keys(draft.headers).length ? { headers: draft.headers } : {}) }
        : { type: 'stdio', command: draft.target, ...(draft.args.length ? { args: draft.args } : {}), ...(Object.keys(draft.env).length ? { env: draft.env } : {}),
          ...(draft.realm ? { realm: draft.realm } : {}) };
      const result = (await call({ verb: 'add', scope: draft.scope, name: draft.name, entry, approve: true }, asking(ask))) as
        { added?: { name: string; scope: string; file: string }; trust?: string; pinnedTools?: number };
      const trust = result.trust === 'trusted' ? t('tui.panel.mcp.approved', { name: draft.name, tools: toolsWord(result.pinnedTools ?? 0, locale) }, locale)
        : result.trust === 'declined' ? t('tui.panel.mcp.addedDeclined', {}, locale) : t('tui.panel.mcp.addedPending', {}, locale);
      return [t('tui.panel.mcp.added', { name: draft.name, scope: scopeWord(draft.scope, locale), file: result.added?.file ?? '-' }, locale), trust];
    },
    transports: [choice('stdio', t('tui.panel.mcp.transport.stdio', {}, locale), t('tui.panel.mcp.transport.stdioDetail', {}, locale)),
      choice('http', t('tui.panel.mcp.transport.http', {}, locale), t('tui.panel.mcp.transport.httpDetail', {}, locale))],
    // K4 (Jev 68a10d1a): the networked sandbox first (the default an entry without a realm gets), host last with its warning.
    realms: [choice('sandbox-net', t('tui.panel.mcp.realm.netLabel', {}, locale), t('tui.panel.mcp.realm.net', {}, locale)),
      choice('require-sandbox', t('tui.panel.mcp.realm.requireLabel', {}, locale), t('tui.panel.mcp.realm.require', {}, locale)),
      choice('prefer-sandbox', t('tui.panel.mcp.realm.preferLabel', {}, locale), t('tui.panel.mcp.realm.prefer', {}, locale)),
      choice('host', t('tui.panel.mcp.realm.hostLabel', {}, locale), t('tui.panel.mcp.realm.host', {}, locale))],
    scopes: [choice('local', t('terminal.mcp.scope.local', {}, locale), t('tui.panel.mcp.scopeDetail.local', {}, locale)), choice('project', t('terminal.mcp.scope.project', {}, locale), t('tui.panel.mcp.scopeDetail.project', {}, locale)),
      choice('user', t('terminal.mcp.scope.user', {}, locale), t('tui.panel.mcp.scopeDetail.user', {}, locale))],
  };
}
