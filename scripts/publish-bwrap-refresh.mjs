// GitHub REST publisher. A token stays in the step's environment/Authorization header, never argv, git config or logs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFRESH_PATHS, refreshBody } from './refresh-bwrap.mjs';
import { bundledIdentityModule } from './build-bwrap.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** A pin refresh may change only these lock fields; every other field must equal the base checkout, which is the authority. The candidate was
 * written by npm-installed code, so it is untrusted data: every changed value must also match a strict shape before anything is published
 * (the bundled identity module interpolates the output sha256 values into source). */
const REFRESHABLE = Object.freeze(['hostPackages', 'sysrootPackages', 'resolvedPackages', 'outputs']);
const PIN = /^[a-z0-9][a-z0-9+._-]{0,63}=[0-9][A-Za-z0-9._+~]{0,63}-r[0-9]{1,4}$/u;
const RESOLVED = /^[a-z0-9][a-z0-9+._-]{0,63}-[0-9][A-Za-z0-9._+~]{0,63}-r[0-9]{1,4}$/u;
const TITLE = /^build\(bwrap\): refresh pins \(Alpine [0-9][0-9.]{0,15}\)$/u;
const EVIDENCE = /^https:\/\/[a-z0-9.-]{1,253}\/[\w.-]{1,100}\/[\w.-]{1,100}\/actions\/runs\/[0-9]{1,20}$/u;
const invalid = reason => new Error(`BWRAP_REFRESH_INVALID: ${reason}`);
const strings = (value, shape, max, what) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every(item => typeof item === 'string' && shape.test(item))) throw invalid(`${what} has an unexpected shape`);
};
export function verifiedCandidate(root, out, title) {
  if (typeof title !== 'string' || !TITLE.test(title)) throw invalid('title has an unexpected shape');
  const read = path => { const text = readFileSync(join(out, 'files', path), 'utf8'); if (text.length > 1_048_576) throw invalid(`${path} is too large`); return text; };
  const files = Object.fromEntries(REFRESH_PATHS.map(path => [path, read(path)]));
  const lock = JSON.parse(files[REFRESH_PATHS[0]]), base = JSON.parse(readFileSync(join(root, REFRESH_PATHS[0]), 'utf8'));
  if (JSON.stringify(Object.keys(lock).sort()) !== JSON.stringify(Object.keys(base).sort())) throw invalid('candidate lock keys differ from the base');
  for (const key of Object.keys(base)) if (!REFRESHABLE.includes(key) && JSON.stringify(lock[key]) !== JSON.stringify(base[key])) throw invalid(`${key} may not change in a pin refresh`);
  strings(lock.hostPackages, PIN, 64, 'hostPackages'); strings(lock.sysrootPackages, PIN, 64, 'sysrootPackages');
  if (JSON.stringify(Object.keys(lock.resolvedPackages).sort()) !== JSON.stringify(Object.keys(base.resolvedPackages).sort())) throw invalid('resolvedPackages groups changed');
  for (const [group, list] of Object.entries(lock.resolvedPackages)) strings(list, RESOLVED, 512, `resolvedPackages.${group}`);
  if (JSON.stringify(Object.keys(lock.outputs).sort()) !== JSON.stringify(Object.keys(base.outputs).sort())) throw invalid('outputs architectures changed');
  for (const [arch, output] of Object.entries(lock.outputs)) {
    if (JSON.stringify(Object.keys(output).sort()) !== JSON.stringify(Object.keys(base.outputs[arch]).sort()) || output.nodeArch !== base.outputs[arch].nodeArch
      || typeof output.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(output.sha256)) throw invalid(`outputs.${arch} has an unexpected shape`);
  }
  if (files[REFRESH_PATHS[1]] !== bundledIdentityModule(lock)) throw invalid('bundled identity does not match the candidate lock');
  return files;
}
/** `evidenceUrl` is this workflow run's own link (runner environment), never artifact text. */
export async function publish({ root = ROOT, out, repository, base, baseSha, evidenceUrl, request }) {
  const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  if (!result.changed) return { changed: false };
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(baseSha) || !base) throw new Error('invalid repository/base identity');
  if (typeof evidenceUrl !== 'string' || !EVIDENCE.test(evidenceUrl)) throw new Error('invalid evidence run link');
  if (!/^build\/bwrap-pins-[a-f0-9]{16}$/u.test(result.branch) || JSON.stringify(result.paths) !== JSON.stringify(REFRESH_PATHS)) throw new Error('invalid refresh branch or paths');
  const candidate = verifiedCandidate(root, out, result.title); // before any request: an invalid candidate makes no call
  const api = `/repos/${repository}`;
  const headOwner = repository.split('/')[0];
  const pulls = await request('GET', `${api}/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${result.branch}`)}&base=${encodeURIComponent(base)}`);
  if (pulls.length) return { changed: true, existing: pulls[0].html_url }; // never overwrite a reviewed candidate
  const title = result.title;
  // The artifact's PR-BODY.md was written beside npm-installed code (SEC F36): the body is rebuilt from the base and the verified candidate lock.
  const body = refreshBody(JSON.parse(readFileSync(join(root, REFRESH_PATHS[0]), 'utf8')), JSON.parse(candidate[REFRESH_PATHS[0]]), evidenceUrl);
  const trees = await request('GET', `${api}/git/commits/${baseSha}`);
  const tree = await request('POST', `${api}/git/trees`, { base_tree: trees.tree.sha,
    tree: REFRESH_PATHS.map(path => ({ path, mode: '100644', type: 'blob', content: candidate[path] })) });
  const commit = await request('POST', `${api}/git/commits`, { message: title, tree: tree.sha, parents: [baseSha] });
  // Failed PR creation can leave this exact ref. Reconcile only if it names the same tree, never force-update it.
  const refPath = `${api}/git/ref/heads/${result.branch}`;
  const existing = await request('GET', refPath, undefined, true);
  if (existing) {
    const prior = await request('GET', `${api}/git/commits/${existing.object.sha}`);
    if (prior.tree.sha !== tree.sha) throw new Error('BWRAP_REFRESH_REF_CONFLICT: existing candidate differs; lead must reconcile');
  } else await request('POST', `${api}/git/refs`, { ref: `refs/heads/${result.branch}`, sha: commit.sha });
  const pr = await request('POST', `${api}/pulls`, { title, body, head: result.branch, base, draft: true });
  return { changed: true, url: pr.html_url };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const request = async (method, path, body, allowMissing = false) => {
    if (!process.env.GITHUB_TOKEN) throw new Error('missing GITHUB_TOKEN');
    const response = await fetch(`https://api.github.com${path}`, { method, signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub request failed: ${method} ${path} HTTP ${response.status}`); // no token or response body
    return response.json();
  };
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env;
  publish({ out: resolve(process.argv[2]), repository, base: process.env.BWRAP_REFRESH_BASE, evidenceUrl: `${server}/${repository}/actions/runs/${runId}`,
    baseSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), request })
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(`publish-bwrap-refresh: ${error.message}\n`); process.exitCode = 1; });
}
