// Observation guard, not a scheduler lock: new chat can arrive after the snapshot.
import { ensure } from './jev-context.mjs';
export function parseActivity(text, model) {
  const values = { running: [], waiting: [], kv: [] };
  for (const line of text.split('\n')) {
    const match = /^vllm:(num_requests_running|num_requests_waiting|kv_cache_usage_perc)\{([^}]*)\}\s+(\S+)$/.exec(line);
    if (!match) continue;
    const label = /(?:^|,)model_name="([^"\\]*)"(?:,|$)/.exec(match[2]);
    if (label?.[1] !== model) continue;
    const n = Number(match[3]); ensure(Number.isFinite(n) && n >= 0, 'QWEN_ACTIVITY_UNKNOWN');
    const key = match[1] === 'num_requests_running' ? 'running' : match[1] === 'num_requests_waiting' ? 'waiting' : 'kv';
    values[key].push(n);
  }
  ensure(values.running.length > 0 && values.waiting.length > 0, 'QWEN_ACTIVITY_UNKNOWN');
  const sum = list => list.reduce((s, v) => s + v, 0);
  return { observedAt: new Date().toISOString(), running: sum(values.running), waiting: sum(values.waiting),
    kvCacheFraction: values.kv.length ? Math.max(...values.kv) : null, admission: 'idle-snapshot-not-exclusive-reservation' };
}
export async function requireIdle(config, transport = fetch, signal) {
  const deadline = AbortSignal.timeout(Math.min(config.timeoutMs, 3000));
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  bounded.throwIfAborted();
  const response = await transport(new URL('/metrics', config.baseUrl), { method: 'GET', redirect: 'error', signal: bounded });
  if (!response.ok) { await response.body?.cancel(); throw new Error('QWEN_ACTIVITY_UNKNOWN'); }
  ensure(response.body, 'QWEN_ACTIVITY_UNKNOWN'); const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; ensure(bytes <= 1048576, 'QWEN_ACTIVITY_UNKNOWN'); chunks.push(Buffer.from(chunk)); }
  const observation = parseActivity(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), config.model);
  ensure(observation.running === 0 && observation.waiting === 0, 'QWEN_SERVER_BUSY');
  return observation;
}
