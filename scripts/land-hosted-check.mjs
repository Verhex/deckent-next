// Read existing GitHub evidence for the exact revision. Never start a local full verify or cache a PASS.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const REQUIRED_CHECKS = ['required verify (ubuntu-latest, node 24)', 'required verify (ubuntu-latest, node 26)'];
// Events whose default checkout is the run's head_sha. A pull_request run checks out refs/pull/N/merge, so its
// success proves that merge commit, not the PR head; it is refused rather than accepted as exact-SHA evidence.
export const EXACT_SOURCE_EVENTS = ['push', 'workflow_dispatch', 'merge_group'];
export function validateHostedChecks(checks, sha, runs) {
  if (!Array.isArray(checks) || !Array.isArray(runs) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid hosted evidence');
  const latest = REQUIRED_CHECKS.map(name => checks.filter(check => check.name === name && check.head_sha === sha
    && check.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0]);
  latest.forEach((check, i) => {
    if (!check || check.status !== 'completed' || check.conclusion !== 'success') throw new Error(`HOSTED_CHECK_NOT_GREEN: ${REQUIRED_CHECKS[i]}`);
  });
  // Both Node results must come from one workflow run whose latest attempt passed as a whole at this SHA; inside
  // that run the collector already bound every shard receipt to GITHUB_SHA, run id and attempt.
  const suite = latest[0].check_suite?.id;
  if (!suite || latest.some(check => check.check_suite?.id !== suite)) throw new Error('HOSTED_RUN_SPLIT: Node checks come from different runs');
  const run = runs.find(candidate => candidate.check_suite_id === suite);
  if (!run || run.head_sha !== sha || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('HOSTED_RUN_NOT_GREEN');
  if (!EXACT_SOURCE_EVENTS.includes(run.event)) throw new Error(`HOSTED_SOURCE_NOT_EXACT: ${run.event} run ${run.id} tested a merge commit, not ${sha}`);
  return true;
}
export function main(args) {
  const at = args.indexOf('--ref');
  const ref = at >= 0 ? args[at + 1] : 'HEAD';
  if (!ref || args.some(arg => !['--ref', ref, '--force'].includes(arg))) throw new Error('usage: land:check [--ref <sha|HEAD>]');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { env, encoding: 'utf8' }).trim();
  const repo = JSON.parse(execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], { encoding: 'utf8' })).nameWithOwner;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid GitHub repository');
  const gh = path => JSON.parse(execFileSync('gh', ['api', path, '--paginate', '--slurp'], { encoding: 'utf8' }));
  const checks = gh(`repos/${repo}/commits/${sha}/check-runs?per_page=100`).flatMap(page => page.check_runs);
  const runs = gh(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`).flatMap(page => page.workflow_runs);
  validateHostedChecks(checks, sha, runs);
  console.log(`Hosted required checks passed for ${sha} in one exact-source run; no local full verify was run.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
