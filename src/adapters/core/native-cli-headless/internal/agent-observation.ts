import { DeckentError as ProviderDiagnostic, headlessDiagnostic, isRecord, isSandboxViewDiagnostic } from '#platform/index.js';
import { constants } from 'node:fs';
import { open, rename, rm, stat, writeFile } from 'node:fs/promises';
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
import { closedPreflightRefusal, headlessPreflight, type HeadlessPreflight } from './preflight.js';
import type { HeadlessIsolation } from './realm.js';
import { loginRecordPath } from './login-lock.js';
import { headlessExecutableRefusal, resolveHeadlessExecutable, type HeadlessExecutable } from './executable.js';

export function agentTarget(input: ModelInvocationProfile) {
  const profile = modelInvocationProfileSchema.parse(input), definition = nativeCliHeadlessDefinitionSchema.parse(profile.adapter.definition);
  const entry = nativeCliAgent(profile.protocol.family);
  if (!entry || !isNativeCliHeadlessAdapter(profile.adapter) || profile.schemaVersion === 1 || profile.billingAxis !== 'subscription') refuse('HEADLESS_REQUEST_INVALID', { reason: 'agent-profile' });
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
const publications = new Map<string, Promise<void>>();

async function readObservationRecord(path: string, ownerUid: number, bound: number) {
  const text = await readOwnedRecord(path, ownerUid, bound);
  try { return text === null ? null : recordSchema.safeParse(JSON.parse(text)).data ?? null; } catch { return null; }
}
/** Display only: a closed preflight record's sandbox argument-count refusal in the writer's form, read with the observation's file checks. */
export async function readClosedPreflightRefusal(profile: ModelInvocationProfile) {
  const { entry, definition } = agentTarget(profile);
  const text = await readOwnedRecord(join(definition.stateDir, 'preflight.json'), definition.ownerUid, entry.headless.limits.preflightOutputBytes);
  let record: unknown; try { record = text === null ? null : JSON.parse(text); } catch { return null; }
  const refusal = isRecord(record) && record['state'] === 'closed' ? closedPreflightRefusal(record) : null;
  return refusal && isSandboxViewDiagnostic(refusal) ? refusal : null;
}
async function readOwnedRecord(path: string, ownerUid: number, bound: number) {
  if (process.getuid?.() !== ownerUid || constants.O_NOFOLLOW === undefined) return null;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== ownerUid || (info.mode & 0o077) !== 0 || info.size > bound) return null;
    const bytes = Buffer.alloc(bound + 1), read = await file.read(bytes, 0, bytes.length, 0);
    return read.bytesRead > bound ? null : bytes.subarray(0, read.bytesRead).toString('utf8');
  } finally { await file.close(); }
}

/** Metadata only: no login-file contents. An executable/config/login-marker replacement makes the retained observation stale. */
async function identity(profile: ModelInvocationProfile, program: HeadlessExecutable) {
  const { definition, entry } = agentTarget(profile);
  const stamp = async (path: string) => stat(path).then(s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.uid, s.mode], () => null);
  return JSON.stringify([program.identity, await stamp(definition.configDir),
    await Promise.all(entry.headless.isolation.configVisible.map(name => stamp(join(definition.configDir, name)))),
    await stamp(loginRecordPath(definition.configDir, definition.stateDir))]);
}
export async function prepareNativeAgentObservation(profile: ModelInvocationProfile, preflight: HeadlessPreflight,
  execution: z.infer<typeof nativeAgentExecutionSchema>, now: () => number, surface?: true | NativeAgentReadinessReason) {
  const { definition, entry } = agentTarget(profile);
  const program = await resolveHeadlessExecutable(entry, definition.executable, definition.ownerUid, 'recheck');
  const observed = { cli: true, login: true, environment: true, execution,
    ...(surface === true ? { toolSurface: true, plugins: true, bridge: true } : surface ? {
      ...(surface === 'NATIVE_AGENT_PLUGIN_UNEXPECTED' ? { plugins: false } : { toolSurface: false }) } : {}) };
  if (preflight.program.identity !== program.identity) headlessExecutableRefusal({ check: 'agent-program-changed' }, program.chosen, program.executable);
  if (preflight.executable !== execution.executable || preflight.version !== execution.cliVersion) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-seal' });
  const path = targetPath(profile, definition.stateDir), temporary = `${path}.${randomUUID()}.tmp`;
  const record = recordSchema.parse({ schemaVersion: 1, scopeId: profile.scopeId, reference: profile.reference,
    checkedAtMs: now(), identity: await identity(profile, program), observed });
  const publish = async () => {
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      const current = await resolveHeadlessExecutable(entry, definition.executable, definition.ownerUid, 'recheck').catch(() => null);
      if (!current || record.identity !== await identity(profile, current)) return;
      const stored = await readObservationRecord(path, definition.ownerUid, entry.headless.limits.preflightOutputBytes).catch(() => undefined);
      if (stored === undefined || stored && stored.checkedAtMs > record.checkedAtMs && stored.scopeId === profile.scopeId
        && isDeepStrictEqual(stored.reference, profile.reference) && stored.observed.execution.profileDigest === execution.profileDigest) return;
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  };
  return async () => {
    const previous = publications.get(path) ?? Promise.resolve();
    const pending = previous.then(publish, publish);
    publications.set(path, pending);
    try { await pending; }
    finally { if (publications.get(path) === pending) publications.delete(path); }
  };
}

async function recordNativeAgentObservation(...args: Parameters<typeof prepareNativeAgentObservation>): Promise<void> {
  const save = await prepareNativeAgentObservation(...args);
  await save();
}
/** Bounded read-only K7 input: missing/malformed/foreign/stale records are unknown. Never spawn, refresh, sign in or read credentials.
 * `display` (R8e, /provider and /model only, never a gate): the last verification counts past its age and the CLI's own login-file writes, and
 * carries `checkedAtMs` (when that verification was recorded) so a person is told its time; the K16 age still gates every turn. */
export async function readNativeAgentObservation(profile: ModelInvocationProfile, now: () => number = Date.now, display = false, diagnosed?: (error: ProviderDiagnostic) => void) {
  try {
    const { entry, definition } = agentTarget(profile);
    const record = await readObservationRecord(targetPath(profile, definition.stateDir), definition.ownerUid, entry.headless.limits.preflightOutputBytes);
    if (!record) return null;
    const execution = record.observed.execution;
    const age = now() - record.checkedAtMs;
    const program = await resolveHeadlessExecutable(entry, definition.executable, definition.ownerUid);
    const [recordedProgram] = JSON.parse(record.identity) as [unknown];
    if (!entry.agent.observationMaxAgeMs || age < 0 || !display && age > entry.agent.observationMaxAgeMs
      || record.scopeId !== profile.scopeId || !isDeepStrictEqual(record.reference, profile.reference)
      || execution.profileDigest !== modelInvocationProfileDigest(profile) || execution.flagSetDigest !== nativeAgentFlagSetDigest(entry)) return null;
    if (execution.ownerUid !== definition.ownerUid) {
      diagnosed?.(headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-owner-mismatch' }));
      return null;
    }
    if (execution.executable !== program.executable || recordedProgram !== program.identity) {
      diagnosed?.(headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-program-changed' }));
      return null;
    }
    if (!display && record.identity !== await identity(profile, program)) {
      diagnosed?.(headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'agent-observation-identity-unverified' }));
      return null;
    }
    return Object.freeze({ ...record.observed, toolSurface: record.observed.toolSurface ?? null,
      plugins: record.observed.plugins ?? null, bridge: record.observed.bridge ?? null, ...(display ? { checkedAtMs: record.checkedAtMs } : {}) }); // NF-7: display says when
  } catch (error) {
    if (error instanceof ProviderDiagnostic) diagnosed?.(error);
    return null;
  }
}
