import { z } from 'zod';
import type { AgentToolSpec } from '#domain/index.js';
import { projectModelIngressField } from '#engine/index.js';
import { isMcpHttpEntry, mcpEndpointRefusal, mcpServerEntrySchema, MCP_DEFAULT_REALM, MCP_SERVER_NAME, type McpServerEntry } from './registry.js';

/**
 * Model-proposed MCP servers (L1 item 5, owner 2026-10-07): the model may only PROPOSE a server; the proposal opens its own human card in every
 * mode (full-auto and full-access included: no permission mode lowers it) and, only after that yes, Deckent adds it to the local registry
 * untrusted, so the normal trust cards follow on the next message. The model never writes the registry. Every string of the proposal passes the
 * model-ingress check.
 * Security (owner, Jev 30efcb91: no secrets in a proposal): a proposal carries no secret and no environment reference at all — no env or header
 * values, no `$DECK:NAME`, `${VAR}` or `$VAR` anywhere (URL, command, arguments) — so a model can never route a person's secret to an address it
 * chose. It may only name the settings the server needs; the server is added without them and a person binds them in `/mcp`, where the secret's
 * name and its destination are shown together.
 */
export const PROPOSE_MCP_SERVER_TOOL = 'propose_mcp_server';
const text = (max: number) => z.string().min(1).max(max);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const proposalSchema = z.object({
  name: text(32), transport: z.enum(['stdio', 'http']), reason: text(1_000),
  command: text(4_096).optional(), args: z.array(z.string().max(4_096)).max(64).optional(), url: text(4_096).optional(),
  realm: z.enum(['sandbox-net', 'require-sandbox', 'prefer-sandbox', 'host']).optional(),
  /** The names of the settings a person must bind after adding (env variables of a stdio server, headers of an HTTP server) — never a value. */
  requiredSettings: z.array(z.string().max(128)).max(64).optional(),
}).strict();
export type McpProposal = z.infer<typeof proposalSchema>;
export const MCP_PROPOSAL_SECRETS_REFUSED = 'secrets-bound-by-person';
export const PROPOSE_MCP_SERVER_TOOL_SPEC: AgentToolSpec = Object.freeze({ name: PROPOSE_MCP_SERVER_TOOL, version: 1, toolClass: 'read',
  description: 'Propose adding an MCP server to this project. The person sees the proposal in an approval window and decides; nothing is added '
    + 'without their approval, and the server is trusted (and its tools offered) only after its own trust approval. A proposal never carries a '
    + 'secret or an environment reference: list only the NAMES of the env variables or headers the server needs in requiredSettings; a person '
    + 'binds their values in /mcp after adding.',
  // `env` and `headers` are declared only so that a model that still sends them gets the typed refusal (`secrets-bound-by-person`), not a bare
  // unknown-argument error: they are never accepted.
  inputSchema: { type: 'object' as const, additionalProperties: false, required: ['name', 'transport', 'reason'], properties: {
    env: { type: 'object', description: 'Not accepted: values (secrets included) are bound by a person in /mcp; name them in requiredSettings.' },
    headers: { type: 'object', description: 'Not accepted: values (secrets included) are bound by a person in /mcp; name them in requiredSettings.' },
    name: { type: 'string', description: 'Lower case, digits and single inner hyphens (1-32).' }, transport: { type: 'string', enum: ['stdio', 'http'] },
    command: { type: 'string', description: 'stdio: the command.' }, args: { type: 'array', items: { type: 'string' } },
    url: { type: 'string', description: 'http: the Streamable HTTP endpoint (https).' },
    realm: { type: 'string', enum: ['sandbox-net', 'require-sandbox', 'prefer-sandbox', 'host'], description: 'stdio: where it runs (default sandbox-net).' },
    requiredSettings: { type: 'array', items: { type: 'string' }, description: 'Names only (env variables for stdio, headers for http) a person must bind.' },
    reason: { type: 'string', description: 'Why this server is needed, for the person who decides.' } } } });

/** Any secret or environment reference: `$DECK:NAME`, `${VAR}`, `$VAR`. */
const REFERENCE = /\$(?:DECK:|\{|[A-Za-z_])/u;
export type McpProposalPlan = { readonly ok: true; readonly proposal: McpProposal; readonly entry: McpServerEntry } | { readonly ok: false; readonly reason: string };
/** Checks one proposal (no secret or reference, shape, ingress of every string, name, the entry the registry would hold); nothing is written. */
export function planMcpProposal(args: Record<string, unknown>): McpProposalPlan {
  // Values a person binds are refused by name, before anything else (the model is told where they belong).
  if ('env' in args || 'headers' in args) return { ok: false, reason: MCP_PROPOSAL_SECRETS_REFUSED };
  const parsed = proposalSchema.safeParse(args);
  if (!parsed.success) return { ok: false, reason: 'invalid-proposal' };
  const proposal = parsed.data, strings: [string, string][] = [['name', proposal.name], ['reason', proposal.reason], ['command', proposal.command ?? ''], ['url', proposal.url ?? ''],
    ...(proposal.args ?? []).map((value, index): [string, string] => [`args.${index}`, value]),
    ...(proposal.requiredSettings ?? []).map((value, index): [string, string] => [`requiredSettings.${index}`, value])];
  if ([proposal.command ?? '', proposal.url ?? '', ...(proposal.args ?? [])].some(value => REFERENCE.test(value))) return { ok: false, reason: MCP_PROPOSAL_SECRETS_REFUSED };
  for (const [field, value] of strings) if (projectModelIngressField(value).disposition !== 'unchanged') return { ok: false, reason: `ingress-refused:${field}` };
  if (!MCP_SERVER_NAME.test(proposal.name)) return { ok: false, reason: 'invalid-name' };
  const nameRule = proposal.transport === 'http' ? HEADER_NAME : ENV_NAME;
  if ((proposal.requiredSettings ?? []).some(name => !nameRule.test(name))) return { ok: false, reason: 'invalid-setting-name' };
  const raw = proposal.transport === 'http' ? { type: 'http', url: proposal.url }
    : { command: proposal.command, ...(proposal.args ? { args: proposal.args } : {}), realm: proposal.realm ?? MCP_DEFAULT_REALM };
  const entry = mcpServerEntrySchema.safeParse(raw);
  if (!entry.success || (proposal.transport === 'http' && (proposal.command || proposal.args || proposal.realm)) || (proposal.transport === 'stdio' && proposal.url))
    return { ok: false, reason: 'invalid-entry' };
  const refused = isMcpHttpEntry(entry.data) ? mcpEndpointRefusal(entry.data.url) : null;
  return refused ? { ok: false, reason: refused } : { ok: true, proposal, entry: entry.data };
}
