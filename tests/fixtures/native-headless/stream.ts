// Neutral stream-json lines with the shapes measured in HEADLESS-0 (2026-10-23): no real model id, path, account or plugin source.
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

export const PINNED = 'vendor-model-pinned';
export const FAMILY = 'claude-code-stream-json';
export const headless = registry.adapters.claude.headless;
export const builtinPlugins = headless.guards.plugins.map(plugin => ({ ...plugin, source: `${plugin.name}@builtin` }));
type Line = Record<string, unknown>;
export const uiLine = (): Line => ({ type: 'system', subtype: 'ui_invalidate', event: 'ui.render', uuid: 'u-0', session_id: 's-1' });
export const initLine = (over: Line = {}): Line => ({ type: 'system', subtype: 'init', cwd: '/run/dir', session_id: 's-1', tools: [], mcp_servers: [], model: PINNED,
  permissionMode: 'dontAsk', slash_commands: [], apiKeySource: 'none', claude_code_version: '9.1.0', output_style: 'default', agents: ['general-purpose'], skills: [],
  plugins: builtinPlugins, capabilities: ['interrupt_receipt_v1'], analytics_disabled: true, uuid: 'u-1', ...over });
export const assistantLine = (text: string, model = PINNED): Line => ({ type: 'assistant', session_id: 's-1', uuid: 'u-2', parent_tool_use_id: null,
  message: { model, id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: null,
    usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 584, output_tokens: 8 } } });
export const rateLimitLine = (status = 'allowed', over: Line = {}): Line => ({ type: 'rate_limit_event', session_id: 's-1', uuid: 'u-3', rate_limit_info: { status,
  resetsAt: 1792773600, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1792773600 }, seven_day: { utilization: 0.73, resetsAt: 1793034000 } }, ...over } });
export const resultLine = (text: string, over: Line = {}, model = PINNED): Line => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 1,
  duration_ms: 3427, duration_api_ms: 3401, stop_reason: 'end_turn', session_id: 's-1', total_cost_usd: 0.0003, result: text, api_error_status: null,
  usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 584, output_tokens: 9, output_tokens_details: { thinking_tokens: 0 } },
  modelUsage: { [model]: { inputTokens: 2, outputTokens: 9, cacheReadInputTokens: 584, cacheCreationInputTokens: 0, costUSD: 0.0003, costBasis: 'list' } },
  permission_denials: [], terminal_reason: 'completed', uuid: 'u-4', ...over });
export const happyLines = (text: string) => [uiLine(), initLine(), assistantLine(text), rateLimitLine(), resultLine(text)];

/** One scripted step of the fake CLI's `-p` call. */
export type FakeStep = { line: Line | string } | { sleepMs: number } | { floodBytes: number } | { hang: true; ignoreInterrupt?: boolean } | { exit: number };
export interface FakeScenario {
  readonly logPath: string; readonly version?: string; readonly help?: string; readonly probeRefusal?: string | null; readonly systemProbeRefusal?: string | null;
  readonly auth?: Record<string, unknown>; readonly authExit?: number; readonly steps?: readonly FakeStep[]; readonly initCwd?: 'actual';
  /** The Nth model call (0-based) replays `stepsByCall[N]` when present, else `steps` (a quota refusal then an answer, for example). */
  readonly stepsByCall?: readonly (readonly FakeStep[])[];
}
/** Help text naming every listed flag the registry needs, the way the CLI's help lists options (the hidden ones are absent, as in CLI 2.1.309). */
export function fullHelp(): string {
  const hidden = new Set(headless.preflight.hiddenFlags.map(row => row.flag));
  const flags = new Set([...headless.args.filter(arg => arg.startsWith('--')), headless.systemPromptFlag, registry.adapters.claude.modelFlag,
    ...registry.adapters.claude.capabilities.reasoningEffort.requiredFlags].filter(name => !hidden.has(name)));
  return `Usage: cli [options]\n${[...flags].map(flag => `  ${flag} <value>  option`).join('\n')}\n`;
}
/**
 * Writes an executable fake CLI (absolute node shebang: the built PATH is a fixed registry value). It serves `--version`, `--help`, the
 * hidden `--max-turns` probe and `auth status --json`, and for the call records argv, environment, cwd, stdin and the system prompt file,
 * then replays the scenario's steps. Every invocation appends one JSON line to `logPath`.
 */
export async function writeFakeCli(dir: string, scenario: FakeScenario): Promise<string> {
  const path = join(dir, 'fake-cli');
  const config = { version: '9.1.0', help: fullHelp(), probeRefusal: registry.adapters.claude.capabilities.maxTurns.hiddenHelpProbe.refusal,
    systemProbeRefusal: `option '${headless.systemPromptFlag} <file>' argument missing`,
    auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'fixture', email: 'person@example.invalid', orgId: 'org-fixture',
      orgName: 'Fixture Org' }, authExit: 0, steps: [], ...scenario };
  const script = `#!${process.execPath}
const fs = require('node:fs'); const s = ${JSON.stringify(config)}; const argv = process.argv.slice(2);
const log = entry => fs.appendFileSync(s.logPath, JSON.stringify({ argv, env: { ...process.env }, cwd: process.cwd(), ...entry }) + '\\n');
if (argv[0] === '--version') { log({ mode: 'version' }); process.stdout.write(s.version + ' (fixture)\\n'); process.exit(0); }
if (argv[0] === '--help') { log({ mode: 'help' }); process.stdout.write(s.help); process.exit(0); }
if (argv[0] === '--print' && argv.length === 2 && argv[1] === ${JSON.stringify(headless.systemPromptFlag)}) { log({ mode: 'probe-system', entries: fs.readdirSync('.') }); process.stderr.write('error: ' + (s.systemProbeRefusal ?? "unknown option '" + argv[1] + "'") + '\\n'); process.exit(1); }
if (argv[0] === '--max-turns') { log({ mode: 'probe' }); if (s.probeRefusal) process.stderr.write('error: ' + s.probeRefusal + '\\n'); process.exit(s.probeRefusal ? 1 : 0); }
if (argv[0] === 'auth') { log({ mode: 'auth' }); process.stdout.write(JSON.stringify({ ...s.auth, configDirectory: s.auth.configDirectory ?? process.env.CLAUDE_CONFIG_DIR })); process.exit(s.authExit); }
const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', async () => {
  const promptFile = argv[argv.indexOf(${JSON.stringify(headless.systemPromptFlag)}) + 1];
  const index = fs.existsSync(s.logPath) ? fs.readFileSync(s.logPath, 'utf8').split('\\n').filter(line => line.includes('"mode":"call"')).length : 0;
  const steps = (s.stepsByCall ?? [])[index] ?? s.steps;
  log({ mode: 'call', stdin: Buffer.concat(chunks).toString('utf8'), system: fs.readFileSync(promptFile, 'utf8'), systemMode: fs.statSync(promptFile).mode & 0o777,
    entries: fs.readdirSync('.').sort() });
  for (const step of steps) {
    if (step.line !== undefined) { const line = typeof step.line === 'string' ? step.line : JSON.stringify(step.line.subtype === 'init' && s.initCwd === 'actual' && step.line.cwd === '/run/dir' ? { ...step.line, cwd: process.cwd() } : step.line); process.stdout.write(line + '\\n'); }
    else if (step.sleepMs !== undefined) await new Promise(resolve => setTimeout(resolve, step.sleepMs));
    else if (step.floodBytes !== undefined) process.stdout.write('x'.repeat(step.floodBytes));
    else if (step.hang) { if (step.ignoreInterrupt) process.on('SIGINT', () => log({ mode: 'interrupted' })); else process.on('SIGINT', () => { log({ mode: 'interrupted' }); process.exit(130); }); setInterval(() => {}, 1000); return; }
    else if (step.exit !== undefined) process.exit(step.exit);
  }
});
`;
  await writeFile(path, script, { mode: 0o700 }); await chmod(path, 0o700);
  return path;
}
