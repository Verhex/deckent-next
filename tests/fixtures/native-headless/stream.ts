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
/** S3-5 `isolation`: what the CLI process can reach from inside its realm; each answer is logged (`mode: 'isolation'`), the turn goes on. */
export interface IsolationProbe { readonly read?: readonly string[]; readonly list?: readonly string[]; readonly write?: readonly string[]; readonly replace?: readonly string[];
  readonly exists?: readonly string[]; readonly connect?: readonly { host: string; port: number }[]; readonly proxy?: readonly string[] }
/** f5 bound probes: `lower` lowers this process's own limits with the registry's limiter (`--pid self`), then `burn` spins the CPU (optionally ignoring
 * SIGXCPU), starts sleeping children until the realm refuses one, or allocates until memory is refused, and aborts like a crashed CLI. */
export type BoundProbe = { lower?: readonly string[]; burn: 'cpu' | 'cpu-ignore' | 'processes' | 'memory' | 'abort' | 'interrupt' };
export type FakeStep = { line: Line | string } | { sleepMs: number } | { floodBytes: number } | { hang: true; ignoreInterrupt?: boolean } | { exit: number } | { isolation: IsolationProbe }
  | { bound: BoundProbe };
export interface FakeScenario {
  readonly logPath: string; readonly version?: string; readonly help?: string; readonly probeRefusal?: string | null; readonly systemProbeRefusal?: string | null;
  readonly auth?: Record<string, unknown>; readonly authExit?: number; readonly steps?: readonly FakeStep[]; readonly initCwd?: 'actual';
  /** s3c: `auth login` writes a credential canary (mode 0000: nobody may read it, Deckent included) into CLAUDE_CONFIG_DIR and exits `loginExit`;
   * with `authFromLogin`, `auth status` reports logged in exactly when that file exists (a name check: the fake never reads it either). */
  readonly loginExit?: number; readonly authFromLogin?: boolean;
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
 * then replays the scenario's steps. Every invocation appends one JSON line to `logPath`; S3-5: the CLI runs isolated, so `logPath` is the CLI's
 * own state file in the login dir (`<configDir>/.claude.json`, the one place it may write). A hidden-flag probe runs with an empty temporary
 * config dir it cannot log from: it answers with the parser refusal only when it sees that empty dir (HOME = cwd = config dir, never the login dir).
 */
export async function writeFakeCli(dir: string, scenario: FakeScenario): Promise<string> {
  const path = join(dir, 'fake-cli');
  const config = { version: '9.1.0', help: fullHelp(), probeRefusal: registry.adapters.claude.capabilities.maxTurns.hiddenHelpProbe.refusal,
    systemProbeRefusal: `option '${headless.systemPromptFlag} <file>' argument missing`,
    auth: { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'fixture', email: 'person@example.invalid', orgId: 'org-fixture',
      orgName: 'Fixture Org' }, authExit: 0, steps: [], ...scenario };
  const script = `#!${process.execPath}
const fs = require('node:fs'); const s = ${JSON.stringify(config)}; const argv = process.argv.slice(2);
const log = entry => { try { fs.appendFileSync(s.logPath, JSON.stringify({ argv, env: { ...process.env }, cwd: process.cwd(), ...entry }) + '\\n'); } catch { /* Not visible from this spawn. */ } };
const probeDir = () => { const dir = process.env.CLAUDE_CONFIG_DIR; try { return dir !== require('node:path').dirname(s.logPath) && process.env.HOME === dir && process.cwd() === dir && fs.readdirSync(dir).length === 0; } catch { return false; } };
if (argv[0] === '--version') { log({ mode: 'version' }); process.stdout.write(s.version + ' (fixture)\\n'); process.exit(0); }
if (argv[0] === '--help') { log({ mode: 'help' }); process.stdout.write(s.help); process.exit(0); }
if (argv[0] === '--print' && argv.length === 2 && argv[1] === ${JSON.stringify(headless.systemPromptFlag)}) { log({ mode: 'probe-system', entries: fs.readdirSync('.') }); process.stderr.write('error: ' + (s.systemProbeRefusal && probeDir() ? s.systemProbeRefusal : "unknown option '" + argv[1] + "'") + '\\n'); process.exit(1); }
if (argv[0] === '--max-turns') { log({ mode: 'probe' }); const refusal = s.probeRefusal && probeDir(); if (refusal) process.stderr.write('error: ' + s.probeRefusal + '\\n'); process.exit(refusal ? 1 : 0); }
const credentials = () => require('node:path').join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
if (argv[0] === 'auth' && argv[1] === 'login') { log({ mode: 'login', tty: { stdin: process.stdin.isTTY === true } }); if (!s.loginExit) { fs.rmSync(credentials(), { force: true }); fs.writeFileSync(credentials(), 'CREDENTIAL-CANARY-91c2', { mode: 0 }); } process.exit(s.loginExit ?? 0); }
if (argv[0] === 'auth') { log({ mode: 'auth' }); const logged = s.authFromLogin ? { loggedIn: fs.existsSync(credentials()) } : {}; process.stdout.write(JSON.stringify({ ...s.auth, ...logged, configDirectory: s.auth.configDirectory ?? process.env.CLAUDE_CONFIG_DIR })); process.exit(s.authExit); }
async function isolation(p) {
  const net = require('node:net'), each = (list, fn) => Object.fromEntries((list ?? []).map(item => { try { return [item, fn(item)]; } catch (error) { return [item, 'error:' + error.code]; } }));
  const r = { read: each(p.read, file => fs.readFileSync(file, 'utf8')), list: each(p.list, dir => fs.readdirSync(dir).sort()), exists: each(p.exists, file => fs.existsSync(file)),
    write: each(p.write, file => { fs.writeFileSync(file, 'SANDBOX-WRITE'); return 'written'; }),
    replace: each(p.replace, file => { fs.writeFileSync(file + '.tmp-fixture', 'SANDBOX-REPLACE'); fs.renameSync(file + '.tmp-fixture', file); return 'replaced'; }),
    homeSsh: fs.existsSync(require('node:path').join(require('node:os').userInfo().homedir, '.ssh')),
    limits: Object.fromEntries(fs.readFileSync('/proc/self/limits', 'utf8').split('\\n').map(row => /^Max (core file size|file size|open files|cpu time|processes|data size)\\s+(\\S+)\\s+(\\S+)/u.exec(row)).filter(Boolean).map(m => [m[1], m[1] === 'cpu time' ? m[2] + ':' + m[3] : m[2]])) };
  try { fs.openSync('/dev/tty', 'r'); r.tty = 'open'; } catch (error) { r.tty = 'error:' + error.code; }
  try { r.userns = require('node:child_process').spawnSync('/usr/bin/unshare', ['-U', 'true']).status; } catch { r.userns = null; }
  const attempt = (open, sent) => new Promise(resolve => { let reached = false, data = ''; const socket = open(); const done = value => { socket.destroy(); resolve(value); };
    socket.on('connect', () => { reached = true; if (sent) socket.write(sent); else done('connected'); }); socket.on('data', chunk => { data += chunk; });
    socket.on('error', error => done(sent ? { reached, response: data.split('\\r\\n')[0] || null } : 'error:' + error.code)); socket.on('close', () => done(sent ? { reached, response: data.split('\\r\\n')[0] || null } : 'closed'));
    setTimeout(() => done('timeout'), 3000); });
  r.connect = await Promise.all((p.connect ?? []).map(({ host, port }) => attempt(() => net.connect(port, host))));
  let proxy = null; try { proxy = new URL(process.env.HTTPS_PROXY); } catch { /* No proxy in this realm. */ }
  r.proxy = await Promise.all((p.proxy ?? []).map(target => proxy ? attempt(() => net.connect(Number(proxy.port), proxy.hostname), 'CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n') : 'no-proxy'));
  return r;
}
async function bound(p) {
  const child = require('node:child_process');
  // '--data=+N': this process's current data size plus N bytes (its own baseline is unknown to the test).
  const data = () => Number(/^VmData:\\s+(\\d+)/mu.exec(fs.readFileSync('/proc/self/status', 'utf8'))[1]) * 1024;
  const lower = (p.lower ?? []).map(arg => arg.startsWith('--data=+') ? '--data=' + (data() + Number(arg.slice(8))) : arg);
  if (lower.length) child.spawnSync(${JSON.stringify(headless.isolation.limits.limiter)}, ['--pid', String(process.pid), ...lower]);
  log({ mode: 'bound', burn: p.burn });
  // 'interrupt': a SIGINT to the realm's process group that did not come from the runner (the relay sees it too), then an abort like a crashed CLI.
  if (p.burn === 'interrupt') { process.on('SIGINT', () => { log({ mode: 'interrupted' }); process.abort(); }); setInterval(() => {}, 1000); setTimeout(() => process.kill(0, 'SIGINT'), 300); return new Promise(() => {}); }
  if (p.burn === 'cpu-ignore') process.on('SIGXCPU', () => {});
  if (p.burn.startsWith('cpu')) for (;;) Math.sqrt(Math.random());
  if (p.burn === 'processes') { for (let i = 0; i < 4096; i++) if (!await new Promise(resolve => { const c = child.spawn('/bin/sleep', ['30'], { stdio: 'ignore' }); c.on('spawn', () => resolve(true)); c.on('error', () => resolve(false)); })) break; }
  if (p.burn === 'memory') { const kept = []; try { for (let i = 0; i < 4096; i++) kept.push(Buffer.alloc(8 * 1048576, 1)); } catch { /* Refused: abort like a crashed CLI. */ } }
  process.abort();
}
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
    else if (step.isolation !== undefined) log({ mode: 'isolation', results: await isolation(step.isolation) });
    else if (step.bound !== undefined) await bound(step.bound);
  }
});
`;
  await writeFile(path, script, { mode: 0o700 }); await chmod(path, 0o700);
  return path;
}
