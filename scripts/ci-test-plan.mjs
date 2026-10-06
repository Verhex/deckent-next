import { createHash } from 'node:crypto';

export const SHARDS = 8;
export function fileIdentity(path) { return path.replaceAll('\\', '/'); }
export function inventoryDigest(files) {
  return createHash('sha256').update(JSON.stringify([...files].sort())).digest('hex');
}
export function partitionTests(files, durations, count = SHARDS) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid shard count');
  const normalized = files.map(fileIdentity);
  if (!normalized.length || new Set(normalized).size !== normalized.length) throw new Error('Empty or duplicate test inventory');
  if (normalized.some(file => !/^tests\/[^\n]+\.test\.ts$/.test(file) || file.split('/').includes('..'))) throw new Error('Invalid test file identity');
  // Unknown/new files receive the observed median, and always participate in the inventory.
  const observed = Object.values(durations).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const fallback = observed[Math.floor(observed.length / 2)] ?? 1000;
  const weight = file => Number.isFinite(durations[file]) && durations[file] > 0 ? durations[file] : fallback;
  const bins = Array.from({ length: count }, () => ({ files: [], durationMs: 0 }));
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
