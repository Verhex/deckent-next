// GitHub REST publisher. A token stays in the step's environment/Authorization header, never argv, git config or logs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFRESH_PATHS } from './refresh-bwrap.mjs';
import { bundledIdentityModule } from './build-bwrap.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Fields a pin refresh may never change: the base checkout is the authority, the candidate (built by npm-installed code) is only data. */
const INVARIANT = ['schemaVersion', 'component', 'version', 'license', 'licenseNote', 'source', 'sourceDateEpoch', 'buildImage', 'mesonOptions', 'minimumKernel', 'linked', 'setuid', 'shipArches'];
export function verifiedCandidate(root, out) {
  const read = path => readFileSync(join(out, 'files', path), 'utf8');
  const files = Object.fromEntries(REFRESH_PATHS.map(path => [path, read(path)]));
  const lock = JSON.parse(files[REFRESH_PATHS[0]]), base = JSON.parse(readFileSync(join(root, REFRESH_PATHS[0]), 'utf8'));
  if (JSON.stringify(Object.keys(lock).sort()) !== JSON.stringify(Object.keys(base).sort())) throw new Error('BWRAP_REFRESH_INVALID: candidate lock keys differ from the base');
  for (const key of INVARIANT) if (JSON.stringify(lock[key]) !== JSON.stringify(base[key])) throw new Error(`BWRAP_REFRESH_INVALID: ${key} may not change in a pin refresh`);
  if (files[REFRESH_PATHS[1]] !== bundledIdentityModule(lock)) throw new Error('BWRAP_REFRESH_INVALID: bundled identity does not match the candidate lock');
  return files;
}
export async function publish({ root = ROOT, out, repository, base, baseSha, request }) {
  const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
  if (!result.changed) return { changed: false };
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[a-f0-9]{40}$/u.test(baseSha) || !base) throw new Error('invalid repository/base identity');
  if (!/^build\/bwrap-pins-[a-f0-9]{16}$/u.test(result.branch) || JSON.stringify(result.paths) !== JSON.stringify(REFRESH_PATHS)) throw new Error('invalid refresh branch or paths');
  const candidate = verifiedCandidate(root, out); // before any request: an invalid candidate makes no call
  const api = `/repos/${repository}`;
  const headOwner = repository.split('/')[0];
  const pulls = await request('GET', `${api}/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${result.branch}`)}&base=${encodeURIComponent(base)}`);
  if (pulls.length) return { changed: true, existing: pulls[0].html_url }; // never overwrite a reviewed candidate
  const title = result.title;
  const body = readFileSync(join(out, 'PR-BODY.md'), 'utf8');
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
  publish({ out: resolve(process.argv[2]), repository: process.env.GITHUB_REPOSITORY, base: process.env.BWRAP_REFRESH_BASE,
    baseSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), request })
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(`publish-bwrap-refresh: ${error.message}\n`); process.exitCode = 1; });
}
