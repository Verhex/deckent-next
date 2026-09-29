import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withConfigWriteLock } from '#platform/index.js';
import type { McpSandboxDiagnosis } from './diagnose.js';
import { MCP_SCOPES } from './registry.js';

/**
 * The last start failure of a server in this project (MCP-SANDBOX-PATHS follow-up, 2026-09-29): written when a turn could not start a server
 * (its first-use launch card said yes, or a trusted server), so the card is not asked again in a loop and `/mcp` can say why. Advisory only:
 * it may suppress a repeated first-use card, it never makes a server offered or trusted. Keyed by scope, name and definition digest (a changed
 * entry misses it); removed by `/mcp approve|reconnect|remove` and by a later successful start. Private (0600), atomic, in the data root's
 * `integrations` directory beside the trust record (no layout or ledger change; the agent's floors already close that directory). Every
 * value is display-safe: a diagnosis path written with `${VAR}` is kept as written, never expanded.
 */
export const MCP_START_FAILURES_FILE = 'mcp-start-failures.json';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (max: number) => z.string().max(max);
const diagnosisSchema = z.union([
  z.object({ kind: z.literal('path-hidden'), role: z.enum(['command', 'argument']), index: z.number().int().min(-1).max(1_024), path: text(4_096),
    target: text(4_096).optional() }).strict(),
  z.object({ kind: z.enum(['package-runner', 'container-daemon']), runner: text(64) }).strict(),
]);
export const mcpStartFailureSchema = z.object({ scope: z.enum(MCP_SCOPES), name: z.string().regex(/^[a-z][a-z0-9]{0,15}$/u), definitionDigest: digest,
  /** `launch`: the first-use card's yes could not start it; `trusted`: a trusted server did not start. */
  phase: z.enum(['launch', 'trusted']), atMs: z.number().int().nonnegative(), code: text(64), detail: text(200).optional(), diagnosis: diagnosisSchema.optional() }).strict();
export type McpStartFailure = z.infer<typeof mcpStartFailureSchema>;
const fileSchema = z.object({ schemaVersion: z.literal(1), failures: z.array(mcpStartFailureSchema).max(256) }).strict();
const matches = (failure: McpStartFailure, key: { readonly scope: string; readonly name: string }) => failure.scope === key.scope && failure.name === key.name;

/** The recorded failures; absent, unsafe or invalid reads as none (advisory: the worst case is asking a card again). */
export async function readMcpStartFailures(directory: string): Promise<readonly McpStartFailure[]> {
  const path = join(directory, MCP_START_FAILURES_FILE);
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0) return [];
    const parsed = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    return parsed.success ? parsed.data.failures : [];
  } catch { return []; }
}
export const findMcpStartFailure = (failures: readonly McpStartFailure[], key: { readonly scope: string; readonly name: string; readonly definitionDigest: string }) =>
  failures.find(failure => matches(failure, key) && failure.definitionDigest === key.definitionDigest) ?? null;

/** Records (`failure`) or removes (`null`) the entry of one server, under the file's config write lock (read, change, private temporary, rename). */
export async function updateMcpStartFailure(directory: string, key: { readonly scope: McpStartFailure['scope']; readonly name: string }, failure: McpStartFailure | null): Promise<void> {
  const path = join(directory, MCP_START_FAILURES_FILE);
  await withConfigWriteLock(path, async () => {
    const current = await readMcpStartFailures(directory);
    if (!failure && !current.some(entry => matches(entry, key))) return;
    const next = fileSchema.parse({ schemaVersion: 1, failures: [...current.filter(entry => !matches(entry, key)), ...(failure ? [failure] : [])].slice(-256) });
    const temporary = join(directory, `.${MCP_START_FAILURES_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }, 10_000);
}

/** The failure of one server as a start failure record (null: not a start failure — the notice still names it). `cause` carries the
 * display-safe diagnosis of MCP_SANDBOX_COMMAND_UNREACHABLE. */
export function mcpStartFailureOf(error: unknown): Pick<McpStartFailure, 'code' | 'detail' | 'diagnosis'> | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== 'MCP_SANDBOX_COMMAND_UNREACHABLE' && code !== 'MCP_SERVER_START_FAILED' && code !== 'MCP_SANDBOX_UNAVAILABLE') return null;
  const params = (error as { params?: Record<string, unknown> }).params ?? {}, cause = (error as { cause?: unknown }).cause;
  const parsed = diagnosisSchema.safeParse(cause);
  return { code, ...(typeof params['reason'] === 'string' ? { detail: params['reason'].slice(0, 200) } : {}), ...(parsed.success ? { diagnosis: parsed.data } : {}) };
}

/**
 * The owner-facing sentence of a start failure (the turn's notice and `/mcp`). CLEANUP-MARK: neutral English like the engine's closure
 * notes, until the catalog carries it (i18n-delta.json).
 */
export function describeMcpStartFailure(name: string, failure: Pick<McpStartFailure, 'code' | 'detail' | 'diagnosis' | 'phase'>): string {
  const diagnosis = failure.diagnosis as McpSandboxDiagnosis | undefined;
  const why = diagnosis?.kind === 'path-hidden'
    ? `the ${diagnosis.role} ${diagnosis.path}${diagnosis.target ? ` -> ${diagnosis.target}` : ''} exists on this machine but not in its bubblewrap sandbox view `
      + '(only the project, system directories and PATH toolchain directories are visible); move it into the project or a PATH toolchain directory, '
      + 'or re-add the server with --realm host (it then runs unsandboxed)'
    : diagnosis ? `${diagnosis.runner} ${diagnosis.kind === 'package-runner' ? 'fetches the server at start, but its sandbox has no network and an empty HOME'
      : 'needs its daemon socket, which is outside its sandbox'}; re-add the server with --realm host (it then runs unsandboxed)`
      + (diagnosis.kind === 'package-runner' ? ' or install it into the project or a PATH toolchain directory' : '')
    : `${failure.code}${failure.detail ? `: ${failure.detail}` : ''}`;
  const next = failure.phase === 'launch' ? `its first-use card is not asked again until you run /mcp approve ${name}`
    : `its tools are not offered; /mcp reconnect ${name} tries it again`;
  return `MCP server ${name} did not start: ${why}. ${next[0]!.toUpperCase()}${next.slice(1)}.`;
}
