import { z } from 'zod';
import { persistedInteger, persistedString } from '#domain/index.js';

const text = persistedString(z.string().min(1)).refine(value => !value.includes('\0'));
const positive = persistedInteger().positive().max(Number.MAX_SAFE_INTEGER);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const flag = z.string().regex(/^--[a-z][a-z-]*$/u);
const args = z.array(z.string().refine(value => !value.includes('\0'))).readonly();
export const nativeAgentLoginMethodSchema = z.enum(['claudeai', 'browser', 'device-auth']);
export type NativeAgentLoginMethod = z.infer<typeof nativeAgentLoginMethodSchema>;

/** R is the only active topology. P describes flags only; enabling a fallback needs a new explicit decision. */
export const nativeAgentBridgeSchema = z.strictObject({ schemaVersion: z.literal(1), topology: z.literal('relay-http'), source: text,
  sentinelHost: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.invalid$/u), path: z.string().regex(/^\/[a-z][a-z0-9/-]*$/u),
  serverName: z.string().regex(/^[a-z][a-z0-9_]*$/u), toolPrefix: z.string().regex(/^mcp__[a-z][a-z0-9_]*__$/u),
  tokenHeaderName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/u), tokenEnvName: envName, tokenValueTemplate: z.literal('Bearer {turnToken}'),
  bodyMaxBytes: positive, frameMaxBytes: positive, limitsSource: text,
  fallback: z.strictObject({ enabled: z.literal(false), permissionFlags: z.tuple([z.literal('--permission'), z.literal('--allow-net')]).readonly(), source: text }).readonly(),
}).refine(value => value.frameMaxBytes <= value.bodyMaxBytes && value.toolPrefix === `mcp__${value.serverName}__`).readonly();
export type NativeAgentBridge = z.infer<typeof nativeAgentBridgeSchema>;

const loginMethods = z.array(z.strictObject({ method: nativeAgentLoginMethodSchema, args, source: text }).readonly()).min(1).readonly()
  .refine(rows => new Set(rows.map(row => row.method)).size === rows.length);
const streamJsonTransportSchema = z.strictObject({ kind: z.literal('claude-mcp'), source: text,
  mcpConfig: z.strictObject({ flag: z.literal('--mcp-config'), value: z.literal('{mcpConfigFile}'), fileName: z.string().regex(/^[a-z][a-z0-9.-]*\.json$/u),
    server: z.strictObject({ type: z.literal('http'), url: z.literal('{bridgeUrl}'), headers: z.record(z.string(), z.literal('{turnTokenHeader}')).readonly(),
      timeout: z.literal('{approvalTtlMs}') }).readonly() }).readonly(),
  guards: z.strictObject({ permissionMode: text, apiKeySources: z.array(text).min(1).readonly(),
    plugins: z.array(z.strictObject({ name: text, path: text, source: text }).readonly()).readonly(), source: text }).readonly(),
}).readonly();
const execJsonTransportSchema = z.strictObject({ kind: z.literal('codex-mcp'), source: text, configFlag: z.literal('-c'),
  mcpConfig: z.strictObject({ url: z.literal('{bridgeUrl}'), bearer_token_env_var: z.literal('{turnTokenEnv}'), required: z.literal(true),
    enabled_tools: z.literal('{toolNames}'), omit_tools_from: z.tuple([z.literal('deferred'), z.literal('code_mode')]).readonly(),
    default_tools_approval_mode: z.literal('approve'), tool_timeout_sec: z.literal('{approvalTtlSeconds}') }).readonly(), approvalModeSource: text,
  guards: z.strictObject({ allowedItems: z.array(z.enum(['agent_message', 'mcp_tool_call', 'reasoning'])).min(1).readonly(), codeModeError: text, source: text }).readonly(),
}).readonly();
/** The agent profile inherits all v1 environment, isolation and output bounds. It has its own argv and forbidden set. */
export const nativeCliAgentSchema = z.strictObject({ schemaVersion: z.literal(1), capability: z.literal('NativeAgentExecution'), revision: text, source: text,
  args, forbiddenFlags: z.array(flag).min(1).readonly(), envSource: z.literal('headless'), loginMethods,
  timeoutSource: z.literal('tool-session-approval-ttl'), maxTurnsSource: z.literal('admission-policy'),
  transport: z.discriminatedUnion('kind', [streamJsonTransportSchema, execJsonTransportSchema]),
}).refine(value => {
  if (value.args.some(arg => value.forbiddenFlags.some(flag => arg === flag || arg.startsWith(flag + '=')))) return false;
  if (value.transport.kind !== 'claude-mcp') return true;
  const at = value.args.indexOf(value.transport.mcpConfig.flag);
  // Exactly one generated-file slot; an inline value or a second occurrence cannot introduce a free config path.
  return at >= 0 && value.args[at + 1] === value.transport.mcpConfig.value
    && value.args.filter(arg => arg === '--mcp-config' || arg.startsWith('--mcp-config=')).length === 1
    && value.args.includes('--allowedTools') && value.args[value.args.indexOf('--allowedTools') + 1] === '{toolList}'
    && value.args.includes('--max-turns') && value.args[value.args.indexOf('--max-turns') + 1] === '{maxTurns}';
}).readonly();
export type NativeCliAgent = z.infer<typeof nativeCliAgentSchema>;
