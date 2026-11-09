import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeAgentCorrelation, ToolSession } from '#capabilities/index.js';
import { nativeCliAgentBridge, type nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeEgressLimits } from '#adapters/core/native-connection/index.js';
import { prepareClaudeAgentRun } from './claude-agent.js';
import { codexAgentArgv } from './codex-agent.js';
import { buildHeadlessEnv } from './env.js';

type Entry = NonNullable<ReturnType<typeof nativeCliAgent>>;
type NativeAgentLaunchInput = Readonly<{ session: ToolSession; runDir: string; configDir: string; model: string; system: string; user: string;
  effortArgs: readonly string[]; maxTurns?: number; turnToken: string; bridgeUrl: string; timeoutMs: number; outputMaxBytes: number }>;
type Run = Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>>; mcpConfigFile?: string; dispose(): Promise<void> }>;
/** KG7 F1: per transport kind, its run files, the turn token's one channel and the bridge's correlation kind (chat and worker launch alike). */
const TRANSPORTS: Readonly<Record<Entry['agent']['transport']['kind'], Readonly<{ correlation: NativeAgentCorrelation['kind'];
  run(entry: Entry, input: NativeAgentLaunchInput, promptFile: string): Promise<Run> }>>> = {
  // [floor] Claude reads the token from its private MCP config header only; never env or argv.
  'claude-mcp': { correlation: 'claude-tool-use', async run(entry, input) {
    const files = await prepareClaudeAgentRun(entry, input.session, input);
    return { args: files.args, env: {}, mcpConfigFile: files.configFile, dispose: () => files.dispose() };
  } },
  // [floor] Codex reads the token from its named environment variable only; never argv.
  'codex-mcp': { correlation: 'codex-mcp', async run(entry, input, promptFile) {
    const args = codexAgentArgv(entry, input.session, input.runDir, input.model, input.effortArgs, input.bridgeUrl);
    await writeFile(promptFile, input.system, { mode: 0o600, flag: 'wx' });
    return { args, env: { [entry.bridge.tokenEnvName]: input.turnToken }, dispose: () => rm(promptFile, { force: true }) };
  } },
};
export const nativeAgentCorrelationKind = (entry: Entry) => TRANSPORTS[entry.agent.transport.kind].correlation;
/** The one native agent launch: the spawn's argv, env and run files plus its bounds. The caller owns the run dir and calls `dispose` first. */
export async function nativeAgentLaunch(entry: Entry, input: NativeAgentLaunchInput) {
  const promptFile = join(input.runDir, entry.headless.systemPromptFile), limits = entry.headless.limits;
  const { env, dispose, ...run } = await TRANSPORTS[entry.agent.transport.kind].run(entry, input, promptFile);
  return Object.freeze({ dispose, spawn: { ...run, env: Object.freeze({ ...buildHeadlessEnv(entry.headless, input.runDir, input.configDir), ...env }), runDir: input.runDir,
    configDir: input.configDir, promptFile }, bounds: { timeoutMs: input.timeoutMs, outputBytes: 2 * input.outputMaxBytes + limits.responseFramingBytes, stderrBytes: limits.stderrMaxBytes,
    maxLineBytes: limits.maxLineBytes, interruptGraceMs: limits.killGraceMs, stdinBase64: Buffer.from(input.user).toString('base64') } });
}
/** KG7 F6: the agent bridge's limits for chat and worker alike; undefined (the feature is off) unless the registry bridge is complete and below the egress connection bound. */
export function nativeBridgeLimits() {
  const bridge = nativeCliAgentBridge(), egress = nativeEgressLimits();
  if (!bridge?.maxConnections || !bridge.replayMaxEntries || !bridge.replayMaxBytes || bridge.maxConnections >= egress.connections) return undefined;
  return Object.freeze({ idleMs: egress.idleMs, maxConnections: bridge.maxConnections, replayMaxEntries: bridge.replayMaxEntries, replayMaxBytes: bridge.replayMaxBytes });
}
