// Read existing GitHub evidence for the exact revision. Never start a local full verify or cache a PASS.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const REQUIRED_CHECKS = ['required verify (ubuntu-latest, node 24)', 'required verify (ubuntu-latest, node 26)'];
export function validateHostedChecks(checks, sha) {
  if (!Array.isArray(checks) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid hosted evidence');
  for (const name of REQUIRED_CHECKS) {
    const matching = checks.filter(check => check.name === name && check.head_sha === sha && check.app?.slug === 'github-actions')
      .sort((a, b) => b.id - a.id);
    const latest = matching[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error(`HOSTED_CHECK_NOT_GREEN: ${name}`);
  }
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
  const pages = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' }));
  validateHostedChecks(pages.flatMap(page => page.check_runs), sha);
  console.log(`Hosted required checks passed for ${sha}; no local full verify was run.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
