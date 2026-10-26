// Standalone SIWC worker bootstrap, mounted read-only as the container's init process. No host package imports at runtime.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RELAY = '/run/deckent-relay.sock';
type Launch = { schemaVersion: 1; executable: string; args: string[]; limits: { requestMaxBytes: number; controlLineBytes: number; connections: number; idleMs: number; helperTimeoutMs: number; drainMs: number } };

/** Socket inode of the client end of one loopback TCP connection (container network namespace). */
export function loopbackInode(tables: readonly string[], clientPort: number, serverPort: number): string | null {
  const port = (address: string | undefined) => parseInt(address?.split(':')[1] ?? '', 16);
  for (const table of tables) for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/u);
    if (port(cols[1]) === clientPort && port(cols[2]) === serverPort && cols[9] && cols[9] !== '0') return cols[9];
  }
  return null;
}
/** Every process holding that socket (kernel /proc facts, read as the same uid; a non-readable holder makes the owner unknown). */
function holders(inode: string): number[] {
  const owners: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue;
    let fds: string[]; try { fds = readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) { try { if (readlinkSync(`/proc/${entry}/fd/${fd}`) === `socket:[${inode}]`) { owners.push(Number(entry)); break; } } catch { /* closed meanwhile */ } }
  }
  return owners;
}
const stat = (pid: number) => { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'), text = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { ppid: Number(text[1]), start: text[19] ?? '' }; };
/** The single process owning the client end of an accepted loopback connection, or null. */
function peerOf(socket: { remotePort?: number | undefined; localPort?: number | undefined }): { pid: number; start: string } | null {
  try {
    if (!socket.remotePort || !socket.localPort) return null;
    const tables = ['/proc/net/tcp', '/proc/net/tcp6'].map(path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } });
    const inode = loopbackInode(tables, socket.remotePort, socket.localPort), owners = inode ? holders(inode) : [];
    return owners.length === 1 ? { pid: owners[0]!, start: stat(owners[0]!).start } : null;
  } catch { return null; }
}
const host = (method: string, path: string, headers: Record<string, string> = {}) => request({ socketPath: RELAY, method, path, headers });
const fetchText = (method: string, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const call = host(method, path, { 'content-length': '0' }); call.on('error', reject);
  call.on('response', response => { let body = ''; response.setEncoding('utf8'); response.on('data', (part: string) => { body += part; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body })); });
  call.end();
});
const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); resolve(typeof address === 'object' && address ? address.port : 0); });
});

/**
 * Container init: (1) read the nonsecret launch spec from the host relay; (2) serve the auth helper ONCE on loopback — only a process whose
 * parent is the app-server (spawned here, before any tool ran) receives C, and that parent becomes the pinned app-server; (3) the model
 * shim accepts loopback connections owned by exactly that app-server process and forwards only `POST /v1/responses` to the host relay;
 * (4) app-server stdio is bridged to the host control channel; stderr is counted, never forwarded. No credential file, env or argv.
 */
async function main() {
  const spec = await fetchText('GET', '/launch'); if (spec.status !== 200) throw new Error();
  const launch = JSON.parse(spec.body) as Launch; if (launch.schemaVersion !== 1) throw new Error();
  const home = '/tmp/deckent-home'; mkdirSync(`${home}/.codex`, { recursive: true, mode: 0o700 });
  let child: ChildProcess | undefined = undefined;
  let appServer: { pid: number; start: string } | null = null, issued = false, sequence = 0, stderrBytes = 0;
  const helperServer = createServer((incoming, response) => {
    incoming.resume();
    const peer = peerOf(incoming.socket), parent = peer ? stat(peer.pid).ppid : -1;
    const fromApp = child?.pid !== undefined && (parent === child.pid || (() => { try { return stat(parent).ppid === child.pid; } catch { return false; } })());
    if (issued || !peer || !fromApp || incoming.method !== 'POST' || incoming.url !== '/capability') { response.writeHead(403).end(); return; }
    issued = true; appServer = { pid: parent, start: stat(parent).start }; helperServer.close();
    void fetchText('POST', '/capability').then(answer => { response.writeHead(answer.status === 200 ? 200 : 403); response.end(answer.status === 200 ? answer.body : ''); }, () => response.writeHead(403).end());
  });
  helperServer.maxConnections = 1;
  const shim = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const peer = peerOf(incoming.socket);
    if (!appServer || !peer || peer.pid !== appServer.pid || peer.start !== appServer.start || incoming.method !== 'POST' || incoming.url !== '/v1/responses') {
      incoming.resume(); response.writeHead(403).end(); return;
    }
    const length = incoming.headers['content-length'];
    const forward = host('POST', '/v1/responses', { ...(typeof incoming.headers['authorization'] === 'string' ? { authorization: incoming.headers['authorization'] } : {}),
      'content-type': 'application/json', 'x-deckent-sequence': String(++sequence), ...(length ? { 'content-length': length } : { 'transfer-encoding': 'chunked' }) });
    forward.on('response', answer => { response.writeHead(answer.statusCode ?? 502, { 'content-type': String(answer.headers['content-type'] ?? 'application/octet-stream') }); answer.pipe(response); });
    forward.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    incoming.pipe(forward);
  });
  shim.maxConnections = launch.limits.connections; shim.headersTimeout = launch.limits.idleMs; shim.requestTimeout = 0;
  const [capPort, shimPort] = await Promise.all([listen(helperServer), listen(shim)]);
  const args = launch.args.map(arg => arg.replaceAll('{capPort}', String(capPort)).replaceAll('{shimPort}', String(shimPort)));
  child = spawn(launch.executable, args, { cwd: '/workspace', stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: `${home}/.codex`, LANG: 'C.UTF-8' } });
  const control = host('POST', '/control', { 'content-type': 'application/x-ndjson', 'transfer-encoding': 'chunked' });
  control.on('response', answer => { answer.pipe(child!.stdin!); answer.on('end', () => {
    // Host ended the turn (settled or revoked): stdin EOF first, then bounded termination.
    setTimeout(() => child?.kill('SIGTERM'), launch.limits.drainMs).unref(); setTimeout(() => child?.kill('SIGKILL'), 2 * launch.limits.drainMs).unref(); }); });
  control.on('error', () => child?.kill('SIGKILL')); control.flushHeaders();
  child.stdout!.pipe(control); child.stderr!.on('data', (part: Buffer) => { stderrBytes += part.length; });
  child.stdin!.on('error', () => undefined);
  const result = await new Promise<{ code: number | null; signal: string | null }>(resolve => { child!.on('error', () => resolve({ code: null, signal: null })); child!.on('close', (code, signal) => resolve({ code, signal })); });
  shim.close(); helperServer.close(); control.end();
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'siwc-worker-exit', ...result, stderrBytes, capabilityIssued: issued }) + '\n');
  process.exitCode = result.code === 0 ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 78; });
}
