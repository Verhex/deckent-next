import { lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { toolSessionSchema, type ToolSession } from '#capabilities/index.js';
import { nativeEffortArgs, type nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';

type Entry = NonNullable<ReturnType<typeof nativeCliAgent>>;
import { ClaudeAgentError } from '#capabilities/index.js';
export { createClaudeAgentDriver, ClaudeAgentError, type ClaudeAgentDriver, type ClaudeAgentResult } from '#capabilities/index.js';
function invalid(field: string): never { throw new ClaudeAgentError('NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', field); }

/** The caller owns the existing private run dir and removes these files after the isolated process exits. No subscription state is read. */
export async function prepareClaudeAgentRun(entry: Entry, sessionInput: ToolSession, input: Readonly<{ runDir: string; model: string; system: string;
  turnToken: string; effort?: string }>) {
  const session = toolSessionSchema.parse(sessionInput), { agent, bridge, headless, command } = entry, { runDir, model, system, turnToken } = input;
  if (agent.transport.kind !== 'claude-mcp') invalid('transport');
  if (!isAbsolute(runDir) || await realpath(runDir).catch(() => null) !== resolve(runDir)) invalid('run-dir');
  const info = await lstat(runDir).catch(() => null);
  if (!info?.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) invalid('run-dir');
  if (!model || model.startsWith('-') || model.includes('\0') || command.modelAliases.includes(model) || !turnToken || /[\r\n\0]/u.test(turnToken)) invalid('request');
  if (Buffer.byteLength(system) > headless.limits.stdinMaxBytes) invalid('size');
  const transport = agent.transport, configFile = join(runDir, transport.mcpConfig.fileName), promptFile = join(runDir, headless.systemPromptFile);
  const slots: Record<string, string> = { '{mcpConfigFile}': configFile, '{toolList}': session.tools.map(tool => bridge.toolPrefix + tool.name).join(',') };
  // The template carries an admission-policy slot; the current product has no total-turn budget. Do not invent one from the text profile's 1.
  const args = agent.args.filter((arg, i) => arg !== '{maxTurns}' && agent.args[i + 1] !== '{maxTurns}').map(arg => slots[arg] ?? arg);
  const promptArgs = headless.systemPromptArgs?.map(arg => arg.replaceAll('{file}', promptFile)) ?? [headless.systemPromptFlag, promptFile];
  const capability = command.capabilities.reasoningEffort;
  if (input.effort !== undefined && !capability?.levels.includes(input.effort as never)) invalid('effort');
  const effortArgs = input.effort === undefined ? [] : nativeEffortArgs(capability, { schemaVersion: 1, level: input.effort as never, source: 'explicit', status: 'selected' });
  args.push(command.modelFlag, model, ...effortArgs, ...promptArgs);
  if (args.some(arg => /\{(?:mcpConfigFile|toolList|maxTurns)\}/u.test(arg) || arg.includes('\0')
    || agent.forbiddenFlags.some(flag => arg === flag || arg.startsWith(flag + '='))) || args.some(arg => arg.includes(turnToken))) invalid('argv');
  const template = transport.mcpConfig.server, header = bridge.tokenValueTemplate.replace('{turnToken}', turnToken);
  if (Object.keys(template.headers).length !== 1 || !Object.hasOwn(template.headers, bridge.tokenHeaderName)) invalid('headers');
  const config = { mcpServers: { [bridge.serverName]: { type: template.type, url: `http://${bridge.sentinelHost}${bridge.path}`,
    headers: { [bridge.tokenHeaderName]: header }, timeout: session.approvalTtlMs } } };
  if (Buffer.byteLength(JSON.stringify(config)) > bridge.bodyMaxBytes) invalid('size');
  const owned: string[] = [];
  try {
    for (const [path, content] of [[configFile, JSON.stringify(config)], [promptFile, system]] as const) {
      const file = await open(path, 'wx', 0o600); owned.push(path);
      try { await file.writeFile(content); } finally { await file.close(); }
    }
  } catch { await Promise.all(owned.map(path => rm(path, { force: true }))); invalid('run-files'); }
  return Object.freeze({ args: Object.freeze(args), configFile, promptFile,
    async dispose() { await Promise.all(owned.splice(0).map(path => rm(path, { force: true }))); } });
}
