// Standalone SIWC auth helper (`model_providers.<relay>.auth.command`), mounted read-only. No host package imports at runtime.
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Asks the worker bootstrap (loopback, port from argv) for the relay capability once and prints it for the app-server; any failure
 * prints nothing and exits non-zero. It never reads stdin, files or the environment for a credential. */
async function main() {
  const port = Number(process.argv[2]);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error();
  const value = await new Promise<string>((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, method: 'POST', path: '/capability', headers: { 'content-length': '0' } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (part: string) => { body += part; });
      response.on('end', () => response.statusCode === 200 && /^[A-Za-z0-9_-]+$/u.test(body) ? resolve(body) : reject(new Error()));
    });
    call.on('error', reject); call.end();
  });
  process.stdout.write(value + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.exitCode = 1; });
