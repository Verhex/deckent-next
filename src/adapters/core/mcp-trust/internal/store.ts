import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorRegistry, withConfigWriteLock } from '#platform/index.js';
import REGISTRY from './registry.json' with { type: 'json' };

/**
 * MCP trust and tool pins as product state (MCP-CLIENT): the registry files say which servers exist; this record says which exact server
 * definitions the owner trusted (or declined) and which tool definitions were pinned then. SEC-2 (F29): every record lives outside the project
 * tree — user trust beside the personal registry in the Deckent global root (owner 2026-09-28), project and local trust in that root's
 * per-project directory (`location.ts`); a file inside the project is never read as trust. Private (0600, owner, one link), bounded, replaced
 * atomically under the cross-process config write lock; the agent tools and both sandboxes never reach the global root (hard floor).
 */
export const MCP_TRUST_FILE = 'mcp-trust.json';
/** The scopes of the MCP registry, highest precedence first (`registry.ts` re-exports them). */
export const MCP_SCOPES = ['managed', 'local', 'project', 'user'] as const;
/** 1–32 chars, lower case, digits and single inner hyphens. No `--` and no edge hyphen: the wire name maps `-` to `_`, and the first `__` after `mcp__` must stay the
 * server/tool separator, so two different names can never share a wire prefix (`mcp__a_b__x` is only `a-b`, never server `a` with tool `b__x`). */
export const MCP_SERVER_NAME = /^(?=.{1,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const scope = z.enum(MCP_SCOPES);
export const mcpTrustRecordSchema = z.object({
  scope, name: z.string().regex(MCP_SERVER_NAME), definitionDigest: digest,
  tools: z.array(z.object({ name: z.string().min(1).max(128), digest, alwaysAsk: z.boolean() }).strict()).max(512),
  /** `trusted`: offered; `declined`: the owner said no for this definition (not asked again until it changes or is reset). */
  decision: z.enum(['trusted', 'declined']),
  /** Bumped by `/mcp reconnect`: the service replaces the running process on its next use. */
  reconnect: z.number().int().nonnegative(),
  approvedAtMs: z.number().int().nonnegative(), principal: z.object({ issuer: z.string().min(1).max(256), subject: z.string().min(1).max(256) }).strict(),
}).strict();
export type McpTrustRecord = z.infer<typeof mcpTrustRecordSchema>;
const fileSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), servers: z.array(mcpTrustRecordSchema).max(256) }).strict();
export type McpTrustState = z.infer<typeof fileSchema>;
const EMPTY: McpTrustState = Object.freeze({ schemaVersion: 1, revision: 0, servers: [] });

/** The trust record: absent → nothing is trusted; not a private single-link file of this user, too large, unreadable or invalid → `ok: false`
 * (callers trust nothing: fail closed). */
export async function readMcpTrust(directory: string): Promise<{ readonly ok: true; readonly state: McpTrustState } | { readonly ok: false; readonly reason: string }> {
  const path = join(directory, MCP_TRUST_FILE);
  try {
    const info = await lstat(path), uid = process.getuid?.();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || (uid !== undefined && info.uid !== uid)) return { ok: false, reason: 'trust-store-unsafe' };
    if (info.size > REGISTRY.trustMaxBytes) return { ok: false, reason: 'trust-store-too-large' };
    const parsed = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? { ok: true, state: parsed.data } : { ok: false, reason: 'trust-store-invalid' };
  } catch (error) {
    return (error as { code?: unknown })?.code === 'ENOENT' ? { ok: true, state: EMPTY } : { ok: false, reason: 'trust-store-unreadable' };
  }
}
export const findMcpTrust = (state: McpTrustState, scopeName: McpTrustRecord['scope'], name: string) =>
  state.servers.find(record => record.scope === scopeName && record.name === name) ?? null;

/** Replaces the record through `change` inside the config write lock of the file (read, change, write a private temporary, rename); an
 * unreadable record is never overwritten, and two writers never lose each other's change. */
export async function updateMcpTrust(directory: string, change: (state: McpTrustState) => McpTrustState['servers']): Promise<McpTrustState> {
  return withConfigWriteLock(join(directory, MCP_TRUST_FILE), async () => {
    const current = await readMcpTrust(directory);
    if (!current.ok) throw ErrorRegistry.createError('MCP_TRUST_STORE_UNAVAILABLE', { params: { reason: current.reason } });
    const next = fileSchema.parse({ schemaVersion: 1, revision: current.state.revision + 1, servers: change(current.state) });
    const temporary = join(directory, `.${MCP_TRUST_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, join(directory, MCP_TRUST_FILE)); } catch (error) { await rm(temporary, { force: true }); throw error; }
    return next;
  }, 10_000);
}
