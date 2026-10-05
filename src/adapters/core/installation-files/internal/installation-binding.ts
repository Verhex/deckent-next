import { createHmac } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { installationBindingSchema } from '#domain/index.js';
import { InstallationIdentityError, type InstallationBindingSource } from '#engine/index.js';
import type { ProductLayout } from '#platform/index.js';

async function machineDigest(): Promise<string> {
  if (process.platform !== 'linux') throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
  let value: string;
  try { value = (await readFile('/etc/machine-id', 'utf8')).trim(); }
  catch { throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED'); }
  if (!/^[a-f0-9]{32}$/.test(value) || /^0+$/.test(value)) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
  // systemd machine-id(5): never expose the raw machine id; use an application-specific keyed digest.
  return createHmac('sha256', 'deckent.installation-binding.v1').update(value).digest('hex');
}

export async function localInstallationBindingSource(layout: ProductLayout): Promise<InstallationBindingSource> {
  await machineDigest(); // Missing capability must refuse before metadata initialization.
  return { async capture() {
    try {
      const canonicalRoot = await realpath(layout.root), info = await stat(canonicalRoot, { bigint: true });
      if (!info.isDirectory() || info.ino === 0n) throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNSUPPORTED');
      return installationBindingSchema.parse({ schemaVersion: 1, machineDigest: await machineDigest(),
        canonicalRoot, device: String(info.dev), inode: String(info.ino) });
    } catch (error) {
      if (error instanceof InstallationIdentityError) throw error;
      throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNAVAILABLE');
    }
  } };
}
