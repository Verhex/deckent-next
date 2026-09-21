import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Test-only CA, fresh private key per fixture. A bounded validity margin avoids a notBefore
 * race between certificate creation and TLS verification clocks. Trust verification stays enabled. */
export async function createLocalTls(root: string): Promise<{ readonly key: string; readonly caPem: string }> {
  const directory = await mkdtemp(join(root, 'tls-'));
  const now = Date.now(), marginMs = 24 * 60 * 60 * 1000;
  const stamp = (value: number) => new Date(value).toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '') + 'Z';
  try {
    await Promise.all([
      writeFile(join(directory, 'index'), ''), writeFile(join(directory, 'serial'), '01\n'),
      writeFile(join(directory, 'ca.cnf'), `[ca]
default_ca=local
[local]
database=index
serial=serial
new_certs_dir=.
default_md=sha256
policy=policy
x509_extensions=extensions
[policy]
commonName=supplied
[extensions]
subjectAltName=IP:127.0.0.1
basicConstraints=critical,CA:TRUE
`),
    ]);
    await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', 'key.pem', '-out', 'request.pem', '-subj', '/CN=127.0.0.1'], { cwd: directory });
    await execute('openssl', ['ca', '-selfsign', '-batch', '-config', 'ca.cnf', '-keyfile', 'key.pem',
      '-in', 'request.pem', '-out', 'cert.pem', '-notext', '-startdate', stamp(now - marginMs),
      '-enddate', stamp(now + marginMs)], { cwd: directory });
    const [key, caPem] = await Promise.all([readFile(join(directory, 'key.pem'), 'utf8'), readFile(join(directory, 'cert.pem'), 'utf8')]);
    return Object.freeze({ key, caPem });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
