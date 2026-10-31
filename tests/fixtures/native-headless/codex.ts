// A scripted fake Codex CLI for the headless step (no real CLI, no model call): `--version`, `exec --help`, `[-c k=v] login [status]` and one
// `exec --json` call replaying `codex exec --json` lines (shapes from tests/fixtures/native-codex/exec-0.163.0-ok.stdout.jsonl).
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

export const CODEX_FAMILY = registry.adapters.codex.headless.protocolFamily;
export const codexHeadless = registry.adapters.codex.headless;
type Line = Record<string, unknown>;
export const codexAnswer = (text: string): Line[] => [{ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } }, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 3 } }];
/** `login`: what `login status` reports (`chatgpt` | `api-key` | `none`); `authFromLogin`: ChatGPT exactly when `login` wrote auth.json. */
export interface FakeCodexScenario { readonly logPath: string; readonly version?: string; readonly login?: 'chatgpt' | 'api-key' | 'none'; readonly authFromLogin?: boolean;
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
const log = entry => { try { fs.appendFileSync(s.logPath, JSON.stringify({ argv: all, env: { ...process.env }, cwd: process.cwd(), ...entry }) + '\\n'); } catch { /* Not visible. */ } };
while (argv[0] === '-c') argv = argv.slice(2);
const auth = () => p.join(process.env.CODEX_HOME, 'auth.json');
if (argv[0] === '--version') { log({ mode: 'version' }); process.stdout.write(s.version + '\\n'); process.exit(0); }
if (argv[0] === 'exec' && argv[1] === '--help') { log({ mode: 'help' }); process.stdout.write(s.help); process.exit(0); }
if (argv[0] === 'login' && argv[1] === 'status') { log({ mode: 'auth' }); const kind = s.authFromLogin ? (fs.existsSync(auth()) ? 'chatgpt' : 'none') : s.login;
  process.stderr.write(kind === 'chatgpt' ? 'Logged in using ChatGPT\\n' : kind === 'api-key' ? 'API key configured - sk-proj-***\\nAuthentication is checked when you send a request.\\n' : 'Not logged in\\n');
  process.exit(kind === 'none' ? 1 : 0); }
if (argv[0] === 'login') { log({ mode: 'login' }); fs.rmSync(auth(), { force: true }); fs.writeFileSync(auth(), 'CREDENTIAL-CANARY-91c2', { mode: 0 }); process.exit(0); }
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
