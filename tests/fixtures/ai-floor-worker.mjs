// Fresh module cache for the same source evaluator used by the CLI, without a child process/build.
import { parentPort, workerData } from 'node:worker_threads';
import { loadPolicySource } from '../../scripts/ai-floor-source.mjs';
import { generateReport, checkReport, reportExitCode, root, summaryLine } from '../../scripts/ai-floor-report.mjs';

const guard = "if (resource.kind === 'secret') return true;";
const { policy, sources } = await loadPolicySource(root, (path, source) => {
  if (!workerData.removeSecretFloor || !path.endsWith('/ai-floor.ts')) return source;
  if (!source.includes(guard)) throw new Error('MUTATION_TARGET_MISSING');
  return source.replace(guard, '');
});
const report = generateReport(policy, sources);
const drift = checkReport(report, root, true);
parentPort.postMessage({ report, drift, summary: summaryLine(report) });
process.exitCode = reportExitCode(report, drift);
