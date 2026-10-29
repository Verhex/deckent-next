import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { beuserBindingDigest, type BeuserContext, type BeuserRealmHandle, type BeuserRealmRemoval } from '#engine/index.js';
import type { ArtifactStore } from '#capabilities/index.js';
import type { JsonRecordFile } from '#platform/index.js';
import { BeuserContainerMissing, canonicalRealmPath, dockerRealmCommand, namespaceReadback, refuseRealm, type BeuserRealmOptions, type BeuserRealmCommand } from './realm.js';
import { retainBeuserJson } from './records.js';

const fields = { bindingDigest: z.string(), incarnation: z.string().uuid(), containerId: z.string(),
  pid: z.number().int().positive(), start: z.string().regex(/^\d+$/u), cgroup: z.string() };
const snapshotSchema = z.union([
  z.object({ ...fields, schemaVersion: z.literal(2), mergedRoot: z.string().nullable(), daemonId: z.string().min(1).nullable(),
    namespaces: z.record(z.string(), z.string()) }).strict(),
  z.object({ ...fields, mergedRoot: z.string() }).strict(),
]);
const absent = async (path: string) => lstat(path).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
const startTime = async (pid: number) => (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)!.split(' ')[19]!;
/** Kernel custody survives unobservable storage. Daemon statements remain a separate, versioned assurance. */
export function createBeuserRemovalReadback(options: BeuserRealmOptions, artifacts: ArtifactStore, file: JsonRecordFile,
  command: BeuserRealmCommand = dockerRealmCommand(options)) {
  return {
    async capture(ctx: BeuserContext, evidence: { kind: string; value: string; incarnation: string; bindingDigest: string }) {
      if (evidence.kind !== 'containment') return;
      const value = JSON.parse(evidence.value) as { id: string; state: { Pid: number } };
      if (!Number.isSafeInteger(value.state.Pid) || value.state.Pid <= 0 || !/^[a-f0-9]{64}$/u.test(value.id)) return refuseRealm();
      // Reinspection cannot replace the original process pin after an exit or PID reuse.
      const held = await file.read();
      if (held.kind !== 'absent') return;
      let pin: z.infer<typeof snapshotSchema>;
      try {
        const pid = value.state.Pid, start = await startTime(pid);
        const group = (await readFile(`/proc/${pid}/cgroup`, 'utf8')).trim().split('\n').find(row => row.startsWith('0::/'))?.slice(3);
        if (!group || group === '/' || group.includes('..') || !group.includes(value.id)) return;
        const cgroup = resolve('/sys/fs/cgroup', `.${group}`);
        if (!(await lstat(cgroup)).isDirectory() || start !== await startTime(pid)) return;
        pin = snapshotSchema.parse({ schemaVersion: 2, bindingDigest: evidence.bindingDigest, incarnation: evidence.incarnation,
          containerId: value.id, pid, start, cgroup, mergedRoot: null, daemonId: null, namespaces: await namespaceReadback() });
      } catch { return; }
      await file.write(pin);
      // Storage observation is optional; it must never discard the kernel records above.
      if (!('schemaVersion' in pin)) return;
      try {
        const daemonId = (await command(['info', '--format', '{{.ID}}'], ctx)).trim();
        if (!daemonId) return;
        const raw = JSON.parse(await command(['container', 'inspect', value.id], ctx)) as { Id?: string; State?: { Pid?: number }; GraphDriver?: { Data?: { MergedDir?: string } } }[];
        if (raw.length !== 1 || raw[0]?.Id !== value.id || raw[0].State?.Pid !== pin.pid || await startTime(pin.pid) !== pin.start) return;
        const path = raw[0].GraphDriver?.Data?.MergedDir;
        let mergedRoot: string | null = null;
        if (path) {
          try { mergedRoot = await canonicalRealmPath(path, 'directory'); }
          catch (error) { if (!['EACCES', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return; }
        }
        pin = { ...pin, mergedRoot, daemonId };
      } catch { return; }
      await file.write(pin);
    },
    async read(ctx: BeuserContext, handle: BeuserRealmHandle): Promise<BeuserRealmRemoval> {
      const unknown: BeuserRealmRemoval = { processesAbsent: false, cgroupAbsent: false, filesystemAbsent: false,
        filesystemProof: { schemaVersion: 1, source: 'unknown' }, evidenceRefs: [] };
      try {
        const read = await file.read(); if (read.kind !== 'ready') return unknown;
        const pin = snapshotSchema.parse(read.value);
        if (pin.bindingDigest !== beuserBindingDigest(ctx.binding) || pin.incarnation !== handle.incarnation || pin.containerId !== handle.containerId) return unknown;
        if ('schemaVersion' in pin && JSON.stringify(pin.namespaces) !== JSON.stringify(await namespaceReadback())) return unknown;
        const processesAbsent = await absent(`/proc/${pin.pid}`), cgroupAbsent = await absent(pin.cgroup);
        // A root observed at capture must still use direct filesystem proof; no late downgrade.
        const filesystemAbsent = pin.mergedRoot !== null && await absent(pin.mergedRoot);
        let daemon: { id: string; containerAbsent: boolean; incarnationAbsent: boolean } | null = null;
        let source: NonNullable<BeuserRealmRemoval['filesystemProof']>['source'] = filesystemAbsent ? 'kernel-proven' : 'unknown';
        if (pin.mergedRoot === null && 'schemaVersion' in pin && pin.daemonId && processesAbsent && cgroupAbsent) {
          const daemonId = (await command(['info', '--format', '{{.ID}}'], ctx)).trim();
          if (daemonId !== pin.daemonId) return unknown;
          let missing = false;
          await command(['container', 'inspect', handle.containerId], ctx).catch(error => {
            if (error instanceof BeuserContainerMissing && error.containerId === handle.containerId) { missing = true; return ''; }
            throw error;
          });
          const labelled = await command(['container', 'ls', '--all', '--no-trunc', '--quiet', '--filter', `label=deckent.beuser.incarnation=${handle.incarnation}`], ctx);
          daemon = { id: daemonId, containerAbsent: missing, incarnationAbsent: !labelled.trim() };
          if (daemon.containerAbsent && daemon.incarnationAbsent) source = 'daemon-attested';
        }
        const proof = { schemaVersion: 2, bindingDigest: pin.bindingDigest, incarnation: pin.incarnation, containerId: pin.containerId,
          kernel: { pid: pin.pid, start: pin.start, cgroup: pin.cgroup, mergedRoot: pin.mergedRoot }, daemon,
          processesAbsent, cgroupAbsent, filesystemAbsent, filesystemProof: { schemaVersion: 1 as const, source } };
        return { ...proof, evidenceRefs: [await retainBeuserJson(artifacts, ctx, proof)] };
      } catch { return unknown; }
    },
  };
}
