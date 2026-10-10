import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { LocalPeerIdentity } from '#adapters/index.js';

// A real OS process with a controlling terminal. It makes no approval decision and claims no alternate identity.
const driver = String.raw`
import json, os, pty, signal, sys
pid, terminal = pty.fork()
if pid == 0:
    os.write(1, (json.dumps({'pid': os.getpid(), 'uid': os.getuid(), 'gid': os.getgid()}) + '\n').encode())
    while True: signal.pause()
try:
    sys.stdout.write(os.read(terminal, 4096).decode()); sys.stdout.flush()
    sys.stdin.buffer.read()
finally:
    os.kill(pid, signal.SIGTERM)
    os.waitpid(pid, 0)
    os.close(terminal)
`;
export async function startInteractivePeer() {
  const child = spawn('python3', ['-c', driver], { stdio: ['pipe', 'pipe', 'pipe'] });
  const connection = new AbortController(); let active = true;
  const exited = new Promise<void>(resolve => child.once('close', () => { active = false; connection.abort(); resolve(); }));
  const close = async () => { child.stdin.end(); await exited; };
  try {
    const peer = await new Promise<LocalPeerIdentity>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test terminal readiness timeout')), 5000);
      const lines = createInterface({ input: child.stdout });
      const failed = () => { clearTimeout(timer); lines.close(); reject(new Error('test terminal unavailable')); };
      child.once('error', failed); child.once('exit', failed);
      lines.once('line', line => {
        clearTimeout(timer); lines.close(); child.removeListener('error', failed); child.removeListener('exit', failed);
        try {
          resolve({ ...JSON.parse(line), assurance: 'linux-so-peercred', connection: connection.signal, isConnectionActive: () => active });
        } catch (error) { reject(error); }
      });
    });
    return { peer, close };
  } catch (error) { child.kill(); await exited; throw error; }
}
