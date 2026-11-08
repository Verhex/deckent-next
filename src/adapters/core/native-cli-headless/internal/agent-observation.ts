import { constants } from 'node:fs';
import { open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { modelInvocationProfileSchema, type ModelInvocationProfile } from '#domain/index.js';
import { modelInvocationProfileDigest } from '#engine/index.js';
import { nativeAgentExecutionSchema, type NativeAgentReadinessReason } from '#capabilities/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { isNativeCliHeadlessAdapter, nativeCliHeadlessDefinitionSchema, refuse } from './contract.js';
import { nativeAgentFlagSetDigest, headlessRequiredFlags } from './env.js';
import { headlessPreflight, type HeadlessPreflight } from './preflight.js';
import type { HeadlessIsolation } from './realm.js';
import { loginRecordPath } from './login-lock.js';

export function agentTarget(input: ModelInvocationProfile) {
  const profile = modelInvocationProfileSchema.parse(input), definition = nativeCliHeadlessDefinitionSchema.parse(profile.adapter.definition);
  const entry = nativeCliAgent(profile.protocol.family);
  if (!entry || !isNativeCliHeadlessAdapter(profile.adapter) || profile.schemaVersion === 1 || profile.billingAxis !== 'subscription') refuse('HEADLESS_REQUEST_INVALID', { reason: 'profile' });
  return { profile, entry, definition };
}
/** No model call. A separate agent flag set, never the tool-less v1 capability. Tool/plugin observations remain absent until a guarded turn. */
export async function preflightNativeAgent(profile: ModelInvocationProfile, now: () => number, isolation: HeadlessIsolation, signal?: AbortSignal) {
  const { entry, definition } = agentTarget(profile), flagSetDigest = nativeAgentFlagSetDigest(entry);
  const requiredFlags = headlessRequiredFlags({ ...entry, headless: { ...entry.headless, args: entry.agent.args } });
  const preflight = await headlessPreflight(entry, definition, now, isolation, signal, { flagSetDigest, requiredFlags });
  const execution = nativeAgentExecutionSchema.parse({ schemaVersion: 1, capability: 'NativeAgentExecution', executable: preflight.executable,
    cliVersion: preflight.version, flagSetDigest, profileDigest: modelInvocationProfileDigest(profile), ownerUid: definition.ownerUid });
  if (!await readNativeAgentObservation(profile, now)) await recordNativeAgentObservation(profile, preflight, execution, now);
  return Object.freeze({ execution, preflight });
}
const observedSchema = z.strictObject({ cli: z.boolean(), login: z.boolean(), environment: z.boolean(),
  toolSurface: z.boolean().optional(), plugins: z.boolean().optional(), bridge: z.boolean().optional(), execution: nativeAgentExecutionSchema });
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), scopeId: z.string(), reference: z.unknown(), checkedAtMs: z.number().int().nonnegative(),
  identity: z.string(), observed: observedSchema });
const targetPath = (profile: ModelInvocationProfile, stateDir: string) => join(stateDir, `agent-${modelInvocationProfileDigest(profile)}.json`);
/** Metadata only: no login-file contents. An executable/config/login-marker replacement makes the retained observation stale. */
async function identity(profile: ModelInvocationProfile) {
  const { definition, entry } = agentTarget(profile), executable = await realpath(definition.executable);
  const stamp = async (path: string) => stat(path).then(s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.uid, s.mode], () => null);
  return JSON.stringify([executable, await stamp(executable), await stamp(definition.configDir),
    await Promise.all(entry.headless.isolation.configVisible.map(name => stamp(join(definition.configDir, name)))),
    await stamp(loginRecordPath(definition.configDir, definition.stateDir))]);
}
export async function recordNativeAgentObservation(profile: ModelInvocationProfile, preflight: HeadlessPreflight,
  execution: z.infer<typeof nativeAgentExecutionSchema>, now: () => number, surface?: true | NativeAgentReadinessReason): Promise<void> {
  const { definition } = agentTarget(profile), current = await identity(profile);
  const observed = { cli: true, login: true, environment: true, execution,
    ...(surface === true ? { toolSurface: true, plugins: true, bridge: true } : surface ? {
      ...(surface === 'NATIVE_AGENT_PLUGIN_UNEXPECTED' ? { plugins: false } : { toolSurface: false }) } : {}) };
  if (preflight.executable !== execution.executable || preflight.version !== execution.cliVersion) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-seal' });
  const path = targetPath(profile, definition.stateDir), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(recordSchema.parse({ schemaVersion: 1, scopeId: profile.scopeId, reference: profile.reference,
      checkedAtMs: now(), identity: current, observed })), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
/** Bounded read-only K7 input: missing/malformed/foreign/stale records are unknown. Never spawn, refresh, sign in or read credentials.
 * `display` (R8e, /provider and /model only, never a gate): the last verification counts past its age and the CLI's own login-file writes, and
 * carries `checkedAtMs` (when that verification was recorded) so a person is told its time; the K16 age still gates every turn. */
export async function readNativeAgentObservation(profile: ModelInvocationProfile, now: () => number = Date.now, display = false) {
  try {
    const { entry, definition } = agentTarget(profile);
    if (process.getuid?.() !== definition.ownerUid || constants.O_NOFOLLOW === undefined) return null;
    const file = await open(targetPath(profile, definition.stateDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: unknown;
    try {
      const info = await file.stat(), bound = entry.headless.limits.preflightOutputBytes;
      if (!info.isFile() || info.nlink !== 1 || info.uid !== definition.ownerUid || (info.mode & 0o077) !== 0 || info.size > bound) return null;
      const bytes = Buffer.alloc(bound + 1), read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > bound) return null;
      value = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
    } finally { await file.close(); }
    const record = recordSchema.parse(value), execution = record.observed.execution;
    const age = now() - record.checkedAtMs;
    if (!entry.agent.observationMaxAgeMs || age < 0 || !display && age > entry.agent.observationMaxAgeMs
      || record.scopeId !== profile.scopeId || !isDeepStrictEqual(record.reference, profile.reference)
      || execution.profileDigest !== modelInvocationProfileDigest(profile) || execution.flagSetDigest !== nativeAgentFlagSetDigest(entry)
      || execution.ownerUid !== definition.ownerUid || execution.executable !== await realpath(definition.executable)
      || !display && record.identity !== await identity(profile)) return null;
    return Object.freeze({ ...record.observed, toolSurface: record.observed.toolSurface ?? null,
      plugins: record.observed.plugins ?? null, bridge: record.observed.bridge ?? null, ...(display ? { checkedAtMs: record.checkedAtMs } : {}) }); // NF-7: display says when
  } catch { return null; }
}
