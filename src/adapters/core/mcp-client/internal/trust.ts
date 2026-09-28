import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MCP_SCOPES } from './registry.js';

/**
 * MCP trust and tool pins as product state (MCP-CLIENT): the registry files say which servers exist; this record says which exact server
 * definitions the owner approved and which tool definitions were pinned then. It lives in the data root's `integrations` directory (no layout
 * or ledger schema change), private (0600) and replaced atomically; the agent tools and both sandboxes never reach the data root.
 */
export const MCP_TRUST_FILE = 'mcp-trust.json';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const scope = z.enum(MCP_SCOPES);
export const mcpTrustRecordSchema = z.object({
  scope, name: z.string().regex(/^[a-z][a-z0-9]{0,15}$/u), definitionDigest: digest,
  tools: z.array(z.object({ name: z.string().min(1).max(128), digest, alwaysAsk: z.boolean() }).strict()).max(512),
  approvedAtMs: z.number().int().nonnegative(), principal: z.object({ issuer: z.string().min(1).max(256), subject: z.string().min(1).max(256) }).strict(),
}).strict();
export type McpTrustRecord = z.infer<typeof mcpTrustRecordSchema>;
const fileSchema = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), servers: z.array(mcpTrustRecordSchema).max(256) }).strict();
export type McpTrustState = z.infer<typeof fileSchema>;
const EMPTY: McpTrustState = Object.freeze({ schemaVersion: 1, revision: 0, servers: [] });

/** The trust record: absent → nothing is trusted; unreadable or invalid → `ok: false` (callers trust nothing: fail closed). */
export async function readMcpTrust(directory: string): Promise<{ readonly ok: true; readonly state: McpTrustState } | { readonly ok: false; readonly reason: string }> {
  const path = join(directory, MCP_TRUST_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0) return { ok: false, reason: 'trust-store-unsafe' };
    const parsed = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? { ok: true, state: parsed.data } : { ok: false, reason: 'trust-store-invalid' };
  } catch (error) {
    return (error as { code?: unknown })?.code === 'ENOENT' ? { ok: true, state: EMPTY } : { ok: false, reason: 'trust-store-unreadable' };
  }
}
export const findMcpTrust = (state: McpTrustState, scopeName: McpTrustRecord['scope'], name: string) =>
  state.servers.find(record => record.scope === scopeName && record.name === name) ?? null;

/** Replaces the record through `change` (read, change, write a private temporary, rename); an unreadable record is never overwritten. */
export async function updateMcpTrust(directory: string, change: (state: McpTrustState) => McpTrustState['servers']): Promise<McpTrustState> {
  const current = await readMcpTrust(directory);
  if (!current.ok) throw Object.assign(new Error(current.reason), { code: 'MCP_TRUST_STORE_UNAVAILABLE' });
  const next = fileSchema.parse({ schemaVersion: 1, revision: current.state.revision + 1, servers: change(current.state) });
  const temporary = join(directory, `.${MCP_TRUST_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, join(directory, MCP_TRUST_FILE)); } catch (error) { await rm(temporary, { force: true }); throw error; }
  return next;
}
