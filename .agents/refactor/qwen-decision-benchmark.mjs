#!/usr/bin/env node
// Explicit, bounded live benchmark; never run in ordinary tests. No training/promotion.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { loadSettings } from './qwen-decision.mjs';
import { createDecisionEngine } from './qwen-decision-store.mjs';
import { boundedJson } from './qwen-decision-client.mjs';
import { consult } from './jev-review.mjs';
import { readCredential, validateConfig } from './jev.mjs';
import { fixtures } from './qwen-decision-fixtures.mjs';
const run = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const percentile = (v, p) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.ceil(a.length * p) - 1] : null; };
const args = process.argv.slice(2);
if (!args[0] || args.some((a, i) => i > 0 && a !== '--compare-jev')) throw new Error('QWEN_BENCHMARK_USAGE');
const output = resolve(args[0]); await mkdir(output, { recursive: true, mode: 0o700 });
const settings = await loadSettings(); const { config, policy } = settings;
const engine = createDecisionEngine({ config, policy, root: join(output, 'local-journal') });
const gpu = []; let sampling = true; let phase = 'baseline-idle';
async function sample() {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=uuid,power.draw,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 2000 });
    const rows = stdout.trim().split('\n');
    for (const row of rows) { const [uuid, watts, memoryMiB, utilization] = row.split(',').map(v => v.trim());
      gpu.push({ atMs: Date.now(), phase, uuid, watts: Number(watts), memoryMiB: Number(memoryMiB), utilization: Number(utilization) }); }
  } catch { gpu.push({ atMs: Date.now(), phase, error: 'GPU_MEASUREMENT_UNAVAILABLE' }); }
}
const sampler = (async () => { while (sampling) { await sample(); await sleep(500); } })();
let jev;
if (args.includes('--compare-jev')) {
  const remoteConfig = validateConfig(JSON.parse(await readFile(new URL('./jev.config.json', import.meta.url))));
  const key = await readCredential(remoteConfig);
  jev = c => consult(remoteConfig, policy, c, join(output, 'jev-journal'), key);
}
const results = []; const chat = []; const windows = [];
async function chatProbe(label) {
  const start = performance.now();
  const r = await fetch(new URL('/v1/chat/completions', config.baseUrl), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model,
      messages: [{ role: 'user', content: 'Explain in Turkish how to preserve another contributor\'s work while investigating a failed test. Use a numbered list with concrete steps.' }],
      max_tokens: 128, temperature: 0, chat_template_kwargs: { enable_thinking: false }, stream: false }) });
  if (!r.ok) throw new Error(`QWEN_CHAT_HTTP_${r.status}`);
  const response = await boundedJson(r, config.maxResponseBytes);
  return { label, latencyMs: performance.now() - start, outputTokens: response.usage?.completion_tokens,
    model: response.model, surface: 'direct-HTTP-chat-proxy-not-native-terminal' };
}
try {
  process.stdout.write('benchmark: passive GPU baseline (5s)\n'); await sleep(5000);
  const cases = fixtures();
  // Warm both single-token scoring and chat paths; exclude these from latency/quality.
  phase = 'warmup'; await engine.ask(cases[0].case); await chatProbe('warmup');
  phase = 'local-quality'; const qualityStart = Date.now();
  for (const f of cases) {
    const r = await engine.ask(f.case);
    results.push({ fixture: f.id, expectedChoice: f.expectedChoice, labels: f.labels, local: r });
    process.stdout.write(`benchmark: local ${f.id} ${r.status} ${r.latencyMs ?? 'unknown'} ms\n`);
  }
  windows.push({ phase, start: qualityStart, end: Date.now(), logicalRequests: cases.length });
  if (jev) {
    phase = 'jev-quality';
    for (const row of results) { row.jev = await jev(cases.find(f => f.id === row.fixture).case);
      process.stdout.write(`benchmark: Jev ${row.fixture} ${row.jev.status}\n`); }
  }
  phase = 'chat-alone';
  for (let i = 0; i < 3; i++) chat.push(await chatProbe('alone'));
  const qualityRows = results.filter(r => !r.concurrencyOnly);
  function quality(provider) {
    const rows = qualityRows.filter(r => r[provider]?.status === 'advice');
    const binary = rows.map(r => ({ expected: r.labels.evidence_supported,
      p: r[provider].answers.evidence_supported.noul }));
    return { attempted: qualityRows.length, complete: rows.length,
      correctChoices: rows.filter(r => r[provider].answers.next_action.choice === r.expectedChoice).length,
      correctBinary: binary.filter(r => (r.p >= 0.5) === r.expected).length,
      brier: binary.length ? binary.reduce((s, r) => s + (r.p - Number(r.expected)) ** 2, 0) / binary.length : null,
      p50Ms: percentile(rows.map(r => r[provider].latencyMs), 0.5), p95Ms: percentile(rows.map(r => r[provider].latencyMs), 0.95),
      highScoreWrongChoices: rows.filter(r => r[provider].answers.next_action.choice !== r.expectedChoice
        && r[provider].answers.next_action.probabilities[r[provider].answers.next_action.choice] >= 0.9).length };
  }
  const baseline = gpu.filter(g => g.phase === 'baseline-idle' && Number.isFinite(g.watts));
  const baselineOk = baseline.length >= 4 && baseline.every(g => g.utilization <= 5)
    && new Set(baseline.map(g => g.uuid)).size === 1;
  const idleWatts = baselineOk ? baseline.reduce((s, g) => s + g.watts, 0) / baseline.length : null;
  const energy = windows.map(w => {
    const samples = gpu.filter(g => g.atMs >= w.start && g.atMs <= w.end && Number.isFinite(g.watts));
    let joules = 0; for (let i = 1; i < samples.length; i++)
      joules += (samples[i].watts + samples[i - 1].watts) / 2 * (samples[i].atMs - samples[i - 1].atMs) / 1000;
    const observedMs = samples.length >= 2 ? samples.at(-1).atMs - samples[0].atMs : null;
    return { ...w, observedMs, sampledGpuWh: observedMs === null ? null : joules / 3600,
      idleSubtractedWhPerRequest: idleWatts === null || observedMs === null ? null
        : (joules - idleWatts * observedMs / 1000) / 3600 / w.logicalRequests,
      scope: 'sampled-GPU-only-estimate; observed interval excludes edge gaps; not wall-plug energy' };
  });
  const alone = chat.filter(c => c.label === 'alone');
  const aloneP50 = percentile(alone.map(c => c.latencyMs), 0.5);
  const summary = { schemaVersion: 1, at: new Date().toISOString(), model: config.model,
    dataset: '8 frozen human-authored synthetic development fixtures; 4 true/4 false; not representative acceptance',
    local: quality('local'), jev: jev ? quality('jev') : null,
    chat: { samples: 3, surface: 'direct HTTP proxy; actual native terminal not measured',
      aloneP50Ms: aloneP50, aloneP95Ms: percentile(alone.map(c => c.latencyMs), 0.95),
      concurrency: 'not-admitted; owner narrowed pilot to idle-only', observations: chat },
    gpu: { samples: gpu.length, baselineValid: baselineOk, idleWatts,
      minMemoryMiB: Math.min(...gpu.filter(g => Number.isFinite(g.memoryMiB)).map(g => g.memoryMiB)),
      maxMemoryMiB: Math.max(...gpu.filter(g => Number.isFinite(g.memoryMiB)).map(g => g.memoryMiB)), energy },
    automaticPromotion: false, independentReview: 'not-assessed' };
  await writeFile(join(output, 'results.json'), JSON.stringify({ summary, results, gpu }, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify(summary) + '\n');
} finally { sampling = false; await sampler; }
