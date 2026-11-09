import { nativeCliIds, nativeCliIdSchema, NativeCliRegistryError, REASONING_EFFORTS, workerEffortSchema, type WorkerEffort } from '#domain/index.js';
import type { z } from 'zod';
import asset from '../../../../../assets/native-coding/commands.json' with { type: 'json' };
import { parseNativeCliRegistry } from '#capabilities/index.js';
export { parseNativeCliRegistry, nativeCliCapabilitiesSchema, nativeEffortArgs, nativeCliHeadlessSchema, type NativeCliCapabilities, type NativeCliHeadless } from '#capabilities/index.js';
export { NativeCliRegistryError, REASONING_EFFORTS, workerEffortSchema, nativeCliIds, nativeCliIdSchema, type WorkerEffort };
const registry = parseNativeCliRegistry(asset);
/** Shared facade policy. Absent fields are never replaced by adapter defaults. */
export const nativeCliAgentBridge = () => registry.agentBridge;
export function nativeCliCommand(provider: z.infer<typeof nativeCliIdSchema>) {
  const parsed = nativeCliIdSchema.safeParse(provider);
  if (!parsed.success || !Object.hasOwn(registry.adapters, parsed.data)) throw new NativeCliRegistryError();
  return registry.adapters[parsed.data]!;
}

/** U9-6: the one CLI that declares an embedded app-server, selected by data (never by a CLI name); `id` is its registry key. */
export function nativeCliAppServer() {
  const found = Object.entries(registry.adapters).filter(([, command]) => command.appServer);
  if (found.length !== 1) throw new NativeCliRegistryError();
  return Object.freeze({ id: found[0]![0], executable: found[0]![1].executable, ...found[0]![1].appServer! });
}
/** The CLI whose profile family (its headless `protocolFamily`, else its event stream) is `protocolFamily` and that declares a headless model step; selected by data, never by a CLI name. `id` is its
 * registry key (S3-5: the native provider whose gateway destinations its isolated network may reach). */
export function nativeCliHeadless(protocolFamily: string) {
  const found = Object.entries(registry.adapters).filter(([, command]) => command.headless && (command.headless.protocolFamily ?? command.capabilities.eventStream) === protocolFamily);
  return found.length === 1 ? { id: found[0]![0], command: found[0]![1], headless: found[0]![1].headless! } : null;
}
const agents = new WeakMap<object, unknown>();
/** A separate capability lookup; the existing text-chat lookup and its digest stay byte-for-byte compatible. One frozen entry per registry CLI, so its digest memoizes by identity. */
export function nativeCliAgent(protocolFamily: string) {
  const entry = nativeCliHeadless(protocolFamily);
  if (!entry?.command.agent || !registry.agentBridge) return null;
  if (!agents.has(entry.command)) agents.set(entry.command, Object.freeze({ ...entry, agent: entry.command.agent, bridge: registry.agentBridge }));
  return agents.get(entry.command) as Readonly<typeof entry & { agent: NonNullable<typeof entry.command.agent>; bridge: NonNullable<typeof registry.agentBridge> }>;
}
const loginEntries = Object.freeze(Object.entries(registry.adapters).map(([id, command]) => Object.freeze({ id, names: command.headless?.isolation.configVisible ?? [] })));
/** KG7 F4: each registry CLI's login-context file names (its login dir is `<loginRoot>/<id>`); the one source of the login read deny and the shell's login identity paths. */
export const nativeCliLoginEntries = (): readonly { readonly id: string; readonly names: readonly string[] }[] => loginEntries;
/** Login-context files from the CLI registry, scoped to the layout's login tree (never a blanket auth.json ban). */
export function nativeCliLoginReadDeny(loginRoot: string): readonly string[] {
  return Object.freeze(loginEntries.flatMap(({ id, names }) => names.map(name => `**/${loginRoot}/${id}/${name}`)));
}
