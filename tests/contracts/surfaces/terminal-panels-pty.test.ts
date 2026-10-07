import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// T3 L4 PANELS on a real pseudo-terminal: the built workline with the `/mode`, `/config` and `/mcp` windows (in-process ports, real catalog
// words and port builders; no runtime service). One person whose company denies some settings and gives no full-access grant sees the locked
// rows and why, in English and Turkish, with NO_COLOR and with colour; with the grant, Shift+Tab into full access shows the standing line.
// Frames are kept as evidence when DECKENT_L4_FRAMES names a directory.
const execute = promisify(execFile);
const built = resolve('dist/surfaces/core/terminal-panels/index.js');
const fixture = resolve('tests/contracts/surfaces/terminal-panels-pty.fixture.mjs');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const DRIVER = String.raw`
import fcntl, json, os, pty, select, struct, sys, termios, time
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
out = b''
frames = []
def read_for(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try: chunk = os.read(fd, 65536)
            except OSError: return False
            if not chunk: return False
            out += chunk
    return True
for wait, send, label in steps:
    mark = len(out)
    deadline = time.time() + 20
    while wait.encode() not in out[mark if label.startswith('+') else 0:]:
        if time.time() > deadline or not read_for(0.1):
            try: os.kill(pid, 9)
            except ProcessLookupError: pass
            sys.stdout.write(json.dumps({'timeout': wait, 'output': out.decode('utf8', 'replace'), 'frames': frames})); sys.exit(3)
    read_for(0.4)
    frames.append([label, out.decode('utf8', 'replace')])
    for char in send:
        os.write(fd, char.encode()); time.sleep(0.06)
os.write(fd, b'\x03'); time.sleep(0.2); os.write(fd, b'\x03')
deadline = time.time() + 15
status = None
while status is None and time.time() < deadline:
    read_for(0.1)
    finished, code = os.waitpid(pid, os.WNOHANG)
    if finished: status = os.waitstatus_to_exitcode(code)
if status is None:
    os.kill(pid, 9); status = 'killed'
sys.stdout.write(json.dumps({'status': status, 'output': out.decode('utf8', 'replace'), 'frames': frames}))
`;
type Step = readonly [wait: string, send: string, label: string];
const ESCAPE = String.fromCharCode(27);
/** One write per key: an escape sequence (arrows, Shift+Tab) stays whole; every other character is its own key. */
function keysOf(send: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < send.length; index++) {
    if (send[index] === ESCAPE && send[index + 1] === '[') { const end = send.slice(index + 2).search(/[A-Z~]/u); keys.push(send.slice(index, index + 3 + end)); index += 2 + end; }
    else keys.push(send[index]!);
  }
  return keys;
}
const COLOR_256 = new RegExp(`${ESCAPE}\\[(?:\\d+;)*38;5;\\d+m`, 'u'), ANY_COLOR = new RegExp(`${ESCAPE}\\[(?:\\d+;)*(?:3[0-7]|38;)`, 'u');
async function pty(steps: readonly Step[], args: readonly string[], color: boolean) {
  await access(built);
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', TERM: 'xterm-256color', ...(color ? { FORCE_COLOR: '3' } : { NO_COLOR: '1' }) };
  const keyed = steps.map(([wait, send, label]) => [wait, keysOf(send), label]);
  const { stdout } = await execute('python3', ['-c', DRIVER, JSON.stringify(keyed), process.execPath, fixture, ...args], { cwd: process.cwd(), timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024, env }).catch(error => ({ stdout: String((error as { stdout?: string }).stdout ?? '') }));
  return JSON.parse(stdout) as { status?: number | string; timeout?: string; output: string; frames: [string, string][] };
}
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'panels-pty-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ terminal: { scopeId: 'scope' } }));
  return root;
}
/** The last full frame drawn before `upto` characters of output (Ink redraws the live area; the last one is what the screen shows). */
const screen = (raw: string) => stripVTControlCharacters(raw).replace(/\r/gu, '');
async function keep(name: string, result: { output: string; frames: [string, string][] }) {
  const directory = process.env['DECKENT_L4_FRAMES'];
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.txt`), result.frames.map(([label, text], index) => `===== ${label} =====\n${screen(text.slice(index ? result.frames[index - 1]![1].length : 0))}`).join('\n'));
}
const ESC = '\u001b', DOWN = '\u001b[B', ENTER = '\r', SHIFT_TAB = '\u001b[Z';
const WORDS = {
  en: { mode: 'Permission mode', locked: '[blocked]', grant: "company's grant", denied: 'does not let you change this setting in this layer', approval: 'asks for approval (rule company-config-approval)',
    mcp: 'MCP servers', http: "Streamable HTTP, with headers", line: 'Full access: commands run without asking', general: 'general' },
  tr: { mode: 'İzin modu', locked: '[engellendi]', grant: "şirketinizin grant'ı gerekir", denied: 'bu katmanda değiştirmenize izin vermiyor', approval: 'onay ister (kural company-config-approval)',
    mcp: 'MCP sunucuları', http: "Streamable HTTP, başlıklarla", line: 'Tam erişim: komutlar sormadan çalışır', general: 'genel' },
} as const;

describe('settings windows on a real PTY (T3 L4)', () => {
  beforeEach(context => {
    if (process.platform === 'win32') context.skip('PYTHON_PTY_UNSUPPORTED: Python pty/fork/termios fixture is Unix-only; this does not test Windows ConPTY');
  });
  for (const [locale, color] of [['en', false], ['tr', false], ['tr', true]] as const) {
    it(`${locale}${color ? ' colour' : ' NO_COLOR'}: without the company's grants the person sees locked rows and why; nothing is chosen behind a lock`, async () => {
      const words = WORDS[locale], root = await project();
      const result = await pty([
        ['READY', '/mode\r', 'start'],
        [words.mode, `${DOWN}${DOWN}${DOWN}`, '+/mode'],
        [words.grant, `${ENTER}${ESC}`, '+/mode full access locked'],
        ['READY', '/config\r', '+closed'],
        [words.general, ENTER, '+/config sections'],
        ['max_workers', `${DOWN}${ENTER}${ENTER}`, '+/config general'],
        [words.approval, DOWN, '+/config layer step'],
        [words.denied, `${ESC}${ESC}${ESC}${ESC}`, '+/config user layer locked'],
        ['READY', '/mcp\r', '+closed again'],
        ['github', `${ENTER}${DOWN}`, '+/mcp list'],
        [words.http, `${ESC}${ESC}`, '+/mcp add: HTTP offered (MCP-CORE wired in the integration)'],
      ], [locale, root, '0', color ? 'ansi256' : 'none'], color);
      await keep(`pty-${locale}-${color ? 'colour' : 'nocolor'}`, result);
      expect(result.timeout, result.output?.slice(-1500)).toBeUndefined();
      const text = screen(result.output);
      expect(text).toContain(words.locked);
      expect(text).toMatch(/⊘/u);
      if (color) expect(result.output).toMatch(COLOR_256); else expect(result.output).not.toMatch(ANY_COLOR);
      expect(text).not.toMatch(/Error:|TypeError|ERR:/u);
    });
  }
  for (const locale of ['en', 'tr'] as const) {
    it(`${locale}: with the grant, Shift+Tab into full access shows the standing line above the composer and the warning notice`, async () => {
      const words = WORDS[locale], root = await project();
      const result = await pty([['READY', `${SHIFT_TAB}`, 'start'], ['READY', SHIFT_TAB, '+1'], ['READY', SHIFT_TAB, '+2'], [words.line, '', '+full access']],
        [locale, root, '1', 'none'], false);
      await keep(`pty-${locale}-full-access`, result);
      expect(result.timeout, result.output?.slice(-1500)).toBeUndefined();
      expect(screen(result.output)).toContain(`⚠ ${words.line}`);
    });
  }
});
