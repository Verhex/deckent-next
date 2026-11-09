import { persistedString, persistedInteger } from '#domain/index.js';
import { DECKENT_DIR, type KnownSecretSnapshot } from '#platform/index.js';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MCP_PROJECT_VARIABLES, MCP_SCOPES as TRUST_SCOPES, MCP_SERVER_NAME as TRUST_SERVER_NAME, mcpLaunchTextValid, mcpProjectValueRefused } from '#adapters/core/mcp-trust/index.js';
import { mcpCanonical } from './pin.js';

/**
 * Scoped MCP server registry files (MCP-CLIENT, owner 2026-09-28: servers are not configuration; managed like Claude Code's scoped files).
 * `project`: `<project>/.deckent/mcp.json` (shared, committed); `user`: the Deckent global root's `mcp.json` top-level `mcpServers`; `local`:
 * the same file's `projects.<real project path>.mcpServers`; `managed`: the company policy's servers and allow/deny lists (read interface
 * only in Core). The same name in several scopes connects once from the highest one — managed > local > project > user — as a whole entry,
 * never merged. Trust and tool pins are product state (unit `adapters/core/mcp-trust`), never these files.
 */
export const MCP_SCOPES = TRUST_SCOPES;
export const MCP_SERVER_NAME = TRUST_SERVER_NAME;
export type McpScope = typeof MCP_SCOPES[number];
export const MCP_SCOPE_PRECEDENCE: readonly McpScope[] = Object.freeze([...MCP_SCOPES]);
export const MCP_REGISTRY_FILE = 'mcp.json';
/** The project registry, relative to the project root; the agent's read floor protects it (an MCP entry widens authority). */
export const MCP_PROJECT_REGISTRY_PATH = `${DECKENT_DIR}/${MCP_REGISTRY_FILE}`;
export const MCP_REGISTRY_MAX_BYTES = 1_048_576;
/** The one registry syntax: an env name, an HTTP header name (RFC 9110 token) and a value without control characters (no CR/LF header injection). */
export const MCP_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, MCP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const headerValue = (text: string) => [...text].every(char => { const code = char.charCodeAt(0); return code === 9 || (code >= 32 && code !== 127); });
/** A remote server over Streamable HTTP (MCP 2026-07-28; the SDK falls back to the 2025-11-25 shape): no local process, so no realm or env. */
const httpEntryFields = z.object({
  type: z.literal('http'),
  url: persistedString(z.string().min(1).max(4_096)).refine(mcpLaunchTextValid),
  headers: z.record(z.string().regex(MCP_HEADER_NAME), persistedString(z.string().max(8_192)).refine(headerValue)).refine(headers => Object.keys(headers).length <= 64, 'MCP_HEADERS_TOO_MANY').optional(),
});
/** One server as a registry file declares it: stdio (`type` absent or `stdio`; Claude-compatible shape, `realm` and `timeoutMs` are Deckent's) or
 * Streamable HTTP (`type: http`, the same `timeoutMs`). SSE and WebSocket are not transports of this client (SSE is deprecated since 2025-03-26;
 * neither is a standard transport of 2026-07-28). */
export const mcpServerEntrySchema = (stdio => z.union([stdio, httpEntryFields.extend({ timeoutMs: stdio.shape.timeoutMs }).strict()]))(z.strictObject({
  type: z.literal('stdio').optional(),
  command: persistedString(z.string().min(1).max(4_096)).refine(mcpLaunchTextValid),
  args: z.array(persistedString(z.string().max(4_096)).refine(mcpLaunchTextValid)).max(64).optional(),
  env: z.record(z.string().regex(MCP_ENV_NAME), persistedString(z.string().max(4_096))).refine(env => Object.keys(env).length <= 64, 'MCP_ENV_TOO_MANY').optional(),
  realm: z.enum(['sandbox-net', 'require-sandbox', 'prefer-sandbox', 'host']).optional(),
  timeoutMs: persistedInteger().min(1_000).max(3_600_000).optional(),
}));
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;
export type McpStdioEntry = Exclude<McpServerEntry, { readonly type: 'http' }>;
export type McpHttpEntry = Extract<McpServerEntry, { readonly type: 'http' }>;
export const isMcpHttpEntry = (entry: McpServerEntry): entry is McpHttpEntry => entry.type === 'http';
/** Transports other clients write that this one does not speak (named as such, not as a malformed entry). */
const UNSUPPORTED_TRANSPORTS: ReadonlySet<unknown> = new Set(['sse', 'ws', 'streamable-http']);
const servers = z.record(z.string(), z.unknown().optional());
const projectFileSchema = z.strictObject({ schemaVersion: z.literal(1).optional(), mcpServers: servers.optional() });
const personalFileSchema = z.strictObject({ schemaVersion: z.literal(1).optional(), mcpServers: servers.optional(),
  projects: z.record(z.string(), z.strictObject({ mcpServers: servers.optional() })).optional() });

/** The company's MCP policy as Core reads it (written by POLICY-ADMIN through `policy.administer`; no Core source yet). */
export interface ManagedMcpPolicy {
  /** Servers the company provides: they win over any personal or project entry of the same name. */
  readonly servers: Readonly<Record<string, unknown>>;
  /** When not null, only these names (plus the managed servers) are used. */
  readonly allowed: readonly string[] | null;
  /** Never used, whatever scope declares them (a managed server itself is not denied by name). */
  readonly denied: readonly string[];
}

export interface McpRegistrySource { readonly scope: McpScope; readonly file: string; readonly servers: Readonly<Record<string, unknown>> }
export interface McpRegistryEntry { readonly name: string; readonly scope: McpScope; readonly file: string; readonly entry: McpServerEntry;
  /** Digest of the entry as written (a project entry also binds its allowlisted variables' values, `mcpScopedDigest`): trust binds it, so any change asks again. */
  readonly definitionDigest: string; readonly shadows: readonly McpScope[] }
export interface McpRegistryProblem { readonly name: string | null; readonly scope: McpScope; readonly file: string; readonly reason: string }
export interface McpRegistry { readonly servers: readonly McpRegistryEntry[]; readonly problems: readonly McpRegistryProblem[] }

/** The digest trust binds: the entry as written, a stdio entry's realm as it takes effect (K4: an entry that names none runs in the default realm, so a
 * changed default changes what was trusted and asks again; an entry that names its realm keeps its digest). */
export const mcpDefinitionDigest = (name: string, entry: McpServerEntry, bound: readonly (readonly [string, string | null])[] = []) =>
  createHash('sha256').update(`mcp-server-definition:1\0${name}\0${mcpCanonical(isMcpHttpEntry(entry) ? entry : { ...entry, realm: entry.realm ?? MCP_DEFAULT_REALM })}${
    bound.length ? `\0${mcpCanonical(bound)}` : ''}`).digest('hex');
/** SEC-2 (F30): a project entry's digest also binds the values of the allowlisted variables it reads (a `${TZ:-UTC}` approved while unset asks
 * again once TZ is set); a personal entry binds its template only (its variables may hold the owner's secrets, never hashed into a record). */
export function mcpScopedDigest(name: string, scope: McpScope, entry: McpServerEntry, environment: Readonly<Record<string, string | undefined>>, known?: KnownSecretSnapshot): string {
  if (scope !== 'project') return mcpDefinitionDigest(name, entry);
  const texts = isMcpHttpEntry(entry) ? [entry.url, ...Object.values(entry.headers ?? {})] : [entry.command, ...(entry.args ?? []), ...Object.values(entry.env ?? {})];
  const names = [...new Set(texts.flatMap(text => [...text.matchAll(VARIABLE)].map(match => match[1]!)))].filter(name => MCP_PROJECT_VARIABLES.has(name)).sort();
  // A value that carries a credential (a known installation secret included, P21) is refused at launch and never hashed (`mcp list` shows the digest).
  return mcpDefinitionDigest(name, entry, names.map(variable => { const value = environment[variable];
    return [variable, value && !mcpProjectValueRefused(value, known) ? value : null] as const; }));
}

type RegistryText = { readonly ok: true; readonly text: string | null } | { readonly ok: false; readonly reason: string };
/** One registry file's bytes (null: absent → empty); unreadable, over the bound or writable by others → a problem. X8: never skipped by the send check. */
export async function readMcpRegistryText(path: string, kind: 'project' | 'personal'): Promise<RegistryText> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { ok: false, reason: 'not-a-regular-file' };
    if ((info.mode & 0o002) !== 0 || (kind === 'personal' && (info.mode & 0o077) !== 0)) return { ok: false, reason: 'permissions-too-open' };
    if (info.size > MCP_REGISTRY_MAX_BYTES) return { ok: false, reason: 'too-large' };
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch (error) {
    return (error as { code?: unknown })?.code === 'ENOENT' ? { ok: true, text: null } : { ok: false, reason: 'unreadable' };
  }
}
export const readMcpRegistryFile = async (path: string, kind: 'project' | 'personal', projectKey?: string) => parseMcpRegistryFile(await readMcpRegistryText(path, kind), kind, projectKey);
export function parseMcpRegistryFile(read: RegistryText, kind: 'project' | 'personal', projectKey?: string): { readonly ok: true; readonly raw: Record<string, unknown> | null; readonly user: Record<string, unknown>; readonly local: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (!read.ok || read.text === null) return read.ok ? { ok: true, raw: null, user: {}, local: {} } : read;
  let raw: unknown;
  try { raw = JSON.parse(read.text); } catch { return { ok: false, reason: 'invalid-json' }; }
  const parsed = (kind === 'project' ? projectFileSchema : personalFileSchema).safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-shape' };
  const local = kind === 'personal' && projectKey ? (parsed.data as z.infer<typeof personalFileSchema>).projects?.[projectKey]?.mcpServers ?? {} : {};
  return { ok: true, raw: raw as Record<string, unknown>, user: parsed.data.mcpServers ?? {}, local };
}
export const mcpRegistryPaths = (projectRoot: string, globalRoot: string) =>
  ({ project: join(projectRoot, MCP_PROJECT_REGISTRY_PATH), personal: join(globalRoot, MCP_REGISTRY_FILE) });

export function resolveMcpRegistry(sources: readonly McpRegistrySource[], managed: ManagedMcpPolicy | null, environment: Readonly<Record<string, string | undefined>> = {},
  known?: KnownSecretSnapshot): McpRegistry {
  const all = [...(managed ? [{ scope: 'managed' as const, file: '(company policy)', servers: managed.servers }] : []), ...sources.filter(source => source.scope !== 'managed')]
    .sort((a, b) => MCP_SCOPE_PRECEDENCE.indexOf(a.scope) - MCP_SCOPE_PRECEDENCE.indexOf(b.scope));
  // A name is decided by its highest scope: an invalid or refused entry there blocks the name (a broken override never re-enables a lower one).
  const chosen = new Map<string, { entry: McpRegistryEntry; shadows: McpScope[] }>(), taken = new Set<string>(), problems: McpRegistryProblem[] = [];
  const problem = (name: string, source: McpRegistrySource, reason: string) => { problems.push({ name, scope: source.scope, file: source.file, reason }); taken.add(name); };
  for (const source of all) for (const [name, value] of Object.entries(source.servers)) {
    if (taken.has(name)) { chosen.get(name)?.shadows.push(source.scope); continue; }
    if (!MCP_SERVER_NAME.test(name)) { problem(name, source, 'invalid-name'); continue; }
    const parsed = mcpServerEntrySchema.safeParse(value);
    if (!parsed.success) { problem(name, source, UNSUPPORTED_TRANSPORTS.has((value as { type?: unknown } | null)?.type) ? 'transport-unsupported' : 'invalid-entry'); continue; }
    if (source.scope !== 'managed' && managed && (managed.denied.includes(name) || (managed.allowed !== null && !managed.allowed.includes(name)))) {
      problem(name, source, managed.denied.includes(name) ? 'denied-by-company' : 'not-allowed-by-company'); continue;
    }
    taken.add(name);
    chosen.set(name, { entry: { name, scope: source.scope, file: source.file, entry: parsed.data, definitionDigest: mcpScopedDigest(name, source.scope, parsed.data, environment, known), shadows: [] }, shadows: [] });
  }
  return { servers: [...chosen.values()].map(({ entry, shadows }) => Object.freeze({ ...entry, shadows: Object.freeze([...shadows]) })), problems };
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;
/** The `${NAME` prefix the trust card and the service environment list name (expansion reads only the whole `VARIABLE` form). */
export const MCP_VARIABLE_NAME = /\$\{([A-Za-z_][A-Za-z0-9_]*)/gu;
const SECRET_REFERENCE = /^\$DECK:([A-Z_][A-Z0-9_]*)$/u;
const SECRET_IN_HEADER = /\$DECK:([A-Z_][A-Z0-9_]*)/gu;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The endpoint rule (fail closed until the owner decides, L1 review): https anywhere, plain http only to this machine (loopback). */
export function mcpEndpointRefusal(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'url-invalid'; }
  if (parsed.username || parsed.password) return 'url-credentials';
  if (parsed.protocol === 'https:') return null;
  return parsed.protocol === 'http:' ? LOOPBACK.has(parsed.hostname) ? null : 'url-insecure-remote' : 'url-scheme-refused';
}
export type McpExpandedEntry = { readonly ok: true; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>;
  /** The resolved `$DECK:` values: never shown, and cut out of anything the server sends back to the model. */
  readonly secrets: readonly string[] }
  | { readonly ok: true; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly secrets: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly refusal?: McpSecretRefusal };
/** KER-17/D11-R1: why a `$DECK:` entry cannot launch, typed (`reason` is its one string form for the surfaces). */
export type McpSecretRefusal = { readonly kind: 'secret-refused'; readonly code: string; readonly key: string } | { readonly kind: 'secret-unresolved'; readonly key: string } | { readonly kind: 'secret-reference-in-project-file' };
const refusedBy = (refusal: McpSecretRefusal) => ({ ok: false as const, refusal, reason: [refusal.kind, ...'code' in refusal ? [refusal.code] : [], ...'key' in refusal ? [refusal.key] : []].join(':') });
/**
 * The launch values of one entry: `${VAR}` / `${VAR:-default}` in `command`, `args`, `env` values, `url` and header values from the service
 * environment. A project file (someone else's commit) reads only the allowlisted non-secret variables (SEC-2, F30: any other name reads as its written default or empty; an allowlisted value carrying a credential refuses the entry) and may not use a Deckent secret reference; a
 * personal file may give an `env` value as exactly `$DECK:NAME`, or name `$DECK:NAME` inside a header value, resolved by the composition's
 * project credential decision (KER-17: a main-vault key only with this project's grant). An unset variable without a default makes the entry invalid; an HTTP endpoint must pass `mcpEndpointRefusal`.
 */
export async function expandMcpEntry(entry: McpServerEntry, scope: McpScope, environment: Readonly<Record<string, string | undefined>>,
  secret: (name: string) => Promise<string | undefined>, known?: KnownSecretSnapshot): Promise<McpExpandedEntry> {
  let missing: string | null = null, refused: string | null = null;
  const expand = (text: string) => text.replace(VARIABLE, (_match, name: string, fallback: string | undefined) => {
    if (scope === 'project' && !MCP_PROJECT_VARIABLES.has(name)) return fallback ?? '';
    const value = environment[name];
    if (value !== undefined && value !== '' && scope === 'project' && mcpProjectValueRefused(value, known)) { refused ??= name; return ''; }
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    missing ??= name; return '';
  });
  const secrets: string[] = [];
  let denied: string | null = null; const unresolved = (key: string) => refusedBy(denied ? { kind: 'secret-refused', code: denied, key } : { kind: 'secret-unresolved', key });
  const resolve = async (reference: string): Promise<string | null> => {
    const resolved = await secret(reference).catch((error: unknown) => { const code = String((error as { code?: unknown } | null)?.code); denied = /^(?:SECRET_GRANT_REQUIRED|DECK_DECLARATION_REQUIRED|SECRET_PROJECT_IDENTITY_REQUIRED|SECRET_PROJECT_MISSING)$/u.test(code) ? code : null; return undefined; });
    if (resolved === undefined || resolved === '') return null;
    secrets.push(resolved); return resolved;
  };
  if (isMcpHttpEntry(entry)) {
    const url = expand(entry.url), headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(entry.headers ?? {})) {
      const references = [...value.matchAll(SECRET_IN_HEADER)].map(match => match[1]!);
      if (references.length && scope === 'project') return refusedBy({ kind: 'secret-reference-in-project-file' });
      let text = expand(value);
      for (const reference of references) {
        const resolved = await resolve(reference);
        if (resolved === null) return unresolved(reference);
        text = text.replace(`$DECK:${reference}`, () => resolved);
      }
      if (!headerValue(text)) return { ok: false, reason: `header-invalid:${name}` };
      headers[name] = text;
    }
    if (refused !== null) return { ok: false, reason: `variable-value-refused:${refused as string}` };
    if (missing !== null) return { ok: false, reason: `variable-unset:${missing as string}` };
    const endpoint = mcpEndpointRefusal(url);
    if (endpoint) return { ok: false, reason: endpoint };
    return { ok: true, url, headers: Object.freeze(headers), secrets: Object.freeze(secrets) };
  }
  const command = expand(entry.command), args = (entry.args ?? []).map(expand), env: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.env ?? {})) {
    const reference = value.match(SECRET_REFERENCE)?.[1];
    if (reference === undefined) { env[name] = expand(value); continue; }
    if (scope === 'project') return refusedBy({ kind: 'secret-reference-in-project-file' });
    const resolved = await resolve(reference);
    if (resolved === null) return unresolved(reference);
    env[name] = resolved;
  }
  if (refused !== null) return { ok: false, reason: `variable-value-refused:${refused as string}` };
  if (missing !== null) return { ok: false, reason: `variable-unset:${missing as string}` };
  if (!command) return { ok: false, reason: 'empty-command' };
  return { ok: true, command, args: Object.freeze(args), env: Object.freeze(env), secrets: Object.freeze(secrets) };
}
/** The default realm of a stdio entry that names none (K4, Jev 68a10d1a): a sandbox with network and a private, persistent HOME for that server
 * (npx/uvx caches), the project read-only, the user's HOME, project secrets and Deckent's state hidden; no sandbox → it does not start. */
export const MCP_DEFAULT_REALM = 'sandbox-net';
export function mcpLaunchValues(entry: McpServerEntry, expanded: Extract<McpExpandedEntry, { ok: true }>) {
  return 'url' in expanded ? { transport: 'http' as const, url: expanded.url, headers: expanded.headers, command: '', args: [], env: {}, realm: 'host' as const, secrets: expanded.secrets }
    : { command: expanded.command, args: expanded.args, env: expanded.env, realm: isMcpHttpEntry(entry) ? 'host' as const : entry.realm ?? MCP_DEFAULT_REALM, secrets: expanded.secrets };
}
/** What the cards, `/mcp`, `list` and `get` show of an entry: the launch template (`${VAR}` unexpanded), env and header NAMES, never a value. */
export function mcpEntryDisplay(entry: McpServerEntry): { readonly transport: 'stdio' | 'http'; readonly command: string; readonly args: readonly string[];
  readonly envNames: readonly string[]; readonly headerNames: readonly string[] } {
  return isMcpHttpEntry(entry) ? { transport: 'http', command: entry.url, args: [], envNames: [], headerNames: Object.keys(entry.headers ?? {}) }
    : { transport: 'stdio', command: entry.command, args: entry.args ?? [], envNames: Object.keys(entry.env ?? {}), headerNames: [] };
}
/** An entry as `get` prints it: env and header values masked unless they are only references (`${VAR}`, `$DECK:NAME`), which name no secret. */
export function mcpEntryRedacted(entry: McpServerEntry): McpServerEntry {
  const reference = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$DECK:[A-Z_][A-Z0-9_]*|[\s]|[A-Za-z]+(?= ))*$/u;
  const mask = (values: Readonly<Record<string, string>> | undefined) => values && Object.fromEntries(Object.entries(values).map(([key, value]) => [key, reference.test(value) ? value : '<set>']));
  return isMcpHttpEntry(entry) ? { ...entry, ...(entry.headers ? { headers: mask(entry.headers)! } : {}) } : { ...entry, ...(entry.env ? { env: mask(entry.env)! } : {}) };
}
