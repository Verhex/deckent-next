import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createLocalTls } from '../../fixtures/local-tls.js';

it('trusts the test certificate across a clock-boundary margin but still rejects outside its validity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-tls-validity-'));
  try {
    const now = Date.now(), tls = await createLocalTls(root), certificate = new X509Certificate(tls.caPem);
    const path = join(root, 'certificate.pem'); await writeFile(path, tls.caPem);
    const execute = promisify(execFile);
    const verifyAt = (ms: number) => execute('openssl', ['verify', '-CAfile', path, '-verify_ip', '127.0.0.1',
      '-attime', String(Math.floor(ms / 1000)), path]);
    await verifyAt(now - 60_000); await verifyAt(now + 60_000);
    await expect(verifyAt(Date.parse(certificate.validFrom) - 1000)).rejects.toMatchObject({ code: 2 });
    await expect(verifyAt(Date.parse(certificate.validTo) + 1000)).rejects.toMatchObject({ code: 2 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
