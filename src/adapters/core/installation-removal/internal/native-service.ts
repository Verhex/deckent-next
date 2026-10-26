import { constants } from 'node:fs';
import { lstat, open, realpath, readlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { EffectTargetError } from '#engine/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import { readProcessFile } from '#platform/index.js';
import type { RemovalService, ServiceObservation, ServiceRemovalDriver } from './service.js';
const PRIVATE_PERMISSION_MASK = 0o077;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const artifact = z.object({ path: z.string().min(1), digest, link: z.string().nullable() }).strict();
const recordSchema = z.object({ schemaVersion: z.literal(1), installationId: z.string().min(1), manager: z.literal('systemd'), scope: z.literal('user'),
  unit: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.service$/u), directory: z.string().min(1),
  artifacts: z.array(artifact).nonempty() }).strict();
export type NativeServiceRecord = z.infer<typeof recordSchema>;
export type NativeServiceExec = (args: readonly string[]) => Promise<string>;
const reject = (): never => { throw new EffectTargetError('EFFECT_TARGET_REJECTED'); };
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const within = (root: string, path: string) => { const child = relative(root, path); return !!child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); };
/** Installer-owned, authenticated artifact record; config service.identity is never converted into a unit name. */
export async function readNativeServiceRecord(directory: string, installationId: string, integrity: IntegrityAuthority, maxBytes: number) {
  const file = await open(join(directory, 'native-service.json'), constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (absent(error)) return null; throw error; });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & PRIVATE_PERMISSION_MASK || info.size > maxBytes) reject();
    const bytes = Buffer.alloc(info.size + 1), read = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
    if (read.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) reject();
    const sealed = JSON.parse(bytes.subarray(0, read.bytesRead).toString()) as { body: unknown; keyId: string; mac: string };
    if (!integrity.verify(JSON.stringify(sealed.body), sealed.mac, sealed.keyId)) reject();
    const record = recordSchema.parse(sealed.body);
    if (record.installationId !== installationId || !isAbsolute(record.directory) || new Set(record.artifacts.map(item => item.path)).size !== record.artifacts.length) reject();
    return record;
  } finally { await file.close(); }
}
/** No shell, elevation or inherited credentials. All commands and manager output share the caller's existing limits. */
export function nativeServiceExec(bounds: { timeoutMs: number; outputBytes: number }, env: Readonly<Record<string, string | undefined>>): NativeServiceExec {
  const bus = Object.fromEntries(['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
  return args => new Promise((resolve, reject) => execFile('systemctl', ['--user', ...args], { env: bus, shell: false, encoding: 'utf8',
    timeout: bounds.timeoutMs, maxBuffer: bounds.outputBytes }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
/** Exact user-unit artifacts only. Enablement links are removed individually; `disable` may otherwise follow Also=/aliases. */
export class NativeServiceRemovalDriver implements ServiceRemovalDriver {
  readonly identity: string;
  readonly service: RemovalService;
  constructor(private readonly record: NativeServiceRecord, private readonly exec: NativeServiceExec,
    readonly withCustody: ServiceRemovalDriver['withCustody'], private readonly maxBytes: number) {
    this.record = recordSchema.parse(record);
    const ownershipDigest = sha256(JSON.stringify(this.record));
    this.identity = ownershipDigest;
    this.service = { resourceId: 'recorded-service', installationId: record.installationId, manager: record.manager, scope: record.scope, unit: record.unit, ownershipDigest };
  }
  private check(service: RemovalService) { if (process.platform !== 'linux' || JSON.stringify(service) !== JSON.stringify(this.service)) reject(); }
  private async artifacts() {
    if (!isAbsolute(this.record.directory) || await realpath(this.record.directory) !== this.record.directory) reject();
    const directory = await lstat(this.record.directory);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o022) reject();
    const found: string[] = [];
    for (const item of this.record.artifacts) {
      if (!within(this.record.directory, item.path) || await realpath(dirname(item.path)) !== dirname(item.path)) reject();
      const parent = await lstat(dirname(item.path));
      if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o022) reject();
      const info = await lstat(item.path).catch(error => { if (absent(error)) return null; throw error; });
      if (!info) continue;
      if (info.uid !== process.getuid?.() || info.mode & 0o022 && !info.isSymbolicLink()) reject();
      if (item.link !== null) {
        if (!info.isSymbolicLink() || await readlink(item.path) !== item.link || sha256(item.link) !== item.digest
          || await realpath(item.path) !== join(this.record.directory, this.record.unit)) reject();
      } else {
        if (!info.isFile() || info.nlink !== 1 || info.size > this.maxBytes) reject();
        const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const current = await file.stat();
          if (current.ino !== info.ino || current.dev !== info.dev || current.size > this.maxBytes) reject();
          const bytes = Buffer.alloc(current.size + 1), read = await file.read(bytes, 0, bytes.length, 0);
          if (read.bytesRead !== current.size || sha256(bytes.subarray(0, read.bytesRead)) !== item.digest
            || /^\s*(?:Also|Alias)\s*=\s*\S/mu.test(bytes.subarray(0, read.bytesRead).toString())) reject();
        } finally { await file.close(); }
      }
      found.push(item.path);
    }
    return found;
  }
  async inspect(service: RemovalService): Promise<ServiceObservation> {
    this.check(service);
    const properties = ['LoadState', 'ActiveState', 'UnitFileState', 'MainPID', 'FragmentPath', 'DropInPaths', 'Names', 'Also', 'Triggers', 'TriggeredBy', 'ConsistsOf', 'BoundBy', 'PropagatesStopTo', 'OnSuccess', 'OnFailure', 'ControlGroup'];
    const text = await this.exec(['show', ...properties.flatMap(name => ['--property', name]), '--', service.unit]);
    const values = Object.fromEntries(text.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
    const found = await this.artifacts(), unit = join(this.record.directory, service.unit);
    const names = (values.Names ?? '').split(' ').filter(Boolean), dropIns = (values.DropInPaths ?? '').split(' ').filter(Boolean);
    const also = (values.Also ?? '').split(' ').filter(Boolean), triggers = ['Triggers', 'TriggeredBy', 'ConsistsOf', 'BoundBy', 'PropagatesStopTo', 'OnSuccess', 'OnFailure'].flatMap(key => (values[key] ?? '').split(' ').filter(Boolean));
    const present = values.LoadState === 'not-found' && !found.length ? false : values.LoadState === 'loaded' && found.includes(unit) ? true : null;
    const active = ['inactive', 'failed'].includes(values.ActiveState ?? '') ? false : values.ActiveState === 'active' ? true : null;
    const enabled = ['disabled', 'static', 'not-found', ''].includes(values.UnitFileState ?? '') && !this.record.artifacts.some(item => item.link && found.includes(item.path)) ? false
      : values.UnitFileState === 'enabled' ? true : null;
    const mainPid = /^\d+$/u.test(values.MainPID ?? '') && Number.isSafeInteger(Number(values.MainPID)) ? Number(values.MainPID) : null;
    const foreignArtifacts = names.some(name => name !== service.unit) || (present !== false && values.FragmentPath !== unit)
      || dropIns.some(path => !this.record.artifacts.some(item => item.path === path && item.link === null));
    const group = values.ControlGroup;
    // Unknown caller cgroup is a refusal; manager observation alone cannot establish a separate personal terminal.
    const caller = readProcessFile(`/proc/${process.pid}/cgroup`);
    const callerInService = caller === null || !!group && caller.split('\n').some(line => line.endsWith(`:${group}`) || line.includes(`:${group}/`));
    return { ownershipDigest: service.ownershipDigest, active, enabled, present, mainPid, also, triggers, foreignArtifacts, callerInService,
      revision: sha256(JSON.stringify([values, found])) };
  }
  async stop(service: RemovalService) { this.check(service); await this.exec(['stop', '--', service.unit]); }
  async disable(service: RemovalService) {
    this.check(service); const found = await this.artifacts();
    for (const item of this.record.artifacts.filter(item => item.link && found.includes(item.path))) await unlink(item.path);
    await this.reload(service);
  }
  async removeOwnedArtifacts(service: RemovalService) {
    this.check(service); const found = await this.artifacts();
    for (const item of this.record.artifacts.filter(item => item.link === null && found.includes(item.path))) await unlink(item.path);
  }
  async reload(service: RemovalService) { this.check(service); await this.exec(['daemon-reload']); }
}
