import { z } from 'zod';
import type { AgentToolSpec } from '#domain/index.js';
import { projectModelIngressField } from '#engine/index.js';
import { isMcpHttpEntry, mcpEndpointRefusal, mcpServerEntrySchema, MCP_DEFAULT_REALM, MCP_SERVER_NAME, type McpServerEntry } from './registry.js';

/**
 * Model-proposed MCP servers (L1 item 5, owner 2026-10-07): the model may only PROPOSE a server; the proposal opens its own human card in every
 * mode (full-auto and full-access included: no permission mode lowers it) and, only after that yes, Deckent adds it to the local registry
 * untrusted, so the normal trust cards (and the K1 grant) follow on the next message. The model never writes the registry. Every string of the
 * proposal passes the model-ingress check; env and header values may only be references (`${VAR}`, `$DECK:NAME`): the model never carries a
 * secret into a registry file, and the card shows the NAMES only.
 */
export const PROPOSE_MCP_SERVER_TOOL = 'propose_mcp_server';
const text = (max: number) => z.string().min(1).max(max);
const references = z.record(z.string().max(128), z.string().max(4_096)).refine(values => Object.keys(values).length <= 64);
const proposalSchema = z.object({
  name: text(32), transport: z.enum(['stdio', 'http']), reason: text(1_000),
  command: text(4_096).optional(), args: z.array(z.string().max(4_096)).max(64).optional(), env: references.optional(),
  url: text(4_096).optional(), headers: references.optional(), realm: z.enum(['sandbox-net', 'require-sandbox', 'prefer-sandbox', 'host']).optional(),
}).strict();
export type McpProposal = z.infer<typeof proposalSchema>;
export const PROPOSE_MCP_SERVER_TOOL_SPEC: AgentToolSpec = Object.freeze({ name: PROPOSE_MCP_SERVER_TOOL, version: 1, toolClass: 'read',
  description: 'Propose adding an MCP server to this project. The person sees the proposal in an approval window and decides; nothing is added '
    + 'without their approval, and the server is trusted (and its tools offered) only after its own trust approval. Give env and header values only '
    + 'as references (${VAR} or $DECK:NAME), never a secret value.',
  inputSchema: { type: 'object' as const, additionalProperties: false, required: ['name', 'transport', 'reason'], properties: {
    name: { type: 'string', description: 'Lower case, digits and single inner hyphens (1-32).' }, transport: { type: 'string', enum: ['stdio', 'http'] },
    command: { type: 'string', description: 'stdio: the command.' }, args: { type: 'array', items: { type: 'string' } },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'stdio: NAME -> ${VAR} or $DECK:NAME.' },
    url: { type: 'string', description: 'http: the Streamable HTTP endpoint (https).' },
    headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'http: Name -> a value naming ${VAR} or $DECK:NAME.' },
    realm: { type: 'string', enum: ['sandbox-net', 'require-sandbox', 'prefer-sandbox', 'host'], description: 'stdio: where it runs (default sandbox-net).' },
    reason: { type: 'string', description: 'Why this server is needed, for the person who decides.' } } } });

/** A value that names no secret: references only (`${VAR}`, `${VAR:-x}`, `$DECK:NAME`), optionally after a scheme word (`Bearer $DECK:NAME`). */
const REFERENCE_ONLY = /^(?:[A-Za-z]+ )?(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}|\$DECK:[A-Z_][A-Z0-9_]*)$/u;
export type McpProposalPlan = { readonly ok: true; readonly proposal: McpProposal; readonly entry: McpServerEntry } | { readonly ok: false; readonly reason: string };
/** Checks one proposal (shape, ingress of every string, name, references only, the entry the registry would hold); nothing is written. */
export function planMcpProposal(args: Record<string, unknown>): McpProposalPlan {
  const parsed = proposalSchema.safeParse(args);
  if (!parsed.success) return { ok: false, reason: 'invalid-proposal' };
  const proposal = parsed.data, strings: [string, string][] = [['name', proposal.name], ['reason', proposal.reason], ['command', proposal.command ?? ''], ['url', proposal.url ?? ''],
    ...(proposal.args ?? []).map((value, index): [string, string] => [`args.${index}`, value]),
    ...Object.entries({ ...proposal.env, ...proposal.headers }).flatMap(([key, value]): [string, string][] => [[`key.${key}`, key], [`value.${key}`, value]])];
  for (const [field, value] of strings) if (projectModelIngressField(value).disposition !== 'unchanged') return { ok: false, reason: `ingress-refused:${field}` };
  if (!MCP_SERVER_NAME.test(proposal.name)) return { ok: false, reason: 'invalid-name' };
  for (const [key, value] of Object.entries({ ...proposal.env, ...proposal.headers })) if (!REFERENCE_ONLY.test(value)) return { ok: false, reason: `literal-value:${key}` };
  const raw = proposal.transport === 'http'
    ? { type: 'http', url: proposal.url, ...(proposal.headers ? { headers: proposal.headers } : {}) }
    : { command: proposal.command, ...(proposal.args ? { args: proposal.args } : {}), ...(proposal.env ? { env: proposal.env } : {}), realm: proposal.realm ?? MCP_DEFAULT_REALM };
  const entry = mcpServerEntrySchema.safeParse(raw);
  if (!entry.success || (proposal.transport === 'http' && (proposal.command || proposal.args || proposal.env || proposal.realm))
    || (proposal.transport === 'stdio' && (proposal.url || proposal.headers))) return { ok: false, reason: 'invalid-entry' };
  const refused = isMcpHttpEntry(entry.data) && !entry.data.url.includes('${') ? mcpEndpointRefusal(entry.data.url) : null;
  return refused ? { ok: false, reason: refused } : { ok: true, proposal, entry: entry.data };
}
