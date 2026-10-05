// Development-only custody. A recorded selection cannot grant approval or execute work.
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { prepare, ensure } from './jev-context.mjs';
import { callId, validateCallId, safeData, privateDirectory, writeEvent, readEvent, entries } from './jev-journal.mjs';
import { followup, report } from './jev-review.mjs';
import { createScorer, sha256, validateLocalConfig } from './qwen-decision-client.mjs';
import { requireIdle } from './qwen-decision-idle.mjs';

export function errorCode(e) {
  return /^(?:QWEN|JEV)_[A-Z0-9_]+$/.test(e.message) ? e.message : 'QWEN_RESULT_UNKNOWN';
}
async function optional(directory, name) {
  try { await lstat(join(directory, name)); return await readEvent(directory, name); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function createDecisionEngine({ config, policy, root, transport, secret }) {
  validateLocalConfig(config); const scorer = createScorer(config, transport);
  async function replay(directory, digest) {
    const prior = await readEvent(directory, 'request.json');
    ensure(prior.requestSha256 === digest, 'QWEN_COMMAND_CONFLICT');
    const response = await optional(directory, 'response.json');
    if (response) return { ...response, replayed: true, directory };
    return { callId: prior.callId, status: 'unknown', replayed: true, advisoryOnly: true,
      acceptance: 'not-assessed', error: (await optional(directory, 'failure.json'))?.error ?? 'QWEN_RESULT_UNKNOWN', directory };
  }
  return {
    prepare: c => prepare(c, policy),
    async ask(c, { id = callId(), signal } = {}) {
      validateCallId(id); const prepared = prepare(c, policy); safeData(prepared, secret);
      ensure(Object.keys(prepared.input.questions).length <= config.maxQuestions, 'QWEN_QUESTION_LIMIT');
      const digest = sha256({ input: prepared.input, config });
      const directory = join(await privateDirectory(root), id);
      // Existing receipt lookup precedes activity checks: busy chat must not block replay.
      const existing = await optional(directory, 'request.json');
      if (existing) return replay(directory, digest);
      const activity = await requireIdle(config, transport, signal);
      const request = { schemaVersion: 1, callId: id, at: new Date().toISOString(), case: c, ...prepared,
        provider: 'local-qwen', endpoint: config.baseUrl, requestedModel: config.model,
        requestSha256: digest, calibration: 'not-measured', advisoryOnly: true, activity };
      try { await writeEvent(directory, 'request.json', request, secret); }
      catch (e) { if (e.code === 'EEXIST') return replay(directory, digest); throw e; }
      const start = performance.now(); let sent = 0;
      try {
        const result = await scorer.score(prepared.input, { signal,
          beforeQuestion: async (questionId, body, idle) => {
            safeData(body, secret);
            await writeEvent(directory, `send-${sent + 1}.json`, { schemaVersion: 1, questionId,
              at: new Date().toISOString(), wireSha256: sha256(body), requestedModel: body.model,
              thinking: false, maxOutputTokens: 1, activity: idle }, secret);
            sent++;
          },
          afterQuestion: async (questionId, decoded, observation) => {
            await writeEvent(directory, `answer-${sent}.json`, { schemaVersion: 1, questionId,
              at: new Date().toISOString(), ...decoded, observation }, secret);
          },
        });
        const response = { schemaVersion: 1, callId: id, status: 'advice', advisoryOnly: true,
          acceptance: 'not-assessed', replayed: false, provider: 'local-qwen', requestedModel: config.model,
          ...result, requestSha256: digest, measuredAt: new Date().toISOString(), latencyMs: performance.now() - start };
        await writeEvent(directory, 'response.json', response, secret); return { ...response, directory };
      } catch (e) {
        const failure = { schemaVersion: 1, callId: id, at: new Date().toISOString(), status: 'unknown',
          error: errorCode(e), latencyMs: performance.now() - start, attemptedQuestions: sent,
          usage: 'unknown', retry: 'never-automatic', rawResponseRetained: false };
        try { await writeEvent(directory, 'failure.json', failure, secret); }
        catch { /* The persisted request still proves an unresolved call. Never send again. */ }
        return { callId: id, status: 'unknown', advisoryOnly: true, acceptance: 'not-assessed',
          replayed: false, error: failure.error, directory };
      }
    },
    followup: (id, kind, value) => followup(root, id, kind, value, secret),
    async report() {
      const summary = await report(root, policy.reportLimit);
      for (const row of summary.rows) {
        const directory = join(root, row.callId);
        const response = await optional(directory, 'response.json');
        const failure = await optional(directory, 'failure.json');
        row.status = response ? 'advice' : 'unknown';
        row.calibration = response?.calibration ?? 'not-measured';
        row.error = failure?.error ?? null;
      }
      return { ...summary, provider: 'local-qwen', calibration: 'not-measured',
        confidenceMeaning: 'option-concentration-not-correctness', automaticRouting: false };
    },
    async inspect(id) {
      validateCallId(id); const directory = join(root, id);
      const request = await readEvent(directory, 'request.json');
      return replay(directory, request.requestSha256);
    },
    async list() { return entries(root, policy.reportLimit); },
  };
}
