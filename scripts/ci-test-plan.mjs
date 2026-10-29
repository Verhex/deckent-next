import { createHash } from 'node:crypto';
import config from './ci-test-config.json' with { type: 'json' };

const drift = config.durationDrift;
if (!Number.isSafeInteger(config.shards) || config.shards < 1 || !Number.isSafeInteger(config.maxForks) || config.maxForks < 1
  || !Number.isSafeInteger(config.shardOneReservedMs) || config.shardOneReservedMs < 0
  || !(Number.isFinite(drift?.maxRatio) && drift.maxRatio > 1) || !Number.isSafeInteger(drift.minObservedMs) || drift.minObservedMs < 0
  || !Number.isSafeInteger(drift.maxUnweightedFiles) || drift.maxUnweightedFiles < 0) throw new Error('Invalid CI test configuration');
export const SHARDS = config.shards;
export const MAX_FORKS = config.maxForks;
// Shard 1 also runs the native, host and smoke suites after Vitest (ci-shard.mjs); its bin starts with that measured cost
// in summed-file units: post-Vitest wall time × two-fork Vitest parallelism (derivation in ci-and-verification.md).
export const SHARD_ONE_RESERVED_MS = config.shardOneReservedMs;
export const DURATION_DRIFT = Object.freeze({ ...drift });
export function fileIdentity(path) { return path.replaceAll('\\', '/'); }
export function inventoryDigest(files) {
  return createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
}
const positive = value => Number.isFinite(value) && value > 0;
// Unknown/new files receive the observed median, and always participate in the inventory.
function fallbackWeight(durations) {
  const observed = Object.values(durations).filter(positive).sort((a, b) => a - b);
  return observed[Math.floor(observed.length / 2)] ?? 1000;
}
export function partitionTests(files, durations, count = SHARDS, shardOneReservedMs = SHARD_ONE_RESERVED_MS) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid shard count');
  const normalized = files.map(fileIdentity);
  if (!normalized.length || new Set(normalized).size !== normalized.length) throw new Error('Empty or duplicate test inventory');
  if (normalized.some(file => !/^tests\/[^\n]+\.test\.ts$/.test(file) || file.split('/').includes('..'))) throw new Error('Invalid test file identity');
  const fallback = fallbackWeight(durations);
  const weight = file => positive(durations[file]) ? durations[file] : fallback;
  const bins = Array.from({ length: count }, (_, i) => ({ files: [], durationMs: i === 0 ? shardOneReservedMs : 0 }));
  for (const file of normalized.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b, 'en'))) {
    const bin = bins.reduce((best, current) => current.durationMs < best.durationMs ? current : best);
    bin.files.push(file); bin.durationMs += weight(file);
  }
  return bins.map(bin => ({ ...bin, files: bin.files.sort() }));
}

export function validateShards(inventory, receipts, identity) {
  const expected = [...inventory].sort();
  const digest = inventoryDigest(expected);
  if (!expected.length || new Set(expected).size !== expected.length) throw new Error('Invalid expected inventory');
  if (receipts.length !== SHARDS) throw new Error('Missing or extra shard');
  const seenShards = new Set(), seenFiles = new Set();
  const totals = { passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const receipt of receipts) {
    for (const key of ['sha', 'node', 'runId', 'attempt']) if (receipt[key] !== identity[key]) throw new Error(`Shard identity mismatch: ${key}`);
    if (receipt.schemaVersion !== 1 || receipt.count !== SHARDS || receipt.inventoryDigest !== digest
      || !Number.isSafeInteger(receipt.index) || receipt.index < 1 || receipt.index > SHARDS || seenShards.has(receipt.index)) throw new Error('Invalid or duplicate shard');
    seenShards.add(receipt.index);
    if (receipt.exitCode !== 0 || receipt.runReason !== 'passed' || receipt.collectionErrors !== 0 || receipt.unhandledErrors !== 0) throw new Error('Shard execution did not pass');
    if (!Array.isArray(receipt.files) || !receipt.files.length) throw new Error('Shard files unavailable');
    for (const row of receipt.files) {
      if (!expected.includes(row.file) || seenFiles.has(row.file)) throw new Error('Missing, unexpected or duplicate file coverage');
      seenFiles.add(row.file);
      if (row.collectionErrors !== 0 || !['passed', 'skipped'].includes(row.state)) throw new Error('File did not finish');
      for (const key of Object.keys(totals)) {
        const value = row.counts?.[key];
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('File counts unavailable');
        totals[key] += value;
      }
      if (row.counts.failed || row.counts.pending || Object.values(row.counts).reduce((a, b) => a + b, 0) === 0) throw new Error('Failed, pending or uncollected tests');
    }
    if (receipt.index === 1 && (receipt.nativeExit !== 0 || receipt.hostExit !== 0 || receipt.smokeExit !== 0)) throw new Error('Support tests did not pass');
  }
  if (seenFiles.size !== expected.length || expected.some(file => !seenFiles.has(file)) || !totals.passed) throw new Error('Incomplete test coverage');
  return { inventoryDigest: digest, files: seenFiles.size, counts: totals };
}

// Per-file hosted wall time from shard receipts: the maximum across receipts, rounded up to integer ms (weight refresh and drift guard).
export function observedDurations(receipts) {
  const observed = {};
  for (const receipt of receipts) for (const row of receipt.files ?? []) {
    observed[row.file] = Math.max(observed[row.file] ?? 0, Number.isFinite(row.durationMs) ? Math.ceil(row.durationMs) : 0);
  }
  return observed;
}

// Scheduling-weight drift: a file that ran slower than maxRatio × its weight (median fallback when unweighted) at or above
// minObservedMs, or more than maxUnweightedFiles files that ran without a positive weight. All-skipped files are not drift.
export function durationDrift(inventory, observed, durations, limits = DURATION_DRIFT) {
  const fallback = fallbackWeight(durations), slow = [], unweighted = [];
  for (const file of [...inventory].sort()) {
    const observedMs = observed[file] ?? 0, weightMs = positive(durations[file]) ? durations[file] : fallback;
    if (!positive(durations[file]) && observedMs > 0) unweighted.push(file);
    if (observedMs >= limits.minObservedMs && observedMs > limits.maxRatio * weightMs) slow.push({ file, observedMs, weightMs });
  }
  return { slow, unweighted, drifted: slow.length > 0 || unweighted.length > limits.maxUnweightedFiles };
}
