import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DECKENT_DIR } from '#platform/index.js';

/**
 * Scoped MCP server registry files (MCP-CLIENT, owner 2026-09-28: servers are not configuration; managed like Claude Code's scoped files).
 * `project`: `<project>/.deckent/mcp.json` (shared, committed); `user`: the Deckent global root's `mcp.json` top-level `mcpServers`; `local`:
 * the same file's `projects.<real project path>.mcpServers`; `managed`: the company policy's servers and allow/deny lists (read interface
 * only in Core). The same name in several scopes connects once from the highest one — managed > local > project > user — as a whole entry,
 * never merged. Trust and tool pins are product state (`trust.ts`), never these files.
 */
/** The scopes, highest precedence first. */
export const MCP_SCOPES = ['managed', 'local', 'project', 'user'] as const;
export type McpScope = typeof MCP_SCOPES[number];
export const MCP_SCOPE_PRECEDENCE: readonly McpScope[] = Object.freeze([...MCP_SCOPES]);
export const MCP_REGISTRY_FILE = 'mcp.json';
/** The project registry, relative to the project root; the agent's read floor protects it (an MCP entry widens authority). */
export const MCP_PROJECT_REGISTRY_PATH = `${DECKENT_DIR}/${MCP_REGISTRY_FILE}`;
export const MCP_REGISTRY_MAX_BYTES = 1_048_576;
export const MCP_SERVER_NAME = /^[a-z][a-z0-9]{0,15}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/** One server as a registry file declares it (Claude-compatible shape; `realm` and `timeoutMs` are Deckent's). Only stdio in this slice. */
export const mcpServerEntrySchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1).max(4_096),
  args: z.array(z.string().max(4_096)).max(64).optional(),
  env: z.record(z.string().regex(ENV_NAME), z.string().max(4_096)).refine(env => Object.keys(env).length <= 64, 'MCP_ENV_TOO_MANY').optional(),
  realm: z.enum(['require-sandbox', 'prefer-sandbox', 'host']).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
}).strict();
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;
const servers = z.record(z.string(), z.unknown());
const projectFileSchema = z.object({ schemaVersion: z.literal(1).optional(), mcpServers: servers.optional() }).strict();
const personalFileSchema = z.object({ schemaVersion: z.literal(1).optional(), mcpServers: servers.optional(),
  projects: z.record(z.string(), z.object({ mcpServers: servers.optional() }).strict()).optional() }).strict();

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
  /** Digest of the entry as written (before `${VAR}` expansion): trust binds it, so any change asks again. */
  readonly definitionDigest: string; readonly shadows: readonly McpScope[] }
export interface McpRegistryProblem { readonly name: string | null; readonly scope: McpScope; readonly file: string; readonly reason: string }
export interface McpRegistry { readonly servers: readonly McpRegistryEntry[]; readonly problems: readonly McpRegistryProblem[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const mcpDefinitionDigest = (name: string, entry: McpServerEntry) =>
  createHash('sha256').update(`mcp-server-definition:1\0${name}\0${canonical(entry)}`).digest('hex');

/** Reads one registry file: absent → empty; unreadable, over the bound, writable by others or not the declared shape → a problem, no servers. */
export async function readMcpRegistryFile(path: string, kind: 'project' | 'personal', projectKey?: string):
  Promise<{ readonly ok: true; readonly raw: Record<string, unknown> | null; readonly user: Record<string, unknown>; readonly local: Record<string, unknown> }
    | { readonly ok: false; readonly reason: string }> {
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { ok: false, reason: 'not-a-regular-file' };
    if ((info.mode & 0o002) !== 0 || (kind === 'personal' && (info.mode & 0o077) !== 0)) return { ok: false, reason: 'permissions-too-open' };
    if (info.size > MCP_REGISTRY_MAX_BYTES) return { ok: false, reason: 'too-large' };
    text = await readFile(path, 'utf8');
  } catch (error) {
    return (error as { code?: unknown })?.code === 'ENOENT' ? { ok: true, raw: null, user: {}, local: {} } : { ok: false, reason: 'unreadable' };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'invalid-json' }; }
  const parsed = (kind === 'project' ? projectFileSchema : personalFileSchema).safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-shape' };
  const local = kind === 'personal' && projectKey ? (parsed.data as z.infer<typeof personalFileSchema>).projects?.[projectKey]?.mcpServers ?? {} : {};
  return { ok: true, raw: raw as Record<string, unknown>, user: parsed.data.mcpServers ?? {}, local };
}
/** Where the registry files are for one project: the project file and the personal file of the Deckent global root. */
export const mcpRegistryPaths = (projectRoot: string, globalRoot: string) =>
  ({ project: join(projectRoot, MCP_PROJECT_REGISTRY_PATH), personal: join(globalRoot, MCP_REGISTRY_FILE) });

/** Resolves the effective servers: each name from its highest scope (whole entry), invalid entries and policy removals as problems. */
export function resolveMcpRegistry(sources: readonly McpRegistrySource[], managed: ManagedMcpPolicy | null): McpRegistry {
  const all = [...(managed ? [{ scope: 'managed' as const, file: '(company policy)', servers: managed.servers }] : []), ...sources.filter(source => source.scope !== 'managed')]
    .sort((a, b) => MCP_SCOPE_PRECEDENCE.indexOf(a.scope) - MCP_SCOPE_PRECEDENCE.indexOf(b.scope));
  // A name is decided by its highest scope: an invalid or refused entry there blocks the name (a broken override never re-enables a lower one).
  const chosen = new Map<string, { entry: McpRegistryEntry; shadows: McpScope[] }>(), taken = new Set<string>(), problems: McpRegistryProblem[] = [];
  const problem = (name: string, source: McpRegistrySource, reason: string) => { problems.push({ name, scope: source.scope, file: source.file, reason }); taken.add(name); };
  for (const source of all) for (const [name, value] of Object.entries(source.servers)) {
    if (taken.has(name)) { chosen.get(name)?.shadows.push(source.scope); continue; }
    if (!MCP_SERVER_NAME.test(name)) { problem(name, source, 'invalid-name'); continue; }
    const parsed = mcpServerEntrySchema.safeParse(value);
    if (!parsed.success) { problem(name, source, 'invalid-entry'); continue; }
    if (source.scope !== 'managed' && managed && (managed.denied.includes(name) || (managed.allowed !== null && !managed.allowed.includes(name)))) {
      problem(name, source, managed.denied.includes(name) ? 'denied-by-company' : 'not-allowed-by-company'); continue;
    }
    taken.add(name);
    chosen.set(name, { entry: { name, scope: source.scope, file: source.file, entry: parsed.data, definitionDigest: mcpDefinitionDigest(name, parsed.data), shadows: [] }, shadows: [] });
  }
  return { servers: [...chosen.values()].map(({ entry, shadows }) => Object.freeze({ ...entry, shadows: Object.freeze([...shadows]) })), problems };
}

/** Names a project file may not read from the environment: credential-shaped, Deckent's own and cloud credentials (they read as empty). */
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASSW(?:OR)?D|CREDENTIAL|AUTH)|^(?:DECKENT_|AWS_)/iu;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/gu;
const SECRET_REFERENCE = /^\$DECK:([A-Z_][A-Z0-9_]*)$/u;
/**
 * The launch values of one entry: `${VAR}` / `${VAR:-default}` in `command`, `args` and `env` values from the service environment. A project
 * file (someone else's commit) reads credential-shaped names as empty and may not use a Deckent secret reference; a personal file may give an
 * `env` value as exactly `$DECK:NAME`, resolved by the installation's secret resolver. An unset variable without a default makes the entry invalid.
 */
export async function expandMcpEntry(entry: McpServerEntry, scope: McpScope, environment: Readonly<Record<string, string | undefined>>,
  secret: (name: string) => Promise<string | undefined>): Promise<{ readonly ok: true; readonly command: string; readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>> } | { readonly ok: false; readonly reason: string }> {
  let missing: string | null = null;
  const expand = (text: string) => text.replace(VARIABLE, (_match, name: string, fallback: string | undefined) => {
    if (scope === 'project' && CREDENTIAL_NAME.test(name)) return '';
    const value = environment[name];
    if (value !== undefined && value !== '') return value;
    if (fallback !== undefined) return fallback;
    missing ??= name; return '';
  });
  const command = expand(entry.command), args = (entry.args ?? []).map(expand), env: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.env ?? {})) {
    const reference = value.match(SECRET_REFERENCE)?.[1];
    if (reference === undefined) { env[name] = expand(value); continue; }
    if (scope === 'project') return { ok: false, reason: 'secret-reference-in-project-file' };
    const resolved = await secret(reference).catch(() => undefined);
    if (resolved === undefined || resolved === '') return { ok: false, reason: `secret-unresolved:${reference}` };
    env[name] = resolved;
  }
  if (missing !== null) return { ok: false, reason: `variable-unset:${missing as string}` };
  if (!command) return { ok: false, reason: 'empty-command' };
  return { ok: true, command, args: Object.freeze(args), env: Object.freeze(env) };
}
