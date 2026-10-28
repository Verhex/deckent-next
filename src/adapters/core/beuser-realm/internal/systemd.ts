import type { BeuserContext } from '#engine/core/beuser-contract/index.js';
import type { BeuserRealmHandle } from '#engine/core/beuser-realm/index.js';
import { sha256 } from '#platform/index.js';
import { BEUSER_REALM_RECIPE as recipe, checkHandle, type BeuserRealmCommand } from './realm.js';
export interface BeuserSystemdCapability {
  readonly state: 'available' | 'unknown'; readonly evidenceRefs: readonly string[];
  readonly branches: readonly string[];
}
/** Tries only a private user manager/bus. No capability, privilege, host bus or cgroup write is added. */
export async function probeBeuserSystemd(context: BeuserContext, handle: BeuserRealmHandle, command: BeuserRealmCommand): Promise<BeuserSystemdCapability> {
  checkHandle(context, handle);
  const script = `const {spawn}=require('node:child_process'),fs=require('node:fs');
const bus=process.env.XDG_RUNTIME_DIR+'/bus';
const p=spawn(${JSON.stringify(recipe.systemdProbe[0])},${JSON.stringify(recipe.systemdProbe.slice(1))},{stdio:'ignore',env:{HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}});
const deadline=setTimeout(()=>{p.kill('SIGKILL');process.exit(2)},${context.limits.maxWaitMs});deadline.unref();
p.on('error',()=>process.exit(2));
p.on('exit',()=>process.exit(2));
setTimeout(()=>{const c=spawn('systemctl',['--user','is-system-running'],{stdio:'ignore',env:{HOME:process.env.HOME,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS:'unix:path='+bus}});c.on('error',()=>process.exit(2));c.on('exit',code=>{const ok=code===0&&fs.statSync(bus).isSocket();p.kill('SIGKILL');process.exit(ok?0:2)});},${Math.floor(context.limits.maxWaitMs / 2)});`;
  try {
    const result = await command(['container', 'exec', handle.containerId, 'node', '--eval', script], context);
    return { state: 'available', evidenceRefs: [`beuser-systemd:sha256:${sha256(result)}`], branches: ['S2-systemd', 'S4', 'S4b/K4'] };
  } catch { return { state: 'unknown', evidenceRefs: [], branches: ['S2-systemd', 'S4', 'S4b/K4'] }; }
}
