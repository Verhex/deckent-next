import { spawn } from 'node:child_process';

// SEC-1 (A48-D5): an authority write needs the peer process's controlling terminal (input and output on it). Raw-frame cases that test
// what happens AFTER the witness (delivery budgets, protocol shapes) send their exact bytes from a real PTY peer; nothing is mocked.
const DRIVER = String.raw`
import os, pty, sys
pid, terminal = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
chunks = []
while True:
    try: data = os.read(terminal, 65536)
    except OSError: data = b''
    if not data: break
    chunks.append(data)
os.waitpid(pid, 0)
sys.stdout.write(b''.join(chunks).decode('utf-8', 'replace'))
`;
// Sends one frame, half-closes, and prints the answer as one base64 line (or CLOSED when the service closed without answering).
const CLIENT = String.raw`
const net = require('node:net'); const [endpoint, frame] = process.argv.slice(1);
const socket = net.createConnection(endpoint); const chunks = [];
socket.on('connect', () => socket.end(Buffer.from(frame, 'base64')));
socket.on('data', chunk => chunks.push(chunk)); socket.on('error', () => undefined);
socket.on('close', () => { const answer = Buffer.concat(chunks); process.stdout.write('\nFRAME:' + (answer.length ? answer.toString('base64') : 'CLOSED') + '\n'); });
`;

/** The service's answer to `frame` sent by a process whose stdin and stdout are its controlling PTY; null when the service closed unanswered. */
export function terminalRawFrame(endpoint: string, frame: Buffer): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', DRIVER, process.execPath, '-e', CLIENT, endpoint, frame.toString('base64')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { err += String(chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timer);
      const line = /FRAME:([A-Za-z0-9+/=]+|CLOSED)/u.exec(out)?.[1];
      if (!line) { reject(new Error(`terminal raw frame: no answer line (${err || out})`)); return; }
      resolve(line === 'CLOSED' ? null : Buffer.from(line, 'base64'));
    });
  });
}
