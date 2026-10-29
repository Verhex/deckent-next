import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { sha256 } from '#platform/index.js';
import { BEUSER_GENESIS_PATH, beuserBindingDigest, createBeuserRealmSeal, type BeuserRealmHandle, type BeuserRealmReadback } from '#engine/index.js';
import type { BeuserContext } from '#engine/index.js';
import { BEUSER_REALM_RECIPE as recipe, checkHandle, NANOSECONDS_PER_SECOND, namespaceReadback, refuseRealm, type BeuserRealmOptions, type BeuserRealmCommand } from './realm.js';

/** Read by a fresh trusted process, never terminal/persona output. No ledger, key, receipt or host HOME is read. */
export const BEUSER_INSPECTION_SCRIPT = `
const fs=require('node:fs'),os=require('node:os');
const text=p=>fs.readFileSync(p,'utf8');
const status=Object.fromEntries(text('/proc/self/status').split('\\n').filter(x=>x.includes(':')).map(x=>{const i=x.indexOf(':');return [x.slice(0,i),x.slice(i+1).trim()]}));
const ns=Object.fromEntries(['mnt','pid','net','ipc','uts','cgroup'].map(n=>[n,fs.readlinkSync('/proc/self/ns/'+n)]));
const mounts=text('/proc/self/mountinfo'),ptsDevice=String(fs.statSync('/dev/pts',{bigint:true}).dev);
const cgroup={memory:text('/sys/fs/cgroup/memory.max').trim(),pids:text('/sys/fs/cgroup/pids.max').trim(),cpu:text('/sys/fs/cgroup/cpu.max').trim()};
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),status,ns,mounts,ptsDevice,cgroup,net:Object.keys(os.networkInterfaces()),genesis:JSON.parse(text('${BEUSER_GENESIS_PATH}'))}));`;
const mount = z.object({ Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean(), Propagation: z.string().optional() });
const inspectSchema = z.array(z.object({ Id: z.string(), Image: z.string(), State: z.object({ Running: z.boolean(), Pid: z.number().int(), StartedAt: z.string() }),
  Config: z.object({ User: z.string(), Labels: z.record(z.string()).nullable(), Env: z.array(z.string()) }),
  HostConfig: z.object({ NetworkMode: z.string(), Privileged: z.boolean(), ReadonlyRootfs: z.boolean(), CapAdd: z.array(z.string()).nullable(),
    CapDrop: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()).nullable(), PidMode: z.string(), IpcMode: z.string(), UTSMode: z.string(),
    CgroupnsMode: z.string(), Memory: z.number(), MemorySwap: z.number(), NanoCpus: z.number(), PidsLimit: z.number(),
    Devices: z.array(z.unknown()).nullable(), Binds: z.array(z.string()).nullable(), Tmpfs: z.record(z.string()) }),
  Mounts: z.array(mount), NetworkSettings: z.object({ Networks: z.record(z.unknown()), Ports: z.record(z.unknown()).nullable() }),
})).length(1);
const probeSchema = z.object({ uid: z.number(), gid: z.number(), status: z.record(z.string()), ns: z.record(z.string()), mounts: z.string(), ptsDevice: z.string(),
  cgroup: z.object({ memory: z.string(), pids: z.string(), cpu: z.string() }), net: z.array(z.string()), genesis: z.unknown() }).strict();
export interface BeuserRealmEvidence {
  readonly kind: 'containment' | 'kernel'; readonly bindingDigest: string; readonly incarnation: string;
  readonly digest: string; readonly value: string;
}
export type BeuserEvidenceRetention = (context: BeuserContext, evidence: BeuserRealmEvidence) => Promise<string>;
export async function inspectBeuserRealm(context: BeuserContext, handle: BeuserRealmHandle, options: BeuserRealmOptions,
  command: BeuserRealmCommand, retain: BeuserEvidenceRetention): Promise<BeuserRealmReadback> {
  checkHandle(context, handle);
  const raw = await command(['container', 'inspect', handle.containerId], context);
  const result = inspectSchema.safeParse(JSON.parse(raw));
  if (!result.success) return refuseRealm();
  const item = result.data[0]!, host = item.HostConfig, labels = item.Config.Labels ?? {};
  const allowed = new Map([[recipe.packageTarget, options.packageRoot], [recipe.genesisTarget, handle.controlDirectory + '/genesis.json']]);
  const binds = item.Mounts.filter(value => value.Type === 'bind');
  const mountsValid = binds.length === allowed.size && binds.every(value => allowed.get(value.Destination) === value.Source && !value.RW
    && (!value.Propagation || value.Propagation === 'rprivate')) && item.Mounts.every(value => value.Type === 'bind' || value.Type === 'tmpfs');
  if (item.Id !== handle.containerId || item.Image !== options.image || !item.State.Running || item.State.Pid <= 0
    || labels['deckent.beuser.binding'] !== beuserBindingDigest(context.binding) || labels['deckent.beuser.incarnation'] !== handle.incarnation
    || item.Config.User !== `${options.uid}:${options.gid}` || host.NetworkMode !== 'none' || host.Privileged || !host.ReadonlyRootfs
    || host.CapAdd?.length || host.CapDrop?.length !== 1 || !host.CapDrop.includes('ALL') || host.SecurityOpt?.length !== 1 || !host.SecurityOpt.some(value => /^no-new-privileges(?::true)?$/u.test(value))
    || host.PidMode !== '' || host.IpcMode !== 'private' || host.UTSMode !== '' || host.CgroupnsMode !== 'private'
    || host.Memory !== options.memoryBytes || host.MemorySwap !== options.memoryBytes || host.NanoCpus !== options.nanoCpus || host.PidsLimit !== options.pids
    || host.Devices?.length || host.Binds?.length || !mountsValid || Object.keys(host.Tmpfs).sort().join(',') !== [recipe.workTarget, '/tmp'].sort().join(',')
    || Object.keys(item.NetworkSettings.Networks).some(name => name !== 'none') || Object.keys(item.NetworkSettings.Ports ?? {}).length) return refuseRealm();
  const probeRaw = await command(['container', 'exec', '--user', `${options.uid}:${options.gid}`, handle.containerId, recipe.nodeExecutable, '--eval', BEUSER_INSPECTION_SCRIPT], context);
  const probe = probeSchema.parse(JSON.parse(probeRaw)), controller = await namespaceReadback();
  const fields = probe.mounts.split('\n').map(line => line.split(' '));
  const mounted = (path: string, mode: string) => fields.some(row => row[4] === path && row[5]?.split(',').includes(mode));
  const cpu = probe.cgroup.cpu.split(' ').map(Number);
  if (probe.uid !== options.uid || probe.gid !== options.gid || probe.status['NoNewPrivs'] !== '1'
    || probe.status['Seccomp'] !== '2' || probe.ptsDevice === String((await stat('/dev/pts', { bigint: true })).dev)
    || !['CapEff', 'CapPrm', 'CapBnd', 'CapAmb', 'CapInh'].every(key => /^0+$/u.test(probe.status[key] ?? ''))
    || !Object.entries(controller).every(([key, value]) => probe.ns[key] && probe.ns[key] !== value)
    || probe.net.some(name => name !== 'lo') || !mounted(recipe.packageTarget, 'ro') || !mounted(recipe.genesisTarget, 'ro')
    || !mounted('/dev/pts', 'rw') || !fields.some(row => row[4] === '/dev/pts' && row.includes('devpts'))
    || !mounted(recipe.workTarget, 'rw') || probe.cgroup.memory !== String(options.memoryBytes) || probe.cgroup.pids !== String(options.pids)
    || cpu.length !== 2 || !cpu.every(value => Number.isSafeInteger(value) && value > 0) || cpu[0]! / cpu[1]! > options.nanoCpus / NANOSECONDS_PER_SECOND
    || JSON.stringify(probe.genesis) !== JSON.stringify(createBeuserRealmSeal(context.binding))) return refuseRealm();
  // Hash only inspected containment fields; arbitrary image Env/labels never become evidence, even as hashes.
  const containment = { id: item.Id, image: item.Image, state: item.State, user: item.Config.User, host, mounts: item.Mounts,
    binding: labels['deckent.beuser.binding'], incarnation: labels['deckent.beuser.incarnation'], network: item.NetworkSettings };
  const evidenceRefs: string[] = [];
  for (const [kind, value] of [['containment', JSON.stringify(containment)], ['kernel', JSON.stringify(probe)]] as const) {
    const ref = await retain(context, Object.freeze({ kind, value, digest: sha256(value),
      bindingDigest: beuserBindingDigest(context.binding), incarnation: handle.incarnation }));
    if (!ref.trim()) return refuseRealm();
    evidenceRefs.push(ref);
  }
  return Object.freeze({ valid: true, evidenceRefs: Object.freeze(evidenceRefs) });
}
