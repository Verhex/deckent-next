import { join } from 'node:path';
import { z } from 'zod';
import controller from '../../../../../assets/beuser/controller.json' with { type: 'json' };
import { beuserPrivateRecord } from '#adapters/index.js';
import { BEUSER_LIMITS_REGISTRY } from '#engine/index.js';
import { ErrorRegistry, globalStateRoot, loadConfig, inspectProductDirectory, sha256, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { inspectConfiguredRun } from '#composition/core/runs/index.js';
import { readConfiguredBeuserReport } from './application.js';

const model = z.object({ channelId: z.string(), modelId: z.string() }).strict();
/** Observation only: the Run ledger and report keep authority; an old observation never proves process liveness. */
export const beuserMonitorRecord = z.object({ schemaVersion: z.literal(1), runId: z.string(), journey: z.string(), startedAt: z.number(),
  walkers: z.array(z.object({ id: z.string(), walker: model, judge: model, limitsRevision: z.string() }).strict()) }).strict();
export const beuserMonitorName = (scopeId: string, principal: { issuer: string; subject: string }) => `beuser-monitor-${sha256(JSON.stringify([scopeId, principal.issuer, principal.subject]))}`;
export async function inspectConfiguredBeuserMonitor(options: ConfigLoadOptions = {}) {
  const state = globalStateRoot(options.env ?? process.env);
  if (!state) return null;
  const root = join(state, controller.folder), config = await loadConfig(root, { ...options, heal: false });
  const scopeId = (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
  if (!scopeId) return null;
  const c = await loadConfiguredScopeContext(root, scopeId, { ...options, heal: false }, 'read');
  const crashes = await inspectProductDirectory(c.layout, 'crashes').catch(error => {
    if ((error as { code?: string }).code === 'MANAGED_FILE_MISSING') return null; throw error;
  });
  if (!crashes) return null;
  const held = await beuserPrivateRecord(crashes, beuserMonitorName(scopeId, c.principal), c.config.artifacts.maxBytes).read();
  if (held.kind === 'absent') return null;
  if (held.kind !== 'ready') throw ErrorRegistry.createError('BEUSER_INPUT_INVALID');
  const record = beuserMonitorRecord.parse(held.value);
  const run = (await inspectConfiguredRun(root, { schemaVersion: 1, scopeId, runId: record.runId }, { ...options, heal: false })).run;
  const report = await readConfiguredBeuserReport(root, scopeId, record.runId, options).catch(error => {
    if ((error as { code?: string }).code === 'BEUSER_REPORT_NOT_FOUND') return null; throw error;
  });
  return { ...record, state: run?.state ?? 'unknown', elapsedMs: report?.elapsedMs ?? Math.max(0, Date.now() - record.startedAt), report,
    walkers: record.walkers.map(row => ({ ...row, phase: run?.tasks.find(task => task.id === row.id)?.phase ?? 'unknown',
      limits: BEUSER_LIMITS_REGISTRY.profiles.find(limit => limit.revision === row.limitsRevision) ?? null })) };
}
