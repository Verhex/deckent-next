import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { installationBindingSchema } from '#domain/index.js';
import { InstallationIdentityError, type InstallationBindingSource } from '#engine/index.js';
import { getConfigFieldDefault, type ProductLayout } from '#platform/index.js';

async function machineDigest(limits: { readonly timeoutMs: number; readonly outputBytes: number }): Promise<string | null> {
  let value: string;
  try {
    if (process.platform === 'linux') {
      value = (await readFile('/etc/machine-id', 'utf8')).trim();
      if (!/^[a-f0-9]{32}$/.test(value) || /^0+$/.test(value)) return null;
    } else if (process.platform === 'darwin') {
      const { stdout } = await promisify(execFile)('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'],
        { timeout: limits.timeoutMs, maxBuffer: limits.outputBytes, encoding: 'utf8' });
      const match = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i.exec(stdout);
      if (!match || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(match[1]!) || /^0+$/.test(match[1]!.replaceAll('-', ''))) return null;
      value = match[1]!.toLowerCase();
    } else return null;
  } catch { return null; }
  // Never expose the raw machine id; preserve the existing app-specific digest on Linux/WSL.
  return createHmac('sha256', 'deckent.installation-binding.v1').update(value).digest('hex');
}

export function localInstallationBindingSource(layout: ProductLayout, limits = getConfigFieldDefault('installation').identityProbe): InstallationBindingSource {
  return { async capture() {
    const digest = await machineDigest(limits);
    if (!digest) return { status: 'unsupported' };
    try {
      const canonicalRoot = await realpath(layout.root), info = await stat(canonicalRoot, { bigint: true });
      if (!info.isDirectory() || info.ino === 0n) return { status: 'unsupported' };
      return installationBindingSchema.parse({ schemaVersion: 1, machineDigest: digest,
        canonicalRoot, device: String(info.dev), inode: String(info.ino) });
    } catch { throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNAVAILABLE'); }
  } };
}
