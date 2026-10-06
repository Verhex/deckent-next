import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { installationBindingCaptureSchema } from '#domain/index.js';
import { InstallationIdentityError, type InstallationBindingSource } from '#engine/index.js';
import { getConfigFieldDefault, type ProductLayout } from '#platform/index.js';

type InstallationSettings = ReturnType<typeof getConfigFieldDefault<'installation'>>;
/** The installation config subset the binding reads; omitted parts take the registry defaults. */
export type InstallationBindingSettings = Partial<Pick<InstallationSettings, 'identityProbe' | 'machineIdentity' | 'requireMachineBinding'>>;
type ProbeLimits = InstallationSettings['identityProbe'];
/** A configured identity is an opaque token: bounded printable charset and length, not a single repeated character. */
const CONFIGURED_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/u;

// Never expose a raw machine value: a fixed application-specific keyed digest, unchanged from binding v1 so existing records keep matching.
const digest = (value: string) => createHmac('sha256', 'deckent.installation-binding.v1').update(value).digest('hex');

/** Platform machine identity (Linux /etc/machine-id, macOS IOPlatformUUID), or null when absent or invalid. */
async function platformDigest(limits: ProbeLimits): Promise<string | null> {
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
  return digest(value);
}

/**
 * Operator-configured identity file, read-only. Symlinks are followed on purpose (mounted secrets and downward-API files are symlinks
 * into an atomically swapped data directory); the target must be a regular file within the probe output bound. A configured source that
 * is missing, unreadable or malformed is a typed refusal, never a silent fallback to a weaker source. The value never leaves this function.
 */
async function configuredDigest(path: string, limits: ProbeLimits): Promise<string> {
  let handle;
  try {
    // Non-blocking open: a FIFO or device at the path cannot stall the probe; the regular-file check below refuses it.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limits.outputBytes) throw new Error('shape');
    const buffer = Buffer.alloc(limits.outputBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead > limits.outputBytes || !CONFIGURED_IDENTITY.test(value) || /^(.)\1*$/u.test(value) || /^[0-]+$/u.test(value)) throw new Error('format');
    return digest(value);
  } catch { throw new InstallationIdentityError('INSTALLATION_IDENTITY_SOURCE_INVALID'); }
  finally { await handle?.close().catch(() => undefined); }
}

/** Source order: configured machine identity, then platform machine identity, then a weak root/device/inode binding. */
export function localInstallationBindingSource(layout: ProductLayout, settings: InstallationBindingSettings = {}): InstallationBindingSource {
  const defaults = getConfigFieldDefault('installation'), limits = settings.identityProbe ?? defaults.identityProbe;
  const configured = (settings.machineIdentity ?? defaults.machineIdentity).source;
  return { async capture() {
    const machine = configured ? { source: 'configured' as const, machineDigest: await configuredDigest(configured, limits) }
      : await platformDigest(limits).then(value => value ? { source: 'platform' as const, machineDigest: value } : null);
    let location;
    try {
      const canonicalRoot = await realpath(layout.root), info = await stat(canonicalRoot, { bigint: true });
      if (!info.isDirectory() || info.ino === 0n) return { status: 'unsupported' };
      location = { canonicalRoot, device: String(info.dev), inode: String(info.ino) };
    } catch { throw new InstallationIdentityError('INSTALLATION_IDENTITY_UNAVAILABLE'); }
    return installationBindingCaptureSchema.parse(machine ? { schemaVersion: 2, strength: 'machine', ...machine, ...location }
      : { schemaVersion: 2, strength: 'weak', source: 'location', ...location });
  } };
}
