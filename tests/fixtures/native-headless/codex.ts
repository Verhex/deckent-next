// A scripted fake Codex CLI for the headless step (no real CLI, no model call): `--version`, `exec --help`, `[-c k=v] login [status]` and one
// `exec --json` call replaying `codex exec --json` lines (shapes from tests/fixtures/native-codex/exec-0.163.0-ok.stdout.jsonl).
import { chmod, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

export const CODEX_FAMILY = registry.adapters.codex.headless.protocolFamily;
export const codexHeadless = registry.adapters.codex.headless;
type Line = Record<string, unknown>;
export const codexAnswer = (text: string): Line[] => [{ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } }, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 3 } }];
/** `login`: what `login status` reports (`chatgpt` | `api-key` | `none`); `authFromLogin`: ChatGPT exactly when `login` wrote auth.json. */
export interface FakeCodexScenario { readonly logPath: string; readonly version?: string; readonly login?: 'chatgpt' | 'api-key' | 'none'; readonly authFromLogin?: boolean;
  readonly installationId?: string | undefined;
  readonly versionExit?: number; readonly versionSignal?: NodeJS.Signals; readonly versionStderr?: string;
  readonly probe?: { readonly absent: readonly string[]; readonly readOnly: string };
  readonly steps?: readonly ({ line: Line | string } | { exit: number } | { stderr: string })[] }
/** Help naming every option the registry's call uses, the way `codex exec --help` (0.166.0) lists them. */
export function codexHelp(): string {
  const flags = new Set([...codexHeadless.args.filter(arg => arg.startsWith('--')), codexHeadless.systemPromptFlag, registry.adapters.codex.modelFlag]);
  return `Run Codex non-interactively\n\nOptions:\n${[...flags].map(flag => `      ${flag} <VALUE>\n          option`).join('\n')}\n`;
}
/** The fake logs every spawn as one JSON line into `logPath` (`<CODEX_HOME>/config.toml`: a visible login-dir entry, the one place it may write). */
export async function writeFakeCodexCli(dir: string, scenario: FakeCodexScenario): Promise<string> {
  const path = join(dir, 'fake-codex'), config = { version: 'codex-cli 9.1.0', help: codexHelp(), login: 'chatgpt', steps: [], ...scenario };
  const script = `#!${process.execPath}
const fs = require('node:fs'), p = require('node:path'); const s = ${JSON.stringify(config)}; let argv = process.argv.slice(2); const all = argv;
const log = entry => { try { fs.appendFileSync(s.logPath, JSON.stringify({ program: process.argv[1], argv: all, env: { ...process.env }, cwd: process.cwd(), ...entry }) + '\\n'); } catch { /* Not visible. */ } };
while (argv[0] === '-c') argv = argv.slice(2);
const auth = () => p.join(process.env.CODEX_HOME, 'auth.json');
if (argv[0] === '--version') {
  let mode;
  if (s.probe) { try { fs.closeSync(fs.openSync(s.probe.readOnly, 'r+')); mode = 'writable'; } catch (error) { mode = error.code; } }
  log({ mode: 'version', visibility: s.probe?.absent.map(path => fs.existsSync(path)), writeAccess: mode });
  if (s.versionSignal) process.kill(process.pid, s.versionSignal);
  process.stdout.write(s.version + '\\n'); if (s.versionStderr) process.stderr.write(s.versionStderr); process.exit(s.versionExit ?? 0);
}
if (argv[0] === 'exec' && argv[1] === '--help') { log({ mode: 'help' }); process.stdout.write(s.help); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') { log({ mode: 'auth' }); const kind = s.authFromLogin ? (fs.existsSync(auth()) ? 'chatgpt' : 'none') : s.login;
  process.stderr.write(kind === 'chatgpt' ? 'Logged in using ChatGPT\\n' : kind === 'api-key' ? 'API key configured - sk-proj-***\\nAuthentication is checked when you send a request.\\n' : 'Not logged in\\n');
  process.exit(kind === 'none' ? 1 : 0); }
if (argv[0] === 'login') { log({ mode: 'login' }); fs.rmSync(auth(), { force: true }); fs.writeFileSync(auth(), 'CREDENTIAL-CANARY-91c2', { mode: 0 }); process.exit(0); }
if (s.installationId) {
  const fd = fs.openSync(p.join(process.env.CODEX_HOME, 'installation_id'), 'r+');
  if (fs.readFileSync(fd, 'utf8') !== s.installationId) throw new Error('fixture installation identity was masked');
  fs.writeSync(fd, 'PRIVATE-COPY-WRITE', 0); fs.closeSync(fd);
}
const chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => {
  const file = /^model_instructions_file="(.*)"$/.exec(argv.find(arg => arg.startsWith('model_instructions_file=')) ?? '')?.[1];
  log({ mode: 'call', stdin: Buffer.concat(chunks).toString('utf8'), system: file ? fs.readFileSync(file, 'utf8') : null, entries: fs.readdirSync('.').sort() });
  for (const step of s.steps) {
    if (step.line !== undefined) process.stdout.write((typeof step.line === 'string' ? step.line : JSON.stringify(step.line)) + '\\n');
    else if (step.stderr !== undefined) process.stderr.write(step.stderr);
    else if (step.exit !== undefined) process.exit(step.exit);
  }
});
`;
  await writeFile(path, script, { mode: 0o700 }); await chmod(path, 0o700);
  return path;
}

export async function fakeCodexNpm(prefix: string, scenario: FakeCodexScenario, checkVisibility = false) {
  const root = join(prefix, 'lib/node_modules/@openai/codex'), launcher = join(root, 'bin/codex.js'), chosen = join(prefix, 'bin/codex');
  const platform = '@openai/codex-linux-x64', platformRoot = join(root, 'node_modules', platform);
  const payload = join(platformRoot, 'vendor/x86_64-unknown-linux-musl/bin/codex'), version = '0.169.0';
  await mkdir(dirname(chosen), { recursive: true });
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(dirname(payload), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version, bin: { codex: 'bin/codex.js' },
    optionalDependencies: { [platform]: `npm:@openai/codex@${version}-linux-x64` } }));
  await writeFile(join(platformRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: `${version}-linux-x64` }));
  await writeFile(launcher, `#!/usr/bin/env node
const child = require('node:child_process').spawnSync(require('node:path').join(__dirname, ${JSON.stringify(relative(dirname(launcher), payload))}),
  process.argv.slice(2), { stdio: 'inherit' });
process.exit(child.status ?? 91);
`, { mode: 0o755 });
  await symlink(relative(dirname(chosen), launcher), chosen);
  const probe = checkVisibility ? { absent: [chosen, launcher, join(root, 'package.json'), join(platformRoot, 'package.json')], readOnly: payload } : undefined;
  await rename(await writeFakeCodexCli(dirname(payload), { ...scenario, ...(probe ? { probe } : {}) }), payload);
  return { chosen, launcher, payload, platformRoot, root };
}
