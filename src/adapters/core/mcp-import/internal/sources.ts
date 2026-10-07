import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MCP_REGISTRY_MAX_BYTES, mcpServerEntrySchema, type McpServerEntry } from '#adapters/core/mcp-client/index.js';

/**
 * `deckent mcp import` (L1 MCP-CORE item 2): the servers other MCP clients already declare, read as data. Claude Code (code.claude.com/docs/en/mcp,
 * 2026-10-07): the project's `.mcp.json` (project scope), `~/.claude.json` top-level `mcpServers` (user) and `projects.<project path>.mcpServers`
 * (local). Claude Desktop (modelcontextprotocol.io "Connect to local MCP servers", 2026-10-07): `~/Library/Application Support/Claude/` on macOS,
 * `%APPDATA%\Claude\` on Windows — under WSL the Windows profiles' `AppData/Roaming/Claude/` (one profile, else `--from <file>`); native Linux
 * has no Claude Desktop. Nothing here writes or trusts anything: the caller adds each server through the registry's own `add`, untrusted.
 */
export type McpImportFrom = 'claude-code' | 'claude-desktop' | { readonly file: string };
export interface McpImportSource { readonly file: string; readonly scope: 'local' | 'project' | 'user'; readonly servers: Readonly<Record<string, unknown>> }
export interface McpImportSourceProblem { readonly file: string; readonly reason: string }
const DESKTOP_FILE = 'claude_desktop_config.json';
const WINDOWS_SYSTEM_PROFILES = new Set(['All Users', 'Default', 'Default User', 'Public']);

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** One JSON file: absent → null; not a regular file, over the registry bound or not an object → a problem. */
async function readJson(file: string): Promise<{ readonly ok: true; readonly value: Record<string, unknown> | null } | { readonly ok: false; readonly reason: string }> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return { ok: false, reason: 'not-a-regular-file' };
    if (info.size > MCP_REGISTRY_MAX_BYTES) return { ok: false, reason: 'too-large' };
    const value = record(JSON.parse(await readFile(file, 'utf8')));
    return value ? { ok: true, value } : { ok: false, reason: 'invalid-shape' };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === 'ENOENT' ? { ok: true, value: null } : { ok: false, reason: error instanceof SyntaxError ? 'invalid-json' : 'unreadable' };
  }
}

/** Where Claude Desktop keeps its configuration on this machine, or why it cannot be found (`windowsProfiles`: the WSL mount of `C:\Users`). */
async function desktopConfig(environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform, windowsProfiles: string, wsl: boolean): Promise<string | { readonly reason: string }> {
  if (platform === 'darwin' && environment['HOME']) return join(environment['HOME'], 'Library', 'Application Support', 'Claude', DESKTOP_FILE);
  if (platform === 'win32' && environment['APPDATA']) return join(environment['APPDATA'], 'Claude', DESKTOP_FILE);
  if (platform !== 'linux' || !wsl) return { reason: 'claude-desktop-not-on-this-platform' };
  const profiles = await readdir(windowsProfiles, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of profiles) {
    if (!entry.isDirectory() || WINDOWS_SYSTEM_PROFILES.has(entry.name)) continue;
    const file = join(windowsProfiles, entry.name, 'AppData', 'Roaming', 'Claude', DESKTOP_FILE);
    if (await lstat(file).then(info => info.isFile(), () => false)) found.push(file);
  }
  return found.length === 1 ? found[0]! : { reason: found.length ? 'claude-desktop-several-profiles' : 'claude-desktop-config-not-found' };
}

/**
 * The import sources of one request: Claude Code's three places (each to its own scope), Claude Desktop's file, or an explicit file with
 * `mcpServers` (both to `scope`, local by default — never the shared project file, which another person's commit would carry).
 */
export async function readMcpImportSources(input: { readonly projectRoot: string; readonly projectKeys: readonly string[]; readonly from: McpImportFrom;
  readonly scope?: 'local' | 'user'; readonly environment: Readonly<Record<string, string | undefined>>; readonly platform?: NodeJS.Platform; readonly windowsProfiles?: string;
  readonly wsl?: boolean }): Promise<{ readonly sources: readonly McpImportSource[]; readonly problems: readonly McpImportSourceProblem[] }> {
  const sources: McpImportSource[] = [], problems: McpImportSourceProblem[] = [];
  const take = async (file: string, pick: (value: Record<string, unknown>) => readonly { readonly scope: McpImportSource['scope']; readonly servers: unknown }[]) => {
    const read = await readJson(file);
    if (!read.ok) { problems.push({ file, reason: read.reason }); return; }
    for (const part of read.value ? pick(read.value) : []) { const servers = record(part.servers); if (servers) sources.push({ file, scope: part.scope, servers }); }
  };
  const scope = input.scope ?? 'local';
  if (input.from === 'claude-code') {
    await take(join(input.projectRoot, '.mcp.json'), value => [{ scope: 'project', servers: value['mcpServers'] }]);
    const home = input.environment['HOME'];
    if (home) await take(join(home, '.claude.json'), value => [{ scope: 'user', servers: value['mcpServers'] },
      ...[...new Set(input.projectKeys)].map(key => ({ scope: 'local' as const, servers: record(record(value['projects'])?.[key])?.['mcpServers'] }))]);
  } else if (input.from === 'claude-desktop') {
    const wsl = input.wsl ?? (input.environment['WSL_DISTRO_NAME'] !== undefined);
    const file = await desktopConfig(input.environment, input.platform ?? process.platform, input.windowsProfiles ?? '/mnt/c/Users', wsl);
    if (typeof file !== 'string') problems.push({ file: DESKTOP_FILE, reason: file.reason });
    else await take(file, value => [{ scope, servers: value['mcpServers'] }]);
  } else await take(input.from.file, value => [{ scope, servers: value['mcpServers'] }]);
  return { sources, problems };
}

/** One imported server in Deckent's registry shape: stdio as is, `http`/`streamable-http` as `type: http`; other client-specific keys are not
 * carried; SSE and WebSocket are refused by name. */
export function mcpImportEntry(value: unknown): { readonly ok: true; readonly entry: McpServerEntry } | { readonly ok: false; readonly reason: string } {
  const raw = record(value);
  if (!raw) return { ok: false, reason: 'invalid-entry' };
  const type = raw['type'], keep = (key: string) => raw[key] === undefined ? {} : { [key]: raw[key] };
  if (type !== undefined && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') return { ok: false, reason: 'transport-unsupported' };
  const shaped = type === 'http' || type === 'streamable-http' ? { type: 'http', url: raw['url'], ...keep('headers') } : { command: raw['command'], ...keep('args'), ...keep('env') };
  const parsed = mcpServerEntrySchema.safeParse(shaped);
  return parsed.success ? { ok: true, entry: parsed.data } : { ok: false, reason: 'invalid-entry' };
}
